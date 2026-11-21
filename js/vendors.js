import { VENDOR_CONFIG, state } from './state.js';
import { logLine } from './dom.js';

export const loadedScriptPromises = new Map();

      export function loadScriptClassic(url, sri = '') {
        return new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = url;
          s.async = true;
          if (sri) {
            s.integrity = sri;
            s.crossOrigin = 'anonymous';
          }
          s.onload = () => resolve(url);
          s.onerror = () => {
            s.remove();
            reject(new Error(`Script load failed: ${url}`));
          };
          document.head.appendChild(s);
        });
      }

      export async function ensureDependency(key, globalCheck) {
        if (globalCheck()) return true;
        if (loadedScriptPromises.has(key)) return loadedScriptPromises.get(key);

        const cfg = VENDOR_CONFIG[key];
        const p = (async () => {
          try {
            await loadScriptClassic(cfg.local, '');
            if (globalCheck()) {
              logLine(`Loaded local dependency: ${cfg.local}`);
              return true;
            }
          } catch (_) {
            // Fall through to pinned CDN mirrors
          }

          for (const entry of cfg.cdns) {
            try {
              await loadScriptClassic(entry.url, entry.sri || '');
              if (globalCheck()) {
                logLine(`Loaded pinned CDN dependency: ${entry.url}`);
                return true;
              }
            } catch (err) {
              if (entry.sri) {
                try {
                  await loadScriptClassic(entry.url, '');
                  if (globalCheck()) {
                    logLine(`Loaded pinned CDN dependency (fallback): ${entry.url}`);
                    return true;
                  }
                } catch (_) {}
              }
              logLine(`CDN fallback: ${err.message}`);
            }
          }
          return false;
        })();

        loadedScriptPromises.set(key, p);
        return p;
      }

      export async function fetchLocalOrCdnBlobUrl(localPath, cdnUrls, mime) {
        try {
          const localResp = await fetch(localPath);
          if (localResp.ok) {
            const buf = await localResp.arrayBuffer();
            logLine(`Loaded local asset: ${localPath}`);
            return URL.createObjectURL(new Blob([buf], { type: mime }));
          }
        } catch (_) {}

        let lastErr = null;
        for (const url of cdnUrls) {
          try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
            const buf = await resp.arrayBuffer();
            return URL.createObjectURL(new Blob([buf], { type: mime }));
          } catch (err) {
            lastErr = err;
            logLine(`Asset mirror fallback: ${err.message}`);
          }
        }
        throw lastErr || new Error(`Failed to fetch ${localPath}`);
      }

      // Clean Worker URL-wrapper shim (NO eval, NO new Function, NO source rewriting)
      const NativeWorker = window.Worker;
      window.Worker = function PatchedFFmpegWorker(scriptURL, options) {
        const urlStr = typeof scriptURL === 'string' ? scriptURL : scriptURL && scriptURL.href ? scriptURL.href : String(scriptURL);
        if (urlStr.includes('814.ffmpeg.js') && window.__FFMPEG_WORKER_BLOB__) {
          return new NativeWorker(window.__FFMPEG_WORKER_BLOB__, options);
        }
        return new NativeWorker(scriptURL, options);
      };
      window.Worker.prototype = NativeWorker.prototype;

      export async function getFFmpeg(onStatus) {
        if (state.ffmpegLoaded && state.ffmpeg) return state.ffmpeg;
        if (state.ffmpegLoadingPromise) return state.ffmpegLoadingPromise;

        state.ffmpegLoadingPromise = (async () => {
          try {
            if (onStatus) onStatus('Loading local/pinned FFmpeg wrapper...', 10);

            if (!window.__FFMPEG_WORKER_BLOB__) {
              window.__FFMPEG_WORKER_BLOB__ = await fetchLocalOrCdnBlobUrl(
                VENDOR_CONFIG.ffmpegWorker.local,
                VENDOR_CONFIG.ffmpegWorker.cdns,
                'text/javascript'
              );
            }

            await ensureDependency('ffmpegUtil', () => Boolean(window.FFmpegUtil));
            const okWrapper = await ensureDependency('ffmpegJs', () => Boolean(window.FFmpegWASM && window.FFmpegWASM.FFmpeg));
            if (!okWrapper) throw new Error('Unable to load @ffmpeg/ffmpeg wrapper.');

            const { FFmpeg } = window.FFmpegWASM;
            const ffmpeg = new FFmpeg();
            ffmpeg.on('log', ({ message }) => {
              if (message) logLine(`[ffmpeg] ${message}`);
            });

            if (onStatus) onStatus('Fetching FFmpeg WASM core (~31 MB)...', 35);
            const coreURL = await fetchLocalOrCdnBlobUrl(
              VENDOR_CONFIG.ffmpegCoreJs.local,
              VENDOR_CONFIG.ffmpegCoreJs.cdns,
              'text/javascript'
            );

            if (onStatus) onStatus('Compiling WebAssembly binary...', 70);
            const wasmURL = await fetchLocalOrCdnBlobUrl(
              VENDOR_CONFIG.ffmpegCoreWasm.local,
              VENDOR_CONFIG.ffmpegCoreWasm.cdns,
              'application/wasm'
            );

            if (onStatus) onStatus('Initializing local FFmpeg engine...', 90);
            await Promise.race([
              ffmpeg.load({
                coreURL,
                wasmURL,
                classWorkerURL: window.__FFMPEG_WORKER_BLOB__,
              }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('FFmpeg initialization timed out after 60s')), 60000)
              ),
            ]);

            state.ffmpeg = ffmpeg;
            state.ffmpegLoaded = true;
            if (onStatus) onStatus('FFmpeg engine ready', 100);
            logLine('FFmpeg WASM engine initialized via classic <script> + same origin blob worker.');
            return ffmpeg;
          } catch (err) {
            state.ffmpeg = null;
            state.ffmpegLoaded = false;
            state.ffmpegLoadingPromise = null;
            throw err;
          }
        })();

        return state.ffmpegLoadingPromise;
      }

      export async function safeDelete(ffmpeg, name) {
        if (!ffmpeg || !name) return;
        try {
          await ffmpeg.deleteFile(name);
        } catch (_) {}
      }

      export async function ensurePdfLib() {
        if (window.PDFLib) return window.PDFLib;
        const ok = await ensureDependency('pdfLib', () => Boolean(window.PDFLib));
        if (!ok && !window.PDFLib) {
          throw new Error('Unable to load pdf-lib from local vendor or CDN.');
        }
        return window.PDFLib;
      }

      export async function ensureUpscaler() {
        if (window.Upscaler) return window.Upscaler;
        try {
          await ensureDependency('upscaler', () => Boolean(window.Upscaler));
          if (!window.Upscaler) {
            await loadScriptClassic('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js');
            await loadScriptClassic('https://cdn.jsdelivr.net/npm/upscaler@0.14.0/dist/browser/umd/upscaler.min.js');
          }
        } catch (err) {
          logLine(`AI Upscaler load notice: ${err.message}`);
        }
        return window.Upscaler || null;
      }




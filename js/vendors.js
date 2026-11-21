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

/**
 * Safely loads a script. For local paths, checks response status and MIME type
 * before injecting to eliminate browser "Refused to execute script ... MIME type ('text/html')" errors.
 */
export async function loadScriptSafe(url, sri = '') {
  const isLocal = url.startsWith('./') || url.startsWith('/') || !url.startsWith('http');
  if (isLocal) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) {
      throw new Error(`Server returned HTML for script path: ${url}`);
    }
    const code = await resp.text();
    const trimmed = code.trimStart();
    if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<?xml')) {
      throw new Error(`Server returned HTML body for script: ${url}`);
    }
    const blob = new Blob([code], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      await loadScriptClassic(blobUrl, '');
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    return url;
  }
  return loadScriptClassic(url, sri);
}

export async function ensureDependency(key, globalCheck) {
  if (globalCheck()) return true;
  if (loadedScriptPromises.has(key)) return loadedScriptPromises.get(key);

  const cfg = VENDOR_CONFIG[key];
  if (!cfg) return false;

  const p = (async () => {
    // 1. Try local vendor file first
    if (cfg.local) {
      try {
        await loadScriptSafe(cfg.local, '');
        if (globalCheck()) {
          logLine(`Loaded local dependency: ${cfg.local}`);
          return true;
        }
      } catch (_) {
        // Fall through cleanly to CDN mirrors without console MIME spam
      }
    }

    // 2. Fall back to pinned CDN distributions
    if (Array.isArray(cfg.cdns)) {
      for (const entry of cfg.cdns) {
        const url = typeof entry === 'string' ? entry : (entry && entry.url ? entry.url : '');
        const sri = (typeof entry === 'object' && entry && entry.sri) || '';
        if (!url) continue;
        try {
          await loadScriptSafe(url, sri);
          if (globalCheck()) {
            logLine(`Loaded pinned CDN dependency: ${url}`);
            return true;
          }
        } catch (err) {
          if (sri) {
            try {
              await loadScriptSafe(url, '');
              if (globalCheck()) {
                logLine(`Loaded pinned CDN dependency (fallback): ${url}`);
                return true;
              }
            } catch (_) {}
          }
          const errStr = (err && (err.message || String(err))) || 'Load failed';
          logLine(`CDN fallback: ${errStr}`);
        }
      }
    }
    return false;
  })();

  loadedScriptPromises.set(key, p);
  return p;
}

/**
 * Converts a local or CDN URL to a same-origin Blob URL, using FFmpegUtil.toBlobURL
 * when available and verifying that responses are not 404 HTML documents.
 */
export async function toBlobURLWithFallback(localUrl, cdns, mimeType) {
  if (localUrl) {
    try {
      const resp = await fetch(localUrl);
      if (resp.ok) {
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('text/html')) {
          const buf = await resp.arrayBuffer();
          if (buf.byteLength >= 9) {
            const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 15))).trimStart().toLowerCase();
            if (head.startsWith('<!doctype') || head.startsWith('<html')) {
              throw new Error(`Server returned HTML for asset: ${localUrl}`);
            }
          }
          logLine(`Loaded local asset: ${localUrl}`);
          return URL.createObjectURL(new Blob([buf], { type: mimeType }));
        }
      }
    } catch (_) {
      // Fall through to CDN mirrors
    }
  }

  const cdnList = Array.isArray(cdns) ? cdns : [cdns];
  let lastErr = null;
  for (const entry of cdnList) {
    const url = typeof entry === 'string' ? entry : (entry && entry.url ? entry.url : '');
    if (!url) continue;
    try {
      if (window.FFmpegUtil && typeof window.FFmpegUtil.toBlobURL === 'function') {
        const blobUrl = await window.FFmpegUtil.toBlobURL(url, mimeType);
        logLine(`Loaded CDN asset via toBlobURL: ${url}`);
        return blobUrl;
      }
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      const buf = await resp.arrayBuffer();
      logLine(`Loaded CDN asset: ${url}`);
      return URL.createObjectURL(new Blob([buf], { type: mimeType }));
    } catch (err) {
      lastErr = err;
      const errStr = (err && (err.message || String(err))) || 'Fetch failed';
      logLine(`Asset mirror fallback: ${errStr}`);
    }
  }
  throw lastErr || new Error(`Failed to load asset for ${localUrl}`);
}

export const fetchLocalOrCdnBlobUrl = toBlobURLWithFallback;

// Clean Worker URL-wrapper shim (NO eval, NO new Function, NO source rewriting)
const NativeWorker = window.Worker;
window.Worker = function PatchedFFmpegWorker(scriptURL, options) {
  const urlStr = typeof scriptURL === 'string' ? scriptURL : scriptURL && scriptURL.href ? scriptURL.href : String(scriptURL);
  const isFFmpegWorker = urlStr.includes('814.ffmpeg.js') || (window.__FFMPEG_WORKER_BLOB__ && urlStr === window.__FFMPEG_WORKER_BLOB__);
  if (isFFmpegWorker && window.__FFMPEG_WORKER_BLOB__) {
    // 814.ffmpeg.js is a classic UMD worker that uses importScripts; must NOT be type: 'module'
    const cleanOptions = options ? { ...options } : {};
    delete cleanOptions.type;
    return new NativeWorker(window.__FFMPEG_WORKER_BLOB__, cleanOptions);
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

      // 1. Load @ffmpeg/util UMD wrapper first (provides FFmpegUtil.toBlobURL)
      await ensureDependency('ffmpegUtil', () => Boolean(window.FFmpegUtil));

      // 2. Load @ffmpeg/ffmpeg UMD wrapper (provides window.FFmpegWASM.FFmpeg)
      const okWrapper = await ensureDependency('ffmpegJs', () => Boolean(window.FFmpegWASM && window.FFmpegWASM.FFmpeg));
      if (!okWrapper) throw new Error('Unable to load @ffmpeg/ffmpeg wrapper.');

      // 3. Prepare classic Worker blob (814.ffmpeg.js)
      if (!window.__FFMPEG_WORKER_BLOB__) {
        window.__FFMPEG_WORKER_BLOB__ = await toBlobURLWithFallback(
          VENDOR_CONFIG.ffmpegWorker.local,
          VENDOR_CONFIG.ffmpegWorker.cdns,
          'text/javascript'
        );
      }

      const { FFmpeg } = window.FFmpegWASM;
      const ffmpeg = new FFmpeg();
      ffmpeg.on('log', ({ message }) => {
        if (message) logLine(`[ffmpeg] ${message}`);
      });

      // 4. Convert coreURL and wasmURL via toBlobURL
      if (onStatus) onStatus('Fetching FFmpeg WASM core (~31 MB)...', 35);
      const coreURL = await toBlobURLWithFallback(
        VENDOR_CONFIG.ffmpegCoreJs.local,
        VENDOR_CONFIG.ffmpegCoreJs.cdns,
        'text/javascript'
      );

      if (onStatus) onStatus('Compiling WebAssembly binary...', 70);
      const wasmURL = await toBlobURLWithFallback(
        VENDOR_CONFIG.ffmpegCoreWasm.local,
        VENDOR_CONFIG.ffmpegCoreWasm.cdns,
        'application/wasm'
      );

      if (onStatus) onStatus('Initializing local FFmpeg engine...', 90);
      await Promise.race([
        ffmpeg.load({
          coreURL,
          wasmURL,
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
      const errStr = (err && (err.message || (typeof err === 'object' ? (err.error?.message || JSON.stringify(err)) : String(err)))) || 'Unknown initialization error';
      logLine(`[ffmpeg] Load failed: ${errStr}`);
      state.ffmpeg = null;
      state.ffmpegLoaded = false;
      state.ffmpegLoadingPromise = null;
      throw (err instanceof Error) ? err : new Error(errStr);
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
    const errStr = (err && (err.message || String(err))) || 'Unavailable';
    logLine(`AI Upscaler load notice: ${errStr}`);
  }
  return window.Upscaler || null;
}

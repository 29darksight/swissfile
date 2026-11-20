import { state, SVG_VIDEO, SVG_AUDIO, SVG_PHOTO, SVG_BROKEN, SVG_BINARY, SVG_LOCK, SVG_DOC, uid, nextId } from './state.js';
import { ensureDependency } from './vendors.js';

export { SVG_VIDEO, SVG_AUDIO, SVG_PHOTO, SVG_BROKEN, SVG_BINARY, SVG_LOCK, SVG_DOC, uid, nextId } from './state.js';
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      export function logLine(msg) {
        const ts = new Date().toISOString().slice(11, 19);
        state.logs.push(`[${ts}] ${msg}`);
        if (state.logs.length > 800) state.logs.shift();
        const out = document.getElementById('consoleOutput');
        if (out) {
          out.textContent = state.logs.join('\n');
          out.scrollTop = out.scrollHeight;
        }
      }

      export function showToast(message, tone = 'info') {
        const stack = document.getElementById('toastStack');
        const el = document.createElement('div');
        const cls =
          tone === 'error'
            ? 'badge-rose'
            : tone === 'warn'
            ? 'badge-amber'
            : tone === 'success'
            ? 'badge-teal'
            : 'badge-blue';
        el.className = `font-mono-tech ${cls}`;
        el.style.cssText = 'pointer-events:auto;padding:0.65rem 0.875rem;border-width:2px;font-size:0.75rem;box-shadow:0 8px 24px rgba(0,0,0,0.6);';
        el.textContent = message;
        stack.appendChild(el);
        setTimeout(() => {
          el.style.opacity = '0';
          el.style.transition = 'opacity 220ms ease';
          setTimeout(() => el.remove(), 240);
        }, 3800);
      }

      export function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
      }

      export function baseName(filename) {
        const idx = filename.lastIndexOf('.');
        return idx > 0 ? filename.slice(0, idx) : filename;
      }

      export function extOf(filename) {
        const parts = filename.toLowerCase().split('.');
        return parts.length > 1 ? parts.pop() : '';
      }

      export function checkFileSizeGuardrail(file, allowLargeStreaming = false) {
        if (allowLargeStreaming) return true;
        const maxBytes = state.limits.maxFileMb * 1024 * 1024;
        if (file.size > maxBytes) {
          showToast(`Skipped ${file.name} (${formatBytes(file.size)} > ${state.limits.maxFileMb} MB guardrail). Raise limit in header if needed.`, 'warn');
          logLine(`Guardrail skipped ${file.name}: ${formatBytes(file.size)} exceeds ${state.limits.maxFileMb} MB limit.`);
          return false;
        }
        return true;
      }

      export function copyToClipboard(text, label = 'Value') {
        if (!text || text === 'None' || text === '...') return;
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          showToast(`${label} copied`, 'success');
        } catch (err) {
          showToast(`Copy failed: ${err.message}`, 'error');
        }
      }

      export function buildSegmentedTrack(id, count = 20) {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = '';
        for (let i = 0; i < count; i++) {
          const cell = document.createElement('div');
          cell.className = 'seg-cell';
          el.appendChild(cell);
        }
      }

      export function setSegmentedProgress(id, pct, mode = 'blue') {
        const el = document.getElementById(id);
        if (!el) return;
        const cells = Array.from(el.children);
        const clamped = Math.max(0, Math.min(100, pct));
        const activeCount = clamped === 0 ? 0 : Math.max(1, Math.round((clamped / 100) * cells.length));
        const fillClass = mode === 'teal' ? 'teal-filled' : mode === 'amber' ? 'amber-filled' : 'filled';
        cells.forEach((cell, idx) => {
          cell.classList.remove('filled', 'teal-filled', 'amber-filled');
          if (idx < activeCount) cell.classList.add(fillClass);
        });
      }

      export function isImageFile(file) {
        if (file.type && file.type.startsWith('image/')) return true;
        return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff'].includes(extOf(file.name));
      }

      export function isVideoFile(file) {
        if (file.type && file.type.startsWith('video/')) return true;
        return ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'flv', 'wmv', 'ts'].includes(extOf(file.name));
      }

export function isAudioFile(file) {
        if (file.type && file.type.startsWith('audio/')) return true;
        return ['flac', 'wav', 'm4a', 'alac', 'aac', 'mp3', 'ogg', 'opus', 'aiff', 'aif', 'wma'].includes(extOf(file.name));
      }

export function getFallbackSvg(kind) {
        if (kind === 'video') return SVG_VIDEO;
        if (kind === 'audio') return SVG_AUDIO;
        if (kind === 'photo') return SVG_PHOTO;
        if (kind === 'doc' || kind === 'pdf') return SVG_DOC;
        if (kind === 'broken') return SVG_BROKEN;
        if (kind === 'lock') return SVG_LOCK;
        return SVG_BINARY;
      }

      export function renderThumbMarkup(thumbUrl, fallbackKind) {
        const svg = getFallbackSvg(fallbackKind);
        if (thumbUrl) {
          return `<div class="file-thumb"><img src="${thumbUrl}" alt="" onerror="this.parentNode.innerHTML=decodeURIComponent('${encodeURIComponent(svg)}')" /></div>`;
        }
        return `<div class="file-thumb">${svg}</div>`;
      }

      export function probeVideoAndThumb(file) {
        return new Promise((resolve) => {
          const tempUrl = URL.createObjectURL(file);
          const video = document.createElement('video');
          let done = false;

          const finish = (res) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            video.pause();
            video.removeAttribute('src');
            video.load();
            URL.revokeObjectURL(tempUrl);
            resolve(res);
          };

          const timer = setTimeout(() => {
            finish({ ok: false, thumbUrl: null, width: 0, height: 0, duration: 0, reason: 'Metadata decode timed out' });
          }, 3200);

          video.muted = true;
          video.playsInline = true;
          video.preload = 'metadata';

          video.addEventListener('loadeddata', () => {
            const w = video.videoWidth || 0;
            const h = video.videoHeight || 0;
            const d = Number.isFinite(video.duration) ? video.duration : 0;
            if (w === 0 || h === 0 || d <= 0) {
              finish({ ok: false, thumbUrl: null, width: w, height: h, duration: d, reason: 'Missing video track or invalid duration (moov atom issue)' });
              return;
            }
            const targetTime = d > 0.25 ? 0.2 : 0;
            try {
              video.currentTime = targetTime;
            } catch (_) {
              finish({ ok: true, thumbUrl: null, width: w, height: h, duration: d, reason: '' });
            }
          });

          video.addEventListener('seeked', () => {
            const w = video.videoWidth || 0;
            const h = video.videoHeight || 0;
            const d = Number.isFinite(video.duration) ? video.duration : 0;
            try {
              const size = 80;
              const c = document.createElement('canvas');
              c.width = size;
              c.height = size;
              const ctx = c.getContext('2d');
              const side = Math.min(w, h);
              ctx.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
              c.toBlob((blob) => {
                finish({ ok: true, thumbUrl: blob ? URL.createObjectURL(blob) : null, width: w, height: h, duration: d, reason: '' });
              }, 'image/jpeg', 0.82);
            } catch (_) {
              finish({ ok: true, thumbUrl: null, width: w, height: h, duration: d, reason: '' });
            }
          });

          video.addEventListener('error', () => {
            finish({ ok: false, thumbUrl: null, width: 0, height: 0, duration: 0, reason: 'Browser video decoder rejected container/header' });
          });

          video.src = tempUrl;
        });
      }

      export function probeAudioMetadata(file) {
        return new Promise((resolve) => {
          const tempUrl = URL.createObjectURL(file);
          const audio = document.createElement('audio');
          let done = false;

          const finish = (res) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            URL.revokeObjectURL(tempUrl);
            resolve(res);
          };

          const timer = setTimeout(() => {
            finish({ ok: false, duration: 0, reason: 'Audio metadata timed out' });
          }, 2800);

          audio.preload = 'metadata';
          audio.addEventListener('loadedmetadata', () => {
            const d = Number.isFinite(audio.duration) ? audio.duration : 0;
            if (d <= 0) finish({ ok: false, duration: 0, reason: 'Invalid or zero audio duration' });
            else finish({ ok: true, duration: d, reason: '' });
          });
          audio.addEventListener('error', () => {
            finish({ ok: false, duration: 0, reason: 'Browser audio decoder rejected header/stream' });
          });
          audio.src = tempUrl;
        });
      }


export function wireDropzone(zoneId, inputId, onFiles, multiple = true) {
        const zone = document.getElementById(zoneId);
        const input = document.getElementById(inputId);
        if (!zone || !input) return;

        zone.addEventListener('click', () => input.click());
        zone.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            input.click();
          }
        });

        input.addEventListener('click', () => {
          input.value = '';
        });

        input.addEventListener('change', () => {
          if (input.files && input.files.length > 0) {
            const list = multiple ? Array.from(input.files) : [input.files[0]];
            onFiles(list);
            input.value = '';
          }
        });

        ['dragenter', 'dragover'].forEach((ev) => {
          zone.addEventListener(ev, (e) => {
            e.preventDefault();
            e.stopPropagation();
            zone.classList.add('drag-active');
          });
        });

        ['dragleave', 'drop'].forEach((ev) => {
          zone.addEventListener(ev, (e) => {
            e.preventDefault();
            e.stopPropagation();
            zone.classList.remove('drag-active');
          });
        });

        zone.addEventListener('drop', (e) => {
          input.value = '';
          const files = e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
          if (files.length > 0) {
            onFiles(multiple ? files : [files[0]]);
          }
        });
      }

// Shared bundle export eliminating duplicate download zip routines across tabs
export async function exportZipBundle(items, defaultBaseName, stateRef = null, urlKey = 'zipUrl') {
  const ready = items.filter(
    (x) => x.outBlob && (x.status === 'done' || ['container-repaired', 'stream-remuxed', 're-encoded', 'partial-recovery'].includes(x.repairStatus))
  );
  if (!ready.length) return;

  const ok = await ensureDependency('jszip', () => Boolean(window.JSZip));
  if (!ok) return showToast('Failed to load JSZip library', 'error');

  const zip = new window.JSZip();
  ready.forEach((it) => zip.file(it.outName || it.name, it.outBlob));
  const blob = await zip.generateAsync({ type: 'blob' });

  if (stateRef && stateRef[urlKey]) URL.revokeObjectURL(stateRef[urlKey]);
  const url = URL.createObjectURL(blob);
  if (stateRef) stateRef[urlKey] = url;

  const a = document.createElement('a');
  a.href = url;
  a.download = `${defaultBaseName}_${Date.now()}.zip`;
  a.click();
}


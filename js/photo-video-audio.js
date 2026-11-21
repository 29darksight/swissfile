import { state, uid, nextId, VIDEO_MIMES, AUDIO_MIMES } from './state.js';
import {
  $, $$, escapeHtml, formatBytes, baseName, extOf, checkFileSizeGuardrail,
  showToast, logLine, setSegmentedProgress, isImageFile, isVideoFile,
  isAudioFile, renderThumbMarkup, probeVideoAndThumb, probeAudioMetadata,
  exportZipBundle
} from './dom.js';
import { ensureDependency, getFFmpeg, safeDelete } from './vendors.js';
import { detectAnimatedGif, detectMagicSignature } from './binary.js';

export function computeTargetDims(origW, origH, resizeSpec) {
        const [kind, rawVal] = resizeSpec.split(':');
        const val = Number(rawVal);
        if (kind === 'scale') {
          const factor = Number.isFinite(val) && val > 0 ? val : 1;
          return {
            width: Math.max(1, Math.round(origW * factor)),
            height: Math.max(1, Math.round(origH * factor)),
          };
        }
        if (kind === 'width' && Number.isFinite(val) && val > 0 && origW > val) {
          const ratio = val / origW;
          return { width: val, height: Math.max(1, Math.round(origH * ratio)) };
        }
        return { width: origW, height: origH };
      }

      export function canvasToBlobAsync(canvas, mime, quality) {
        return new Promise((resolve, reject) => {
          const qArg = mime === 'image/png' ? undefined : quality;
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Canvas encoding produced empty output'));
          }, mime, qArg);
        });
      }

      export function decodeImageSource(blobOrFile) {
        return new Promise((resolve, reject) => {
          const url = URL.createObjectURL(blobOrFile);
          const img = new Image();
          img.onload = () => {
            const w = img.naturalWidth || img.width;
            const h = img.naturalHeight || img.height;
            if (w > 0 && h > 0) {
              resolve({ source: img, width: w, height: h, cleanup: () => URL.revokeObjectURL(url) });
            } else {
              URL.revokeObjectURL(url);
              reject(new Error('Decoded image has 0×0 dimensions'));
            }
          };
          img.onerror = async () => {
            URL.revokeObjectURL(url);
            try {
              const bmp = await createImageBitmap(blobOrFile);
              resolve({ source: bmp, width: bmp.width, height: bmp.height, cleanup: () => { if (bmp.close) bmp.close(); } });
            } catch (_) {
              reject(new Error('Browser image decoder failed on stream'));
            }
          };
          img.src = url;
        });
      }

      export async function processPhotoBlob(blobOrFile, mime, sliderPct, resizeSpec, maxKb) {
        const decoded = await decodeImageSource(blobOrFile);
        try {
          const maxDim = state.limits.maxImgDim;
          if (decoded.width > maxDim || decoded.height > maxDim) {
            throw new Error(`Image ${decoded.width}×${decoded.height} exceeds ${maxDim}px dimension guardrail`);
          }

          const { width, height } = computeTargetDims(decoded.width, decoded.height, resizeSpec);
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');

          if (mime === 'image/jpeg') {
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, width, height);
          }
          ctx.drawImage(decoded.source, 0, 0, width, height);

          const baseQuality = Math.max(0.1, Math.min(1.0, sliderPct / 100));

          if (Number.isFinite(maxKb) && maxKb > 0 && mime !== 'image/png') {
            const targetBytes = maxKb * 1024;
            let low = 0.05;
            let high = baseQuality;
            let bestBlob = await canvasToBlobAsync(canvas, mime, high);

            if (bestBlob.size > targetBytes) {
              for (let iter = 0; iter < 9; iter++) {
                const mid = (low + high) / 2;
                const cand = await canvasToBlobAsync(canvas, mime, mid);
                if (cand.size <= targetBytes) {
                  bestBlob = cand;
                  low = mid;
                } else {
                  high = mid;
                }
              }
              if (bestBlob.size > targetBytes) {
                bestBlob = await canvasToBlobAsync(canvas, mime, low);
              }
            }
            return { blob: bestBlob, width, height };
          }

          const blob = await canvasToBlobAsync(canvas, mime, baseQuality);
          return { blob, width, height };
        } finally {
          decoded.cleanup();
        }
      }


export function switchConvertSub(subId) {
        state.convertSub = subId;
        document.querySelectorAll('.conv-sub-btn').forEach((btn) => {
          const active = btn.dataset.convertSub === subId;
          btn.classList.toggle('px-btn-primary', active);
          if (!active) btn.style.color = 'var(--text-muted)';
          else btn.style.color = '';
        });
        document.querySelectorAll('.conv-view').forEach((view) => {
          view.classList.toggle('hidden', view.id !== `conv-view-${subId}`);
        });
      }

export function routeConvertFiles(files, preferredSub) {
        const photos = [];
        const videos = [];
        const audios = [];

        for (const f of files) {
          if (preferredSub === 'audio' && (isAudioFile(f) || isVideoFile(f))) {
            audios.push(f);
          } else if (isImageFile(f)) {
            photos.push(f);
          } else if (isVideoFile(f)) {
            videos.push(f);
          } else if (isAudioFile(f)) {
            audios.push(f);
          } else {
            showToast(`Unsupported media type: ${f.name}`, 'warn');
          }
        }

        if (photos.length > 0) addPhotoFiles(photos);
        if (videos.length > 0) addVideoFiles(videos);
        if (audios.length > 0) addAudioFiles(audios);

        if (preferredSub === 'photo' && photos.length === 0) {
          if (videos.length > 0) { switchConvertSub('video'); showToast('Switched to Video mode', 'info'); }
          else if (audios.length > 0) { switchConvertSub('audio'); showToast('Switched to Audio mode', 'info'); }
        } else if (preferredSub === 'video' && videos.length === 0) {
          if (photos.length > 0) { switchConvertSub('photo'); showToast('Switched to Photo mode', 'info'); }
          else if (audios.length > 0) { switchConvertSub('audio'); showToast('Switched to Audio mode', 'info'); }
        } else if (preferredSub === 'audio' && audios.length === 0) {
          if (photos.length > 0) { switchConvertSub('photo'); showToast('Switched to Photo mode', 'info'); }
        }
      }


export async function addPhotoFiles(files) {
        for (const file of files) {
          if (!checkFileSizeGuardrail(file, false)) continue;

          const head16 = new Uint8Array(await file.slice(0, 16).arrayBuffer());
          const sig = detectMagicSignature(head16);
          if (sig.id === 'heic' || sig.id === 'tiff') {
            showToast(`${file.name}: ${sig.label} is not natively supported by standard browser Canvas decoders.`, 'warn');
            logLine(`Unsupported browser image format: ${file.name} (${sig.label})`);
            continue;
          }

          const isAnimGif = await detectAnimatedGif(file);
          if (isAnimGif) {
            showToast(`${file.name}: Animated GIF detected. Canvas will flatten to frame 1. Use Video mode to keep animation.`, 'warn');
          }

          const item = {
            id: nextId(),
            file,
            thumbUrl: URL.createObjectURL(file),
            dims: isAnimGif ? 'Animated GIF (Frame 1 only)' : '',
            status: 'queued',
            outBlob: null,
            outUrl: null,
            outName: '',
            error: '',
          };
          state.photo.items.push(item);

          createImageBitmap(file)
            .then((bmp) => {
              item.dims = `${bmp.width}×${bmp.height}${isAnimGif ? ' · Animated GIF (flattens to Frame 1)' : ''}`;
              if (bmp.close) bmp.close();
              renderPhotoQueue();
            })
            .catch(() => {
              item.dims = 'Unreadable image, try Repair tab';
              renderPhotoQueue();
            });
        }
        renderPhotoQueue();
      }

      export function removePhotoItem(id) {
        const idx = state.photo.items.findIndex((x) => x.id === id);
        if (idx === -1) return;
        const [rm] = state.photo.items.splice(idx, 1);
        if (rm.thumbUrl) URL.revokeObjectURL(rm.thumbUrl);
        if (rm.outUrl) URL.revokeObjectURL(rm.outUrl);
        renderPhotoQueue();
      }

      export function clearPhotoQueue() {
        state.photo.items.forEach((it) => {
          if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
          if (it.outUrl) URL.revokeObjectURL(it.outUrl);
        });
        if (state.photo.zipUrl) { URL.revokeObjectURL(state.photo.zipUrl); state.photo.zipUrl = null; }
        state.photo.items = [];
        document.getElementById('photoProgressBox').classList.add('hidden');
        document.getElementById('photoDeltaSummary').textContent = '';
        renderPhotoQueue();
      }

      export function renderPhotoQueue() {
        const listEl = document.getElementById('photoQueueList');
        const doneCount = state.photo.items.filter((x) => x.status === 'done' && x.outBlob).length;

        document.getElementById('photoQueueCount').textContent =
          `Supported: PNG, JPEG, WebP, BMP, static GIF, browser supported AVIF · ${state.photo.items.length} queued`;
        document.getElementById('photoRunBtn').disabled = state.busy.photo || state.photo.items.length === 0;
        document.getElementById('photoCancelBtn').classList.toggle('hidden', !state.busy.photo);
        document.getElementById('photoZipBtn').disabled = state.busy.photo || doneCount === 0;

        if (state.photo.items.length === 0) {
          listEl.innerHTML = '';
          return;
        }

        listEl.innerHTML = state.photo.items.map((item) => {
          let stText = 'QUEUED';
          let stColor = 'var(--text-muted)';
          if (item.status === 'working') { stText = 'PROCESSING...'; stColor = 'var(--accent-hi)'; }
          else if (item.status === 'done') {
            const delta = item.file.size > 0 ? (((item.outBlob.size - item.file.size) / item.file.size) * 100).toFixed(1) : '0.0';
            stText = `DONE · ${formatBytes(item.outBlob.size)} (${delta > 0 ? '+' + delta : delta}%)`;
            stColor = 'var(--teal)';
          } else if (item.status === 'error') {
            stText = `ERR: ${item.error}`;
            stColor = 'var(--rose)';
          }

          return `
            <div class="px-card-sm flex-row flex-wrap justify-between gap-3">
              <div class="flex-row gap-3 min-w-0 flex-1">
                ${renderThumbMarkup(item.thumbUrl, 'photo')}
                <div class="min-w-0 flex-1">
                  <p class="font-mono-tech truncate" style="margin:0;font-size:0.8125rem;" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</p>
                  <p class="sub-muted font-mono-tech">
                    ${formatBytes(item.file.size)}${item.dims ? ` · ${escapeHtml(item.dims)}` : ''} · <span style="color:${stColor};">${escapeHtml(stText)}</span>
                  </p>
                </div>
              </div>
              <div class="flex-row gap-2 shrink-0">
                ${item.status === 'done' && item.outUrl
                  ? `<a href="${item.outUrl}" download="${escapeHtml(item.outName)}" class="px-btn px-btn-primary font-mono-tech" style="padding:0.35rem 0.65rem;">Download</a>`
                  : ''}
                <button type="button" data-remove-photo="${item.id}" class="px-btn font-mono-tech" style="padding:0.35rem 0.55rem;" ${state.busy.photo ? 'disabled' : ''}>×</button>
              </div>
            </div>
          `;
        }).join('');
      }

      export async function runPhotoBatch() {
        if (state.busy.photo || state.photo.items.length === 0) return;
        state.busy.photo = true;
        state.cancel.photo = false;
        renderPhotoQueue();

        try {
        const progBox = document.getElementById('photoProgressBox');
        const statusEl = document.getElementById('photoStatusLabel');
        const pctEl = document.getElementById('photoPctLabel');
        progBox.classList.remove('hidden');

        const mime = document.getElementById('photoFormat').value;
        const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
        const qual = Number(document.getElementById('photoQuality').value);
        const resizeSpec = document.getElementById('photoResize').value;
        const maxKbRaw = Number(document.getElementById('photoMaxKb').value);
        const maxKb = maxKbRaw > 0 ? maxKbRaw : null;

        let origSum = 0;
        let outSum = 0;
        let ok = 0;
        let idx = 0;

        while (idx < state.photo.items.length) {
          if (state.cancel.photo) {
            showToast('Photo batch cancelled', 'warn');
            break;
          }
          const item = state.photo.items[idx];
          if (!item) break;
          item.status = 'working';
          item.error = '';
          if (item.outUrl) { URL.revokeObjectURL(item.outUrl); item.outUrl = null; }
          renderPhotoQueue();

          const total = state.photo.items.length;
          const pct = Math.round(((idx + 1) / total) * 100);
          statusEl.textContent = `Processing ${idx + 1} / ${total}: ${item.file.name}`;
          pctEl.textContent = `${pct}%`;
          setSegmentedProgress('photoSegTrack', pct, 'blue');

          try {
            const { blob, width, height } = await processPhotoBlob(item.file, mime, qual, resizeSpec, maxKb);
            item.dims = `${width}×${height}`;
            item.outBlob = blob;
            item.outUrl = URL.createObjectURL(blob);
            item.outName = `${baseName(item.file.name)}.${ext}`;
            item.status = 'done';
            origSum += item.file.size;
            outSum += blob.size;
            ok++;
          } catch (err) {
            item.status = 'error';
            item.error = (err && (err.message || String(err))) || 'Conversion failed';
            logLine(`Photo convert error (${item.file.name}): ${item.error}`);
          }
          renderPhotoQueue();
          idx++;
        }

        statusEl.textContent = state.cancel.photo ? `Cancelled (${ok} completed)` : `Converted ${ok} / ${state.photo.items.length} photo(s)`;
        pctEl.textContent = '100%';
        setSegmentedProgress('photoSegTrack', 100, 'teal');

        if (ok > 0) {
          const delta = origSum > 0 ? (((outSum - origSum) / origSum) * 100).toFixed(1) : '0.0';
          document.getElementById('photoDeltaSummary').textContent =
            `Total: ${formatBytes(origSum)} → ${formatBytes(outSum)} (${delta > 0 ? '+' + delta : delta}%)`;
          if (!state.cancel.photo) showToast(`Converted ${ok} photo(s)`, 'success');
        }

        } finally {
          state.busy.photo = false;
          renderPhotoQueue();
        }
      }

      


export function getVideoSpec() {
        const fmt = document.getElementById('videoFormat').value;
        const resVal = document.getElementById('videoRes').value;
        const qual = document.getElementById('videoQuality').value;
        const mute = document.getElementById('videoMute').checked;

        if (qual === 'copy' && fmt !== 'gif') {
          const args = ['-i', 'input', '-c:v', 'copy'];
          if (mute) args.push('-an');
          else args.push('-c:a', 'copy');
          if (fmt === 'mp4' || fmt === 'mov') args.push('-movflags', '+faststart');
          const outName = `output.${fmt}`;
          args.push(outName);
          return { args, outExt: fmt, outName, mime: VIDEO_MIMES[fmt] || 'video/mp4', vfScale: null, crf: '22', mute, qual };
        }

        const vfScale = resVal !== 'original' ? `scale=-2:${resVal}` : null;

        if (fmt === 'gif') {
          const vf = vfScale ? `fps=15,${vfScale}` : 'fps=15';
          return { args: ['-i', 'input', '-vf', vf, '-loop', '0', 'output.gif'], outExt: 'gif', outName: 'output.gif', mime: VIDEO_MIMES.gif, vfScale, crf: '22', mute, qual };
        }

        const crfMap = { master: '18', high: '22', balanced: '26', compact: '30' };
        const crf = crfMap[qual] || '22';
        const args = ['-i', 'input'];

        if (fmt === 'mp4' || fmt === 'mov' || fmt === 'mkv') {
          if (vfScale) args.push('-vf', vfScale);
          // Use ultrafast or veryfast presets for browser WASM responsiveness
          const preset = qual === 'master' ? 'veryfast' : 'ultrafast';
          args.push('-c:v', 'libx264', '-crf', crf, '-preset', preset, '-pix_fmt', 'yuv420p', '-threads', '1');
          if (mute) args.push('-an');
          else args.push('-c:a', 'aac', '-b:a', qual === 'master' ? '256k' : qual === 'high' ? '192k' : '128k');
          if (fmt === 'mp4' || fmt === 'mov') args.push('-movflags', '+faststart');
        } else if (fmt === 'webm') {
          if (vfScale) args.push('-vf', vfScale);
          // Realtime deadline + cpu-used 8 for responsive VP9 in single-threaded WASM
          args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', crf, '-deadline', 'realtime', '-cpu-used', '8', '-threads', '1');
          if (mute) args.push('-an');
          else args.push('-c:a', 'libopus', '-b:a', qual === 'master' ? '192k' : '128k');
        } else if (fmt === 'avi') {
          if (vfScale) args.push('-vf', vfScale);
          const qv = qual === 'master' ? '2' : qual === 'high' ? '4' : qual === 'balanced' ? '6' : '10';
          args.push('-c:v', 'mpeg4', '-q:v', qv, '-threads', '1');
          if (mute) args.push('-an');
          else args.push('-c:a', 'libmp3lame', '-b:a', qual === 'master' ? '256k' : '128k');
        }

        const outName = `output.${fmt}`;
        args.push(outName);
        return { args, outExt: fmt, outName, mime: VIDEO_MIMES[fmt] || 'video/mp4', vfScale, crf, mute, qual };
      }

      export function refreshVideoCliPreview() {
        const { args } = getVideoSpec();
        document.getElementById('videoCliPreview').textContent = `ffmpeg ${args.join(' ')}`;
      }

      export function addVideoFiles(files) {
        for (const file of files) {
          if (!checkFileSizeGuardrail(file, false)) continue;
          const item = {
            id: nextId(),
            file,
            thumbUrl: null,
            duration: 0,
            dims: '',
            status: 'queued',
            outBlob: null,
            outUrl: null,
            outName: '',
            error: '',
          };
          state.video.items.push(item);

          probeVideoAndThumb(file).then((info) => {
            if (state.video.items.some((x) => x.id === item.id)) {
              item.thumbUrl = info.thumbUrl;
              item.duration = info.duration || 0;
              item.dims = info.width ? `${info.width}×${info.height} · ${info.duration.toFixed(1)}s` : 'Unknown duration';
              renderVideoQueue();
            } else if (info.thumbUrl) {
              URL.revokeObjectURL(info.thumbUrl);
            }
          });
        }
        renderVideoQueue();
      }

      export function removeVideoItem(id) {
        const idx = state.video.items.findIndex((x) => x.id === id);
        if (idx === -1) return;
        const [rm] = state.video.items.splice(idx, 1);
        if (rm.thumbUrl) URL.revokeObjectURL(rm.thumbUrl);
        if (rm.outUrl) URL.revokeObjectURL(rm.outUrl);
        renderVideoQueue();
      }

      export function cancelVideoBatch() {
        state.cancel.video = true;
        const statusEl = document.getElementById('videoStatusLabel');
        if (statusEl) statusEl.textContent = 'Cancelling video batch...';
        if (state.ffmpeg) {
          try {
            state.ffmpeg.terminate();
          } catch (_) {}
          state.ffmpeg = null;
          state.ffmpegLoaded = false;
          state.ffmpegLoadingPromise = null;
        }
        state.busy.video = false;
        renderVideoQueue();
        showToast('Video conversion cancelled', 'warn');
        logLine('[video] Batch cancelled by user; FFmpeg instance terminated.');
      }

      export function clearVideoQueue() {
        if (state.busy.video) {
          cancelVideoBatch();
        }
        state.video.items.forEach((it) => {
          if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
          if (it.outUrl) URL.revokeObjectURL(it.outUrl);
        });
        if (state.video.zipUrl) { URL.revokeObjectURL(state.video.zipUrl); state.video.zipUrl = null; }
        state.video.items = [];
        state.busy.video = false;
        const pBox = document.getElementById('videoProgressBox');
        if (pBox) pBox.classList.add('hidden');
        renderVideoQueue();
      }

      export function renderVideoQueue() {
        const listEl = document.getElementById('videoQueueList');
        const doneCount = state.video.items.filter((x) => x.status === 'done' && x.outBlob).length;

        document.getElementById('videoQueueCount').textContent =
          `ffmpeg.wasm · MP4 (H.264) · WebM (VP9/VP8) · MOV · MKV · AVI · Animated GIF · ${state.video.items.length} queued`;
        document.getElementById('videoRunBtn').disabled = state.busy.video || state.video.items.length === 0;
        document.getElementById('videoCancelBtn').classList.toggle('hidden', !state.busy.video);
        document.getElementById('videoZipBtn').disabled = state.busy.video || doneCount === 0;

        if (state.video.items.length === 0) {
          listEl.innerHTML = '';
          return;
        }

        listEl.innerHTML = state.video.items.map((item) => {
          let stText = 'QUEUED';
          let stColor = 'var(--text-muted)';
          if (item.status === 'working') { stText = 'ENCODING...'; stColor = 'var(--accent-hi)'; }
          else if (item.status === 'done') {
            const delta = item.file.size > 0 ? (((item.outBlob.size - item.file.size) / item.file.size) * 100).toFixed(1) : '0.0';
            stText = `DONE · ${formatBytes(item.outBlob.size)} (${delta > 0 ? '+' + delta : delta}%)`;
            stColor = 'var(--teal)';
          } else if (item.status === 'error') {
            stText = `ERR: ${item.error}`;
            stColor = 'var(--rose)';
          }

          return `
            <div class="px-card-sm flex-row flex-wrap justify-between gap-3">
              <div class="flex-row gap-3 min-w-0 flex-1">
                ${renderThumbMarkup(item.thumbUrl, 'video')}
                <div class="min-w-0 flex-1">
                  <p class="font-mono-tech truncate" style="margin:0;font-size:0.8125rem;" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</p>
                  <p class="sub-muted font-mono-tech">
                    ${formatBytes(item.file.size)}${item.dims ? ` · ${escapeHtml(item.dims)}` : ''} · <span style="color:${stColor};">${escapeHtml(stText)}</span>
                  </p>
                </div>
              </div>
              <div class="flex-row gap-2 shrink-0">
                ${item.status === 'done' && item.outUrl
                  ? `<a href="${item.outUrl}" download="${escapeHtml(item.outName)}" class="px-btn px-btn-primary font-mono-tech" style="padding:0.35rem 0.65rem;">Download</a>`
                  : ''}
                <button type="button" data-remove-video="${item.id}" class="px-btn font-mono-tech" style="padding:0.35rem 0.55rem;" ${state.busy.video ? 'disabled' : ''}>×</button>
              </div>
            </div>
          `;
        }).join('');
      }

      export async function runVideoBatch() {
        if (state.busy.video || state.video.items.length === 0) return;
        state.busy.video = true;
        state.cancel.video = false;
        renderVideoQueue();

        const progBox = document.getElementById('videoProgressBox');
        const statusEl = document.getElementById('videoStatusLabel');
        const pctEl = document.getElementById('videoPctLabel');
        progBox.classList.remove('hidden');

        try {
          let ffmpeg = null;
          try {
            if (!state.ffmpegLoaded) {
              statusEl.textContent = 'Initializing local FFmpeg engine (0%)...';
              pctEl.textContent = '0%';
              setSegmentedProgress('videoSegTrack', 0, 'blue');
            }
            ffmpeg = await getFFmpeg((msg, p) => {
              statusEl.textContent = msg;
              const initPct = Math.round(p * 0.15);
              pctEl.textContent = `${initPct}%`;
              setSegmentedProgress('videoSegTrack', initPct, 'blue');
            });
            statusEl.textContent = 'Engine ready · Preparing video encoder...';
            pctEl.textContent = '0%';
            setSegmentedProgress('videoSegTrack', 0, 'blue');
          } catch (err) {
            const errStr = (err && (err.message || String(err))) || 'Engine failed to initialize';
            showToast(`FFmpeg load failed: ${errStr}`, 'error');
            logLine(`[video] FFmpeg boot error: ${errStr}`);
            statusEl.textContent = `Engine error: ${errStr}`;
            pctEl.textContent = 'ERR';
            setSegmentedProgress('videoSegTrack', 0, 'rose');
            state.busy.video = false;
            renderVideoQueue();
            return;
          }

          const spec = getVideoSpec();
          let ok = 0;
          let idx = 0;
          const total = state.video.items.length;

          while (idx < total) {
            if (state.cancel.video) {
              showToast('Video batch cancelled', 'warn');
              break;
            }
            const item = state.video.items[idx];
            if (!item) break;
            item.status = 'working';
            item.error = '';
            if (item.outUrl) { URL.revokeObjectURL(item.outUrl); item.outUrl = null; }
            renderVideoQueue();

            const baseOverall = Math.round((idx / total) * 100);
            statusEl.textContent = `Reading ${item.file.name} (${idx + 1} / ${total})...`;
            pctEl.textContent = `${baseOverall}%`;
            setSegmentedProgress('videoSegTrack', baseOverall, 'blue');

            const inExt = extOf(item.file.name) || 'mp4';
            const inName = `input_${item.id}.${inExt}`;
            const outName = `output_${item.id}.${spec.outExt}`;

            const itemArgs = spec.args.map((a) => {
              if (a === 'input') return inName;
              if (a === spec.outName) return outName;
              return a;
            });

            const itemLogs = [];
            const onItemLog = ({ message }) => {
              if (message) {
                itemLogs.push(message);
                if (itemLogs.length > 30) itemLogs.shift();
              }
            };

            const onProg = ({ progress, time }) => {
              if (state.cancel.video) return;
              let sub = 0;
              if (typeof progress === 'number' && Number.isFinite(progress) && progress > 0) {
                sub = Math.max(0, Math.min(1, progress));
              } else if (typeof time === 'number' && Number.isFinite(time) && time > 0 && item.duration > 0) {
                const elapsedSec = (time > 100000) ? (time / 1000000) : (time > 100 ? time / 1000 : time);
                sub = Math.max(0, Math.min(0.99, elapsedSec / item.duration));
              }
              const overall = Math.min(99, Math.round(((idx + sub) / total) * 100));
              const subPct = Math.round(sub * 100);
              const timeStr = (typeof time === 'number' && time > 0)
                ? ` · ${((time > 100000 ? time / 1000000 : time > 100 ? time / 1000 : time)).toFixed(1)}s`
                : '';
              statusEl.textContent = `Encoding ${idx + 1} / ${total} (${subPct}%${timeStr}): ${item.file.name}`;
              pctEl.textContent = `${overall}%`;
              setSegmentedProgress('videoSegTrack', overall, 'blue');
            };

            try {
              ffmpeg.on('log', onItemLog);
              ffmpeg.on('progress', onProg);

              statusEl.textContent = `Writing virtual FS (${idx + 1} / ${total}): ${item.file.name}...`;
              const fileData = new Uint8Array(await item.file.arrayBuffer());
              await ffmpeg.writeFile(inName, fileData);

              logLine(`[video] CLI: ffmpeg ${itemArgs.join(' ')}`);
              statusEl.textContent = `Encoding ${idx + 1} / ${total} (0%): ${item.file.name}`;

              let exitCode = await ffmpeg.exec(itemArgs);
              let outData = null;

              if (exitCode === 0) {
                try {
                  outData = await ffmpeg.readFile(outName);
                } catch (_) {}
              }

              // Automatic codec fallbacks if primary encoder failed or produced empty file
              if ((!outData || outData.length === 0) && !state.cancel.video) {
                const errSnippet = itemLogs.filter(l => l.includes('Error') || l.includes('Invalid') || l.includes('failed') || l.includes('not supported') || l.includes('Conversion failed')).slice(-2).join(' ') || '';
                logLine(`[video] Primary encode failed (exit ${exitCode}, ${errSnippet}). Checking fallback options...`);

                // WebM: libvpx-vp9 -> libvpx VP8 fallback
                if (spec.outExt === 'webm' && itemArgs.includes('libvpx-vp9')) {
                  logLine('[video] Retrying WebM with libvpx (VP8)...');
                  await safeDelete(ffmpeg, outName);
                  const fb = ['-i', inName];
                  if (spec.vfScale) fb.push('-vf', spec.vfScale);
                  fb.push('-c:v', 'libvpx', '-b:v', '2M', '-crf', spec.crf, '-deadline', 'realtime', '-cpu-used', '8', '-threads', '1');
                  if (spec.mute) fb.push('-an');
                  else fb.push('-c:a', 'libvorbis', '-q:a', '5');
                  fb.push(outName);
                  exitCode = await ffmpeg.exec(fb);
                  if (exitCode === 0) {
                    outData = await ffmpeg.readFile(outName);
                  }
                }
                // MP4 / MOV / MKV: libx264 -> mpeg4 fallback
                else if ((spec.outExt === 'mp4' || spec.outExt === 'mov' || spec.outExt === 'mkv') && itemArgs.includes('libx264')) {
                  logLine('[video] Retrying with compatible mpeg4 codec...');
                  await safeDelete(ffmpeg, outName);
                  const fb = ['-i', inName];
                  if (spec.vfScale) fb.push('-vf', spec.vfScale);
                  fb.push('-c:v', 'mpeg4', '-q:v', '4', '-threads', '1');
                  if (spec.mute) fb.push('-an');
                  else fb.push('-c:a', 'aac', '-b:a', '128k');
                  if (spec.outExt === 'mp4' || spec.outExt === 'mov') fb.push('-movflags', '+faststart');
                  fb.push(outName);
                  exitCode = await ffmpeg.exec(fb);
                  if (exitCode === 0) {
                    outData = await ffmpeg.readFile(outName);
                  }
                }
              }

              if (state.cancel.video) {
                showToast('Video batch cancelled', 'warn');
                break;
              }

              if (!outData || outData.length === 0) {
                const diag = itemLogs.filter(l => !l.startsWith('ffmpeg version') && !l.startsWith('  built with') && !l.startsWith('  configuration:')).slice(-2).join(' ') || `Process exited with code ${exitCode}`;
                throw new Error(`Encode failed: ${diag}`);
              }

              const blob = new Blob([outData.buffer], { type: spec.mime });
              item.outBlob = blob;
              item.outUrl = URL.createObjectURL(blob);
              item.outName = `${baseName(item.file.name)}.${spec.outExt}`;
              item.status = 'done';
              ok++;
              logLine(`[video] Finished ${item.outName} (${formatBytes(blob.size)})`);
            } catch (err) {
              item.status = 'error';
              item.error = (err && (err.message || String(err))) || 'Encode failed';
              logLine(`[video] Error (${item.file.name}): ${item.error}`);
            } finally {
              ffmpeg.off('log', onItemLog);
              ffmpeg.off('progress', onProg);
              await safeDelete(ffmpeg, inName);
              await safeDelete(ffmpeg, outName);
            }

            renderVideoQueue();
            idx++;
          }

          if (state.cancel.video) {
            statusEl.textContent = `Cancelled (${ok} / ${total} completed)`;
            pctEl.textContent = 'CANCEL';
            setSegmentedProgress('videoSegTrack', Math.round((ok / total) * 100), 'rose');
          } else {
            statusEl.textContent = `Converted ${ok} / ${total} video(s)`;
            pctEl.textContent = '100%';
            setSegmentedProgress('videoSegTrack', 100, ok === total ? 'teal' : 'amber');
            if (ok > 0) showToast(`Converted ${ok} video(s)`, 'success');
          }

        } finally {
          state.busy.video = false;
          renderVideoQueue();
        }
      }

      


export function getAudioSpec() {
        const fmt = document.getElementById('audioFormat').value;
        const qual = document.getElementById('audioQuality').value;
        const sr = document.getElementById('audioSampleRate').value;
        const bd = document.getElementById('audioBitDepth').value;
        const keepMeta = document.getElementById('audioPreserveMeta').checked;

        const args = ['-i', 'input', '-vn'];
        if (sr !== 'original') args.push('-ar', sr);

        let outExt = fmt;
        let note = '';

        if (fmt === 'flac') {
          outExt = 'flac';
          if (bd === '24') args.push('-sample_fmt', 's32');
          else if (bd === '16') args.push('-sample_fmt', 's16');
          const lvl = qual === 'master' ? '8' : qual === 'high' ? '5' : '2';
          args.push('-c:a', 'flac', '-compression_level', lvl);
          note = `Lossless Codec FLAC (-compression_level ${lvl})`;
        } else if (fmt === 'alac') {
          outExt = 'm4a';
          args.push('-c:a', 'alac');
          note = 'Lossless Codec Apple ALAC (.m4a container)';
        } else if (fmt === 'wav') {
          outExt = 'wav';
          const codec = bd === '16' ? 'pcm_s16le' : 'pcm_s24le';
          args.push('-c:a', codec);
          note = `Uncompressed PCM WAV (${codec})`;
        } else if (fmt === 'aiff') {
          outExt = 'aiff';
          const codec = bd === '16' ? 'pcm_s16be' : 'pcm_s24be';
          args.push('-c:a', codec);
          note = `Uncompressed PCM AIFF (${codec})`;
        } else if (fmt === 'mp3') {
          outExt = 'mp3';
          if (qual === 'master') {
            args.push('-c:a', 'libmp3lame', '-b:a', '320k', '-q:a', '0');
            note = 'Lossy Max MP3: 320 kbps CBR (-q:a 0)';
          } else if (qual === 'high') {
            args.push('-c:a', 'libmp3lame', '-q:a', '0');
            note = 'Lossy Transparent MP3 VBR V0 (-q:a 0)';
          } else {
            args.push('-c:a', 'libmp3lame', '-b:a', '160k');
            note = 'Lossy Compact MP3 (160 kbps)';
          }
        } else if (fmt === 'aac') {
          outExt = 'm4a';
          const br = qual === 'master' ? '320k' : qual === 'high' ? '256k' : '160k';
          args.push('-c:a', 'aac', '-b:a', br);
          note = `Lossy AAC LC inside .m4a (${br})`;
        } else if (fmt === 'opus') {
          outExt = 'opus';
          const br = qual === 'master' ? '256k' : qual === 'high' ? '192k' : '128k';
          args.push('-c:a', 'libopus', '-b:a', br);
          note = `Lossy Opus stream (${br})`;
        } else if (fmt === 'ogg') {
          outExt = 'ogg';
          const q = qual === 'master' ? '10' : qual === 'high' ? '7' : '4';
          args.push('-c:a', 'libvorbis', '-q:a', q);
          note = `Lossy Ogg Vorbis (-q:a ${q})`;
        }

        args.push('-map_metadata', keepMeta ? '0' : '-1');
        const outName = `output.${outExt}`;
        args.push(outName);
        return { args, outExt, outName, mime: AUDIO_MIMES[fmt] || 'application/octet-stream', note };
      }

      export function refreshAudioCliPreview() {
        const { args, note } = getAudioSpec();
        document.getElementById('audioCliPreview').textContent = `ffmpeg ${args.join(' ')}`;
        document.getElementById('audioCodecNote').textContent = note;
      }

      export function addAudioFiles(files) {
        for (const file of files) {
          if (!checkFileSizeGuardrail(file, false)) continue;
          const isVid = isVideoFile(file);
          const item = {
            id: nextId(),
            file,
            isVideo: isVid,
            thumbUrl: null,
            status: 'queued',
            outBlob: null,
            outUrl: null,
            outName: '',
            error: '',
          };
          state.audio.items.push(item);

          if (isVid) {
            probeVideoAndThumb(file).then((info) => {
              if (state.audio.items.some((x) => x.id === item.id)) {
                item.thumbUrl = info.thumbUrl;
                renderAudioQueue();
              } else if (info.thumbUrl) {
                URL.revokeObjectURL(info.thumbUrl);
              }
            });
          }
        }
        renderAudioQueue();
      }

      export function removeAudioItem(id) {
        const idx = state.audio.items.findIndex((x) => x.id === id);
        if (idx === -1) return;
        const [rm] = state.audio.items.splice(idx, 1);
        if (rm.thumbUrl) URL.revokeObjectURL(rm.thumbUrl);
        if (rm.outUrl) URL.revokeObjectURL(rm.outUrl);
        renderAudioQueue();
      }

      export function clearAudioQueue() {
        state.audio.items.forEach((it) => {
          if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
          if (it.outUrl) URL.revokeObjectURL(it.outUrl);
        });
        if (state.audio.zipUrl) { URL.revokeObjectURL(state.audio.zipUrl); state.audio.zipUrl = null; }
        state.audio.items = [];
        document.getElementById('audioProgressBox').classList.add('hidden');
        renderAudioQueue();
      }

      export function renderAudioQueue() {
        const listEl = document.getElementById('audioQueueList');
        const doneCount = state.audio.items.filter((x) => x.status === 'done' && x.outBlob).length;

        document.getElementById('audioQueueCount').textContent =
          `Lossless Codecs (FLAC, ALAC, PCM WAV/AIFF) & Max Bitrate Lossy (MP3 320k, AAC, Opus, OGG) · ${state.audio.items.length} queued`;
        document.getElementById('audioRunBtn').disabled = state.busy.audio || state.audio.items.length === 0;
        document.getElementById('audioCancelBtn').classList.toggle('hidden', !state.busy.audio);
        document.getElementById('audioZipBtn').disabled = state.busy.audio || doneCount === 0;

        if (state.audio.items.length === 0) {
          listEl.innerHTML = '';
          return;
        }

        listEl.innerHTML = state.audio.items.map((item) => {
          let stText = 'QUEUED';
          let stColor = 'var(--text-muted)';
          if (item.status === 'working') { stText = 'ENCODING...'; stColor = 'var(--accent-hi)'; }
          else if (item.status === 'done') { stText = `READY · ${formatBytes(item.outBlob.size)}`; stColor = 'var(--teal)'; }
          else if (item.status === 'error') { stText = `ERR: ${item.error}`; stColor = 'var(--rose)'; }

          return `
            <div class="px-card-sm stack-2-5">
              <div class="flex-row flex-wrap justify-between gap-3">
                <div class="flex-row gap-3 min-w-0 flex-1">
                  ${renderThumbMarkup(item.thumbUrl, item.isVideo ? 'video' : 'audio')}
                  <div class="min-w-0 flex-1">
                    <p class="font-mono-tech truncate" style="margin:0;font-size:0.8125rem;" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</p>
                    <p class="sub-muted font-mono-tech">${formatBytes(item.file.size)} · <span style="color:${stColor};">${escapeHtml(stText)}</span></p>
                  </div>
                </div>
                <div class="flex-row gap-2 shrink-0">
                  ${item.status === 'done' && item.outUrl
                    ? `<a href="${item.outUrl}" download="${escapeHtml(item.outName)}" class="px-btn px-btn-primary font-mono-tech" style="padding:0.35rem 0.65rem;">Download</a>`
                    : ''}
                  <button type="button" data-remove-audio="${item.id}" class="px-btn font-mono-tech" style="padding:0.35rem 0.55rem;" ${state.busy.audio ? 'disabled' : ''}>×</button>
                </div>
              </div>
              ${item.status === 'done' && item.outUrl ? `<audio controls src="${item.outUrl}" style="width:100%;height:32px;"></audio>` : ''}
            </div>
          `;
        }).join('');
      }

      export function cancelAudioBatch() {
        state.cancel.audio = true;
        const statusEl = document.getElementById('audioStatusLabel');
        if (statusEl) statusEl.textContent = 'Cancelling audio batch...';
        if (state.ffmpeg) {
          try {
            state.ffmpeg.terminate();
          } catch (_) {}
          state.ffmpeg = null;
          state.ffmpegLoaded = false;
          state.ffmpegLoadingPromise = null;
        }
        state.busy.audio = false;
        renderAudioQueue();
        showToast('Audio conversion cancelled', 'warn');
        logLine('[audio] Batch cancelled by user; FFmpeg instance terminated.');
      }

      export async function runAudioBatch() {
        if (state.busy.audio || state.audio.items.length === 0) return;
        state.busy.audio = true;
        state.cancel.audio = false;
        renderAudioQueue();

        const progBox = document.getElementById('audioProgressBox');
        const statusEl = document.getElementById('audioStatusLabel');
        const pctEl = document.getElementById('audioPctLabel');
        progBox.classList.remove('hidden');

        try {
          let ffmpeg = null;
          try {
            if (!state.ffmpegLoaded) {
              statusEl.textContent = 'Initializing local FFmpeg engine (0%)...';
              pctEl.textContent = '0%';
              setSegmentedProgress('audioSegTrack', 0, 'blue');
            }
            ffmpeg = await getFFmpeg((msg, p) => {
              statusEl.textContent = msg;
              const initPct = Math.round(p * 0.15);
              pctEl.textContent = `${initPct}%`;
              setSegmentedProgress('audioSegTrack', initPct, 'blue');
            });
            statusEl.textContent = 'Engine ready · Preparing audio encoder...';
            pctEl.textContent = '0%';
            setSegmentedProgress('audioSegTrack', 0, 'blue');
          } catch (err) {
            const errStr = (err && (err.message || String(err))) || 'Engine failed to initialize';
            showToast(`FFmpeg load failed: ${errStr}`, 'error');
            logLine(`[audio] FFmpeg boot error: ${errStr}`);
            statusEl.textContent = `Engine error: ${errStr}`;
            pctEl.textContent = 'ERR';
            setSegmentedProgress('audioSegTrack', 0, 'rose');
            state.busy.audio = false;
            renderAudioQueue();
            return;
          }

          const spec = getAudioSpec();
          let ok = 0;
          let idx = 0;
          const total = state.audio.items.length;

          while (idx < total) {
            if (state.cancel.audio) {
              showToast('Audio batch cancelled', 'warn');
              break;
            }
            const item = state.audio.items[idx];
            if (!item) break;
            item.status = 'working';
            item.error = '';
            if (item.outUrl) { URL.revokeObjectURL(item.outUrl); item.outUrl = null; }
            renderAudioQueue();

            const baseOverall = Math.round((idx / total) * 100);
            statusEl.textContent = `Reading ${item.file.name} (${idx + 1} / ${total})...`;
            pctEl.textContent = `${baseOverall}%`;
            setSegmentedProgress('audioSegTrack', baseOverall, 'blue');

            const inExt = extOf(item.file.name) || (item.isVideo ? 'mp4' : 'wav');
            const inName = `input_${item.id}.${inExt}`;
            const outName = `output_${item.id}.${spec.outExt}`;

            const itemArgs = spec.args.map((a) => {
              if (a === 'input') return inName;
              if (a === spec.outName) return outName;
              return a;
            });

            const itemLogs = [];
            const onItemLog = ({ message }) => {
              if (message) {
                itemLogs.push(message);
                if (itemLogs.length > 30) itemLogs.shift();
              }
            };

            const onProg = ({ progress, time }) => {
              if (state.cancel.audio) return;
              let sub = 0;
              if (typeof progress === 'number' && Number.isFinite(progress) && progress > 0) {
                sub = Math.max(0, Math.min(1, progress));
              } else if (typeof time === 'number' && Number.isFinite(time) && time > 0 && item.duration > 0) {
                const elapsedSec = (time > 100000) ? (time / 1000000) : (time > 100 ? time / 1000 : time);
                sub = Math.max(0, Math.min(0.99, elapsedSec / item.duration));
              }
              const overall = Math.min(99, Math.round(((idx + sub) / total) * 100));
              const subPct = Math.round(sub * 100);
              statusEl.textContent = `Encoding ${idx + 1} / ${total} (${subPct}%): ${item.file.name}`;
              pctEl.textContent = `${overall}%`;
              setSegmentedProgress('audioSegTrack', overall, 'blue');
            };

            try {
              ffmpeg.on('log', onItemLog);
              ffmpeg.on('progress', onProg);

              statusEl.textContent = `Writing virtual FS (${idx + 1} / ${total}): ${item.file.name}...`;
              const fileData = new Uint8Array(await item.file.arrayBuffer());
              await ffmpeg.writeFile(inName, fileData);

              logLine(`[audio] CLI: ffmpeg ${itemArgs.join(' ')}`);
              statusEl.textContent = `Encoding ${idx + 1} / ${total} (0%): ${item.file.name}`;

              const exitCode = await ffmpeg.exec(itemArgs);
              let outData = null;

              if (exitCode === 0) {
                try {
                  outData = await ffmpeg.readFile(outName);
                } catch (_) {}
              }

              if (state.cancel.audio) {
                showToast('Audio batch cancelled', 'warn');
                break;
              }

              if (!outData || outData.length === 0) {
                const diag = itemLogs.filter(l => !l.startsWith('ffmpeg version') && !l.startsWith('  built with')).slice(-2).join(' ') || `Process exited with code ${exitCode}`;
                throw new Error(`Audio encode failed: ${diag}`);
              }

              const blob = new Blob([outData.buffer], { type: spec.mime });
              item.outBlob = blob;
              item.outUrl = URL.createObjectURL(blob);
              item.outName = `${baseName(item.file.name)}.${spec.outExt}`;
              item.status = 'done';
              ok++;
              logLine(`[audio] Finished ${item.outName} (${formatBytes(blob.size)})`);
            } catch (err) {
              item.status = 'error';
              item.error = (err && (err.message || String(err))) || 'Encode failed';
              logLine(`[audio] Error (${item.file.name}): ${item.error}`);
            } finally {
              ffmpeg.off('log', onItemLog);
              ffmpeg.off('progress', onProg);
              await safeDelete(ffmpeg, inName);
              await safeDelete(ffmpeg, outName);
            }

            renderAudioQueue();
            idx++;
          }

          if (state.cancel.audio) {
            statusEl.textContent = `Cancelled (${ok} / ${total} completed)`;
            pctEl.textContent = 'CANCEL';
            setSegmentedProgress('audioSegTrack', Math.round((ok / total) * 100), 'rose');
          } else {
            statusEl.textContent = `Converted ${ok} / ${total} audio track(s)`;
            pctEl.textContent = '100%';
            setSegmentedProgress('audioSegTrack', 100, ok === total ? 'teal' : 'amber');
            if (ok > 0) showToast(`Converted ${ok} audio track(s)`, 'success');
          }

        } finally {
          state.busy.audio = false;
          renderAudioQueue();
        }
      }

      


export const downloadPhotoZip = () => exportZipBundle(state.photo.items, 'swissfile_photos', state.photo);
export const downloadVideoZip = () => exportZipBundle(state.video.items, 'swissfile_videos', state.video);
export const downloadAudioZip = () => exportZipBundle(state.audio.items, 'swissfile_audio', state.audio);


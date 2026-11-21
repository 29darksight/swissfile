import { state, uid, nextId, SUPPORTED_REPAIR_EXTS, AUDIO_MIMES } from './state.js';
import {
  $, $$, escapeHtml, formatBytes, baseName, extOf, checkFileSizeGuardrail,
  showToast, logLine, setSegmentedProgress, renderThumbMarkup,
  probeVideoAndThumb, probeAudioMetadata, exportZipBundle
} from './dom.js';
import { ensureDependency, getFFmpeg, safeDelete } from './vendors.js';
import { detectMagicSignature } from './binary.js';
import { decodeImageSource, processPhotoBlob } from './photo-video-audio.js';

export function setRepairScope(scope) {
        state.repair.scope = scope;
        const onlyCorrupt = scope === 'corrupted';
        document.getElementById('repairScopeCorruptBtn').classList.toggle('px-btn-primary', onlyCorrupt);
        document.getElementById('repairScopeAllBtn').classList.toggle('px-btn-primary', !onlyCorrupt);
      }

      export function findImageHeaderOffset(bytes) {
        for (let i = 0; i <= bytes.length - 8; i++) {
          if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8 && bytes[i + 2] === 0xFF) return { type: 'jpeg', offset: i };
          if (
            bytes[i] === 0x89 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4E && bytes[i + 3] === 0x47 &&
            bytes[i + 4] === 0x0D && bytes[i + 5] === 0x0A && bytes[i + 6] === 0x1A && bytes[i + 7] === 0x0A
          ) return { type: 'png', offset: i };
          if (
            bytes[i] === 0x47 && bytes[i + 1] === 0x49 && bytes[i + 2] === 0x46 && bytes[i + 3] === 0x38 &&
            (bytes[i + 4] === 0x37 || bytes[i + 4] === 0x39) && bytes[i + 5] === 0x61
          ) return { type: 'gif', offset: i };
          if (
            i <= bytes.length - 12 &&
            bytes[i] === 0x52 && bytes[i + 1] === 0x49 && bytes[i + 2] === 0x46 && bytes[i + 3] === 0x46 &&
            bytes[i + 8] === 0x57 && bytes[i + 9] === 0x45 && bytes[i + 10] === 0x42 && bytes[i + 11] === 0x50
          ) return { type: 'webp', offset: i };
        }
        return null;
      }

      export async function diagnoseFileAuto(item) {
        const file = item.file;
        const ext = extOf(file.name);

        if (file.size === 0) {
          item.diagStatus = 'corrupted';
          item.diagLabel = 'EMPTY (0 B)';
          item.diagDetail = 'Zero byte file, cannot recover missing bytes';
          return;
        }

        const head512 = new Uint8Array(await file.slice(0, Math.min(512, file.size)).arrayBuffer());
        const tail32 = new Uint8Array(await file.slice(Math.max(0, file.size - 32), file.size).arrayBuffer());
        const head16 = head512.slice(0, 16);
        const sig = detectMagicSignature(head16);

        // Reject unsupported binary/document/executable files instead of guessing 'video'
        if (sig.kind === 'unsupported' && !SUPPORTED_REPAIR_EXTS.has(ext)) {
          item.kind = 'unsupported';
          item.diagStatus = 'unsupported';
          item.diagLabel = 'UNSUPPORTED FORMAT';
          item.diagDetail = `Rejected: ${sig.label} (not a supported photo, video, or audio format)`;
          return;
        }

        if (sig.kind === 'photo' || sig.kind === 'video' || sig.kind === 'audio') {
          item.kind = sig.kind;
        } else if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext)) {
          item.kind = 'photo';
        } else if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'].includes(ext)) {
          item.kind = 'video';
        } else if (['mp3', 'flac', 'wav', 'm4a', 'ogg', 'opus', 'aiff', 'aif'].includes(ext)) {
          item.kind = 'audio';
        } else {
          item.kind = 'unsupported';
          item.diagStatus = 'unsupported';
          item.diagLabel = 'UNSUPPORTED FORMAT';
          item.diagDetail = `Unsupported extension .${ext || 'none'} and unrecognized magic bytes`;
          return;
        }

        if (item.kind === 'photo' && sig.id === 'null') {
          const shifted = findImageHeaderOffset(head512);
          if (shifted) {
            item.diagStatus = 'corrupted';
            item.diagLabel = 'SHIFTED HEADER';
            item.diagDetail = `${shifted.type.toUpperCase()} header found at byte offset +${shifted.offset}`;
            item.patchSpec = { stripLeading: shifted.offset, imgType: shifted.type };
            return;
          }
        }

        if (sig.id === 'null') {
          item.diagStatus = 'corrupted';
          item.diagLabel = 'HEADER CORRUPT';
          item.diagDetail = 'First 16 bytes are all 0x00 (zero filled header)';
          return;
        }

        if (sig.exts && sig.exts.length > 0 && ext && !sig.exts.includes(ext)) {
          item.diagStatus = 'mismatch';
          item.diagLabel = 'EXT MISMATCH';
          item.diagDetail = `Extension .${ext} ≠ Magic ${sig.label}`;
          if (['jpeg', 'png', 'webp', 'gif'].includes(sig.id)) item.thumbUrl = URL.createObjectURL(file);
          return;
        }

        if (sig.id === 'jpeg') {
          let hasEoi = false;
          for (let i = 0; i < tail32.length - 1; i++) {
            if (tail32[i] === 0xFF && tail32[i + 1] === 0xD9) { hasEoi = true; break; }
          }
          if (!hasEoi) {
            item.diagStatus = 'truncated';
            item.diagLabel = 'TRUNCATED EOF';
            item.diagDetail = 'Missing JPEG EOI trailer (FF D9), truncated image stream';
            item.patchSpec = { appendJpegEoi: true };
            item.thumbUrl = URL.createObjectURL(file);
            return;
          }
        }

        if (sig.id === 'png') {
          let hasIend = false;
          for (let i = 0; i <= tail32.length - 4; i++) {
            if (tail32[i] === 0x49 && tail32[i + 1] === 0x45 && tail32[i + 2] === 0x4E && tail32[i + 3] === 0x44) { hasIend = true; break; }
          }
          if (!hasIend) {
            item.diagStatus = 'truncated';
            item.diagLabel = 'TRUNCATED EOF';
            item.diagDetail = 'Missing PNG IEND chunk, truncated image stream';
            item.patchSpec = { appendPngIend: true };
            return;
          }
        }

        if (item.kind === 'photo') {
          try {
            const dec = await decodeImageSource(file);
            const w = dec.width;
            const h = dec.height;
            dec.cleanup();
            item.thumbUrl = URL.createObjectURL(file);
            item.diagStatus = 'healthy';
            item.diagLabel = 'HEALTHY';
            item.diagDetail = `Valid ${sig.id.toUpperCase()} · ${w}×${h}`;
          } catch (_) {
            item.diagStatus = 'corrupted';
            item.diagLabel = 'UNREADABLE';
            item.diagDetail = 'Image bitmap decode failed, damaged bitstream';
          }
        } else if (item.kind === 'video') {
          const info = await probeVideoAndThumb(file);
          if (info.ok) {
            item.thumbUrl = info.thumbUrl;
            item.diagStatus = 'healthy';
            item.diagLabel = 'HEALTHY';
            item.diagDetail = `Valid ${(ext || 'VIDEO').toUpperCase()} · ${info.width}×${info.height} · ${info.duration.toFixed(1)}s`;
          } else {
            item.diagStatus = 'corrupted';
            item.diagLabel = 'UNREADABLE';
            item.diagDetail = info.reason || 'Damaged container or missing moov atom';
          }
        } else {
          const info = await probeAudioMetadata(file);
          if (info.ok) {
            item.diagStatus = 'healthy';
            item.diagLabel = 'HEALTHY';
            item.diagDetail = `Valid ${(ext || 'AUDIO').toUpperCase()} · ${info.duration.toFixed(1)}s`;
          } else {
            item.diagStatus = 'corrupted';
            item.diagLabel = 'UNREADABLE';
            item.diagDetail = info.reason || 'Damaged audio header/stream';
          }
        }
      }

      export async function addRepairFiles(files) {
        if (!files || files.length === 0) return;
        const added = [];
        for (const file of files) {
          if (!checkFileSizeGuardrail(file, false)) continue;
          const item = {
            id: nextId(),
            file,
            kind: 'unknown',
            thumbUrl: null,
            diagStatus: 'scanning',
            diagLabel: 'CHECKING...',
            diagDetail: 'Running format & header diagnostics...',
            patchSpec: null,
            repairStatus: 'idle',
            repairOutcomeLabel: '',
            outBlob: null,
            outUrl: null,
            outName: '',
            outKind: 'unknown',
            error: '',
          };
          state.repair.items.push(item);
          added.push(item);
        }
        renderRepairQueue();

        for (const item of added) {
          await diagnoseFileAuto(item);
          logLine(`Repair probe [${item.diagLabel}] ${item.file.name}: ${item.diagDetail}`);
          renderRepairQueue();
        }
      }

      export function removeRepairItem(id) {
        const idx = state.repair.items.findIndex((x) => x.id === id);
        if (idx === -1) return;
        const [rm] = state.repair.items.splice(idx, 1);
        if (rm.thumbUrl) URL.revokeObjectURL(rm.thumbUrl);
        if (rm.outUrl) URL.revokeObjectURL(rm.outUrl);
        renderRepairQueue();
      }

      export function clearRepairQueue() {
        state.repair.items.forEach((it) => {
          if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
          if (it.outUrl) URL.revokeObjectURL(it.outUrl);
        });
        if (state.repair.zipUrl) { URL.revokeObjectURL(state.repair.zipUrl); state.repair.zipUrl = null; }
        state.repair.items = [];
        document.getElementById('repairProgressBox').classList.add('hidden');
        renderRepairQueue();
      }

      export function renderRepairQueue() {
        const listEl = document.getElementById('repairQueueList');
        const total = state.repair.items.length;
        const healthy = state.repair.items.filter((x) => x.diagStatus === 'healthy').length;
        const issues = state.repair.items.filter((x) => !['healthy', 'scanning', 'unsupported'].includes(x.diagStatus)).length;
        const validatedCount = state.repair.items.filter((x) => ['container-repaired', 'stream-remuxed', 're-encoded', 'partial-recovery'].includes(x.repairStatus) && x.outBlob).length;

        document.getElementById('repairSummaryCounts').textContent =
          `${total} queued (${healthy} healthy · ${issues} repairable issues · ${validatedCount} validated outputs)`;
        document.getElementById('repairRunBtn').disabled = state.busy.repair || total === 0;
        document.getElementById('repairCancelBtn').classList.toggle('hidden', !state.busy.repair);
        document.getElementById('repairDeepScanBtn').disabled = state.busy.repair || total === 0;
        document.getElementById('repairZipBtn').disabled = state.busy.repair || validatedCount === 0;

        if (total === 0) {
          listEl.innerHTML = '';
          return;
        }

        listEl.innerHTML = state.repair.items.map((item) => {
          let diagBadgeClass = 'badge';
          if (item.diagStatus === 'healthy') diagBadgeClass = 'badge badge-teal';
          else if (item.diagStatus === 'unsupported') diagBadgeClass = 'badge badge-rose';
          else if (item.diagStatus !== 'scanning') diagBadgeClass = 'badge badge-amber';

          let repairBadge = '';
          if (item.repairStatus === 'working') {
            repairBadge = `<span class="badge badge-blue">SALVAGING...</span>`;
          } else if (['container-repaired', 'stream-remuxed', 're-encoded'].includes(item.repairStatus)) {
            repairBadge = `<span class="badge badge-teal">${escapeHtml(item.repairOutcomeLabel)} · ${formatBytes(item.outBlob.size)}</span>`;
          } else if (item.repairStatus === 'partial-recovery') {
            repairBadge = `<span class="badge badge-amber">${escapeHtml(item.repairOutcomeLabel)} · ${formatBytes(item.outBlob.size)}</span>`;
          } else if (item.repairStatus === 'unvalidated') {
            repairBadge = `<span class="badge badge-amber">OUTPUT COULD NOT BE VALIDATED</span>`;
          } else if (item.repairStatus === 'skipped') {
            repairBadge = `<span class="badge">SKIPPED</span>`;
          } else if (item.repairStatus === 'error') {
            repairBadge = `<span class="badge badge-rose">RECOVERY FAILED: ${escapeHtml(item.error)}</span>`;
          }

          const thumbFallback = item.diagStatus === 'unsupported' ? 'binary' : (item.diagStatus !== 'healthy' && item.diagStatus !== 'scanning' && !item.thumbUrl ? 'broken' : item.kind);
          const canDownload = item.outUrl && ['container-repaired', 'stream-remuxed', 're-encoded', 'partial-recovery', 'unvalidated'].includes(item.repairStatus);

          return `
            <div class="px-card-sm stack-2-5">
              <div class="flex-row flex-wrap justify-between gap-3">
                <div class="flex-row gap-3 min-w-0 flex-1">
                  ${renderThumbMarkup(item.thumbUrl, thumbFallback)}
                  <div class="min-w-0 flex-1">
                    <div class="flex-row flex-wrap gap-1-5">
                      <span class="font-mono-tech ${diagBadgeClass}">${escapeHtml(item.diagLabel)}</span>
                      ${repairBadge}
                      <p class="font-mono-tech truncate" style="margin:0;font-size:0.8125rem;" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</p>
                    </div>
                    <p class="sub-muted font-mono-tech">
                      ${formatBytes(item.file.size)} · ${escapeHtml(item.diagDetail)}
                    </p>
                  </div>
                </div>
                <div class="flex-row gap-2 shrink-0">
                  ${canDownload
                    ? `<a href="${item.outUrl}" download="${escapeHtml(item.outName)}" class="px-btn px-btn-primary font-mono-tech" style="padding:0.35rem 0.65rem;">Download</a>`
                    : ''}
                  <button type="button" data-remove-repair="${item.id}" class="px-btn font-mono-tech" style="padding:0.35rem 0.55rem;" ${state.busy.repair ? 'disabled' : ''}>×</button>
                </div>
              </div>
              ${canDownload && item.outKind === 'audio' ? `<audio controls src="${item.outUrl}" style="width:100%;height:32px;"></audio>` : ''}
              ${canDownload && item.outKind === 'video' ? `<video controls src="${item.outUrl}" style="width:100%;max-height:12rem;background:#000;border:1px solid var(--border-px);border-radius:2px;"></video>` : ''}
            </div>
          `;
        }).join('');
      }

      export async function buildPatchedPhotoBlob(item) {
        let bytes = new Uint8Array(await item.file.arrayBuffer());
        let didPatch = false;

        if (item.patchSpec && item.patchSpec.stripLeading > 0) {
          bytes = bytes.slice(item.patchSpec.stripLeading);
          didPatch = true;
        }

        let end = bytes.length;
        while (end > 8 && bytes[end - 1] === 0x00) end--;
        if (end < bytes.length) {
          bytes = bytes.slice(0, end);
          didPatch = true;
        }

        const sig = detectMagicSignature(bytes.slice(0, 16));
        if (sig.id === 'jpeg' || (item.patchSpec && item.patchSpec.appendJpegEoi)) {
          if (bytes.length >= 2 && !(bytes[bytes.length - 2] === 0xFF && bytes[bytes.length - 1] === 0xD9)) {
            const patched = new Uint8Array(bytes.length + 2);
            patched.set(bytes, 0);
            patched[bytes.length] = 0xFF;
            patched[bytes.length + 1] = 0xD9;
            bytes = patched;
            didPatch = true;
          }
          return { blob: new Blob([bytes], { type: 'image/jpeg' }), didPatch };
        }

        if (sig.id === 'png' || (item.patchSpec && item.patchSpec.appendPngIend)) {
          const iendChunk = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
          const tail = bytes.slice(Math.max(0, bytes.length - 16));
          let hasIend = false;
          for (let i = 0; i <= tail.length - 4; i++) {
            if (tail[i] === 0x49 && tail[i + 1] === 0x45 && tail[i + 2] === 0x4E && tail[i + 3] === 0x44) { hasIend = true; break; }
          }
          if (!hasIend) {
            const patched = new Uint8Array(bytes.length + iendChunk.length);
            patched.set(bytes, 0);
            patched.set(iendChunk, bytes.length);
            bytes = patched;
            didPatch = true;
          }
          return { blob: new Blob([bytes], { type: 'image/png' }), didPatch };
        }

        return { blob: new Blob([bytes], { type: item.file.type || 'application/octet-stream' }), didPatch };
      }

      export async function runRepairDeepScan() {
        if (state.busy.repair || state.repair.items.length === 0) return;
        const scanTargets = state.repair.items.filter((it) => it.diagStatus !== 'unsupported');
        if (scanTargets.length === 0) { showToast('No supported media files to deep scan.', 'warn'); return; }

        state.busy.repair = true;
        state.cancel.repair = false;
        renderRepairQueue();

        try {
        const progBox = document.getElementById('repairProgressBox');
        const statusEl = document.getElementById('repairStatusLabel');
        const pctEl = document.getElementById('repairPctLabel');
        progBox.classList.remove('hidden');

        let ffmpeg = null;
        try {
          ffmpeg = await getFFmpeg((msg, p) => {
            statusEl.textContent = msg;
            pctEl.textContent = `${p}%`;
            setSegmentedProgress('repairSegTrack', p, 'amber');
          });
        } catch (err) {
          const errStr = (err && (err.message || String(err))) || 'Engine failed to initialize';
          showToast(`FFmpeg load failed: ${errStr}`, 'error');
          state.busy.repair = false;
          renderRepairQueue();
          return;
        }

        let foundErrors = 0;
        for (let i = 0; i < scanTargets.length; i++) {
          if (state.cancel.repair) break;
          const item = scanTargets[i];
          const pct = Math.round(((i + 1) / scanTargets.length) * 100);
          statusEl.textContent = `Deep scanning ${i + 1} / ${scanTargets.length}: ${item.file.name}`;
          pctEl.textContent = `${pct}%`;
          setSegmentedProgress('repairSegTrack', pct, 'amber');

          const capturedErrors = [];
          const onLog = ({ message }) => {
            if (!message) return;
            const trimmed = message.trim();
            if (trimmed && !trimmed.startsWith('Aborted(') && !trimmed.startsWith('ffmpeg version')) capturedErrors.push(trimmed);
          };

          try {
            ffmpeg.on('log', onLog);
            await ffmpeg.writeFile('input', new Uint8Array(await item.file.arrayBuffer()));
            await ffmpeg.exec(['-v', 'error', '-i', 'input', '-f', 'null', '-']);

            if (capturedErrors.length > 0) {
              foundErrors++;
              item.diagStatus = 'corrupted';
              item.diagLabel = 'CORRUPTED';
              item.diagDetail = `Deep scan found ${capturedErrors.length} bitstream error(s): ${capturedErrors[0].slice(0, 88)}`;
            } else if (item.diagStatus === 'healthy') {
              item.diagDetail = `${item.diagDetail} · Deep scan: 0 bitstream errors`;
            }
          } catch (err) {
            foundErrors++;
            item.diagStatus = 'corrupted';
            item.diagLabel = 'CORRUPTED';
            const errStr = (err && (err.message || String(err))) || 'Unreadable stream';
            item.diagDetail = `Deep scan decode failure: ${(capturedErrors[0] || errStr).slice(0, 88)}`;
          } finally {
            ffmpeg.off('log', onLog);
            await safeDelete(ffmpeg, 'input');
          }
          renderRepairQueue();
        }

        statusEl.textContent = `Deep scan complete (${foundErrors} file(s) with bitstream errors)`;
        pctEl.textContent = '100%';
        setSegmentedProgress('repairSegTrack', 100, foundErrors > 0 ? 'amber' : 'teal');
        } finally {
          state.busy.repair = false;
          renderRepairQueue();
        }
      }

      export async function runRepairBatch() {
        if (state.busy.repair || state.repair.items.length === 0) return;
        state.busy.repair = true;
        state.cancel.repair = false;
        renderRepairQueue();

        try {
        const progBox = document.getElementById('repairProgressBox');
        const statusEl = document.getElementById('repairStatusLabel');
        const pctEl = document.getElementById('repairPctLabel');
        progBox.classList.remove('hidden');

        const onlyCorrupt = state.repair.scope === 'corrupted';
        const videoFallback = document.getElementById('repairVideoFallback').checked;
        const photoMime = document.getElementById('repairPhotoOutFmt').value;
        const photoExt = photoMime === 'image/png' ? 'png' : photoMime === 'image/webp' ? 'webp' : 'jpg';
        const audioFmt = document.getElementById('repairAudioOutFmt').value;

        const targets = state.repair.items.filter((it) => {
          if (it.diagStatus === 'unsupported') return false;
          return !onlyCorrupt ? true : it.diagStatus !== 'healthy';
        });

        if (targets.length === 0) {
          showToast('No repairable issues queued! Switch to "Rebuild All Queued" to force rebuild.', 'info');
          state.busy.repair = false;
          renderRepairQueue();
          return;
        }

        state.repair.items.forEach((it) => {
          if (it.diagStatus === 'unsupported') it.repairStatus = 'skipped';
          else if (onlyCorrupt && it.diagStatus === 'healthy') it.repairStatus = 'skipped';
        });

        let ffmpeg = null;
        let ok = 0;

        for (let i = 0; i < targets.length; i++) {
          if (state.cancel.repair) {
            showToast('Repair batch cancelled', 'warn');
            break;
          }
          const item = targets[i];
          item.repairStatus = 'working';
          item.error = '';
          if (item.outUrl) { URL.revokeObjectURL(item.outUrl); item.outUrl = null; }
          renderRepairQueue();

          const basePct = Math.round((i / targets.length) * 100);
          statusEl.textContent = `Repairing ${i + 1} / ${targets.length}: ${item.file.name}`;
          pctEl.textContent = `${basePct}%`;
          setSegmentedProgress('repairSegTrack', basePct, 'blue');

          try {
            if (item.kind === 'photo') {
              const wasTruncated = item.diagStatus === 'truncated';
              const { blob: patchedBlob } = await buildPatchedPhotoBlob(item);

              let rebuiltBlob = null;
              try {
                const { blob } = await processPhotoBlob(patchedBlob, photoMime, 100, 'scale:1', null);
                rebuiltBlob = blob;
              } catch (canvasErr) {
                logLine(`Browser photo decode failed for ${item.file.name}; attempting FFmpeg frame salvage...`);
                if (!ffmpeg) {
                  ffmpeg = await getFFmpeg((msg, p) => {
                    statusEl.textContent = msg;
                    pctEl.textContent = `${p}%`;
                    setSegmentedProgress('repairSegTrack', p, 'blue');
                  });
                }
                const outFile = `fixed.${photoExt}`;
                await ffmpeg.writeFile('input', new Uint8Array(await patchedBlob.arrayBuffer()));
                try {
                  await ffmpeg.exec(['-err_detect', 'ignore_err', '-i', 'input', '-frames:v', '1', outFile]);
                  const data = await ffmpeg.readFile(outFile);
                  if (!data || data.length === 0) throw canvasErr;
                  rebuiltBlob = new Blob([data.buffer], { type: photoMime });
                } finally {
                  await safeDelete(ffmpeg, 'input');
                  await safeDelete(ffmpeg, outFile);
                }
              }

              // Post repair validation: verify image actually decodes with non-zero dimensions
              try {
                const bmp = await createImageBitmap(rebuiltBlob);
                const validW = bmp.width;
                const validH = bmp.height;
                if (bmp.close) bmp.close();
                if (validW <= 0 || validH <= 0) throw new Error('Validated 0×0 dimensions');

                item.outBlob = rebuiltBlob;
                item.outUrl = URL.createObjectURL(rebuiltBlob);
                item.outName = `${baseName(item.file.name)}-fixed.${photoExt}`;
                item.outKind = 'photo';
                if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
                item.thumbUrl = URL.createObjectURL(rebuiltBlob);

                if (wasTruncated) {
                  item.repairStatus = 'partial-recovery';
                  item.repairOutcomeLabel = `PARTIAL RECOVERY (${validW}×${validH})`;
                } else {
                  item.repairStatus = 'container-repaired';
                  item.repairOutcomeLabel = `CONTAINER REPAIRED (${validW}×${validH})`;
                }
                ok++;
              } catch (_) {
                item.outBlob = rebuiltBlob;
                item.outUrl = URL.createObjectURL(rebuiltBlob);
                item.outName = `${baseName(item.file.name)}-unvalidated.${photoExt}`;
                item.outKind = 'photo';
                item.repairStatus = 'unvalidated';
              }
            } else if (item.kind === 'video') {
              if (!ffmpeg) {
                ffmpeg = await getFFmpeg((msg, p) => {
                  statusEl.textContent = msg;
                  pctEl.textContent = `${p}%`;
                  setSegmentedProgress('repairSegTrack', p, 'blue');
                });
              }

              const onProg = ({ progress }) => {
                const sub = Math.max(0, Math.min(1, progress || 0));
                const overall = Math.round(((i + sub) / targets.length) * 100);
                statusEl.textContent = `Repairing ${i + 1} / ${targets.length} (${Math.round(sub * 100)}%): ${item.file.name}`;
                pctEl.textContent = `${overall}%`;
                setSegmentedProgress('repairSegTrack', overall, 'blue');
              };

              ffmpeg.on('progress', onProg);
              await ffmpeg.writeFile('input', new Uint8Array(await item.file.arrayBuffer()));
              let outData = null;
              let usedReencode = false;

              try {
                await ffmpeg.exec(['-err_detect', 'ignore_err', '-fflags', '+genpts+igndts', '-i', 'input', '-c', 'copy', '-movflags', '+faststart', 'output.mp4']);
                outData = await ffmpeg.readFile('output.mp4');
                if (!outData || outData.length === 0) throw new Error('Remux produced empty file');
              } catch (remuxErr) {
                if (videoFallback) {
                  usedReencode = true;
                  await safeDelete(ffmpeg, 'output.mp4');
                  await ffmpeg.exec(['-err_detect', 'ignore_err', '-i', 'input', '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', 'output.mp4']);
                  outData = await ffmpeg.readFile('output.mp4');
                  if (!outData || outData.length === 0) throw new Error('Reencode fallback produced empty file');
                } else {
                  throw remuxErr;
                }
              } finally {
                ffmpeg.off('progress', onProg);
                await safeDelete(ffmpeg, 'input');
                await safeDelete(ffmpeg, 'output.mp4');
              }

              const blob = new Blob([outData.buffer], { type: 'video/mp4' });
              const outFileObj = new File([blob], `${baseName(item.file.name)}-fixed.mp4`, { type: 'video/mp4' });
              const valProbe = await probeVideoAndThumb(outFileObj);

              item.outBlob = blob;
              item.outUrl = URL.createObjectURL(blob);
              item.outName = outFileObj.name;
              item.outKind = 'video';

              if (valProbe.ok && valProbe.width > 0 && valProbe.duration > 0) {
                if (valProbe.thumbUrl) {
                  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
                  item.thumbUrl = valProbe.thumbUrl;
                }
                if (usedReencode) {
                  item.repairStatus = 're-encoded';
                  item.repairOutcomeLabel = `REENCODED SUCCESSFULLY (${valProbe.width}×${valProbe.height} · ${valProbe.duration.toFixed(1)}s)`;
                } else {
                  item.repairStatus = 'stream-remuxed';
                  item.repairOutcomeLabel = `STREAM REMUXED (${valProbe.width}×${valProbe.height} · ${valProbe.duration.toFixed(1)}s)`;
                }
                ok++;
              } else {
                item.repairStatus = 'unvalidated';
              }
            } else {
              // Audio repair
              if (!ffmpeg) {
                ffmpeg = await getFFmpeg((msg, p) => {
                  statusEl.textContent = msg;
                  pctEl.textContent = `${p}%`;
                  setSegmentedProgress('repairSegTrack', p, 'blue');
                });
              }

              const outName = `fixed.${audioFmt}`;
              const args = ['-err_detect', 'ignore_err', '-i', 'input', '-vn'];
              if (audioFmt === 'flac') args.push('-c:a', 'flac', '-compression_level', '8');
              else if (audioFmt === 'wav') args.push('-c:a', 'pcm_s24le');
              else args.push('-c:a', 'libmp3lame', '-b:a', '320k', '-q:a', '0');
              args.push(outName);

              await ffmpeg.writeFile('input', new Uint8Array(await item.file.arrayBuffer()));
              let outData = null;
              try {
                await ffmpeg.exec(args);
                outData = await ffmpeg.readFile(outName);
                if (!outData || outData.length === 0) throw new Error('Audio salvage produced empty output');
              } finally {
                await safeDelete(ffmpeg, 'input');
                await safeDelete(ffmpeg, outName);
              }

              const blob = new Blob([outData.buffer], { type: AUDIO_MIMES[audioFmt] || 'audio/flac' });
              const outFileObj = new File([blob], `${baseName(item.file.name)}-fixed.${audioFmt}`, { type: blob.type });
              const valProbe = await probeAudioMetadata(outFileObj);

              item.outBlob = blob;
              item.outUrl = URL.createObjectURL(blob);
              item.outName = outFileObj.name;
              item.outKind = 'audio';

              if (valProbe.ok && valProbe.duration > 0) {
                item.repairStatus = 're-encoded';
                item.repairOutcomeLabel = `REENCODED SUCCESSFULLY (${valProbe.duration.toFixed(1)}s)`;
                ok++;
              } else {
                item.repairStatus = 'unvalidated';
              }
            }
          } catch (err) {
            item.repairStatus = 'error';
            const errStr = (err && (err.message || String(err))) || 'Unrecoverable';
            item.error = errStr.slice(0, 64);
            logLine(`Repair error (${item.file.name}): ${errStr}`);
          }

          renderRepairQueue();
        }

        statusEl.textContent = state.cancel.repair ? `Cancelled (${ok} validated)` : `Validated ${ok} / ${targets.length} repaired file(s)`;
        pctEl.textContent = '100%';
        setSegmentedProgress('repairSegTrack', 100, ok > 0 ? 'teal' : 'amber');
        if (!state.cancel.repair) showToast(`Validated ${ok} / ${targets.length} repaired file(s)`, ok > 0 ? 'success' : 'warn');

        } finally {
          state.busy.repair = false;
          renderRepairQueue();
        }
      }

      


export const downloadRepairZip = () => exportZipBundle(state.repair.items, 'swissfile_repaired', state.repair);


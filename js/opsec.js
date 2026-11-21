import { state, uid, nextId, SVG_VIDEO, SVG_AUDIO, SVG_LOCK, SVG_BINARY } from './state.js';
import {
  $, $$, escapeHtml, formatBytes, baseName, extOf, checkFileSizeGuardrail,
  showToast, logLine, setSegmentedProgress, renderThumbMarkup,
  isImageFile, isVideoFile, isAudioFile, probeVideoAndThumb, exportZipBundle
} from './dom.js';
import { ensureDependency } from './vendors.js';
import {
  bytesToHex, inspectImageBinaryMetadataSegments, stripMetadataLosslessBinary, detectMagicSignature
} from './binary.js';
import { processPhotoBlob } from './photo-video-audio.js';

export async function scanScrubRisk(item) {
        const segScan = await inspectImageBinaryMetadataSegments(item.file);
        await ensureDependency('exifr', () => Boolean(window.exifr));

        let exifrCount = 0;
        let hasGps = false;
        try {
          if (window.exifr) {
            const meta = await window.exifr.parse(item.file, { tiff: true, exif: true, gps: true, iptc: true, xmp: true, icc: true });
            if (meta && typeof meta === 'object') {
              exifrCount = Object.keys(meta).length;
              hasGps = typeof meta.latitude === 'number' && typeof meta.longitude === 'number';
            }
          }
        } catch (_) {}

        const segCount = segScan.segments.length;
        if (hasGps) {
          item.riskStatus = 'high';
          item.riskText = `GPS COORDS + ${exifrCount} tags / ${segCount} metadata segment(s)`;
        } else if (exifrCount > 0 || segCount > 0) {
          item.riskStatus = 'warn';
          item.riskText = `${exifrCount} tag(s) · ${segCount} metadata segment(s) detected`;
        } else {
          item.riskStatus = 'low';
          item.riskText = '0 EXIF tags / 0 metadata segments detected';
        }
      }

      export async function addScrubFiles(files) {
        const added = [];
        for (const f of files) {
          if (!checkFileSizeGuardrail(f, false)) continue;
          const head16 = new Uint8Array(await f.slice(0, 16).arrayBuffer());
          const sig = detectMagicSignature(head16);
          if (!['jpeg', 'png', 'webp'].includes(sig.id)) {
            showToast(`Rejected ${f.name}: Image Metadata Scrubber supports JPEG, PNG, and WebP only.`, 'warn');
            continue;
          }

          const item = {
            id: nextId(),
            file: f,
            sigId: sig.id,
            thumbUrl: URL.createObjectURL(f),
            riskStatus: 'scanning',
            riskText: 'Scanning metadata segments...',
            status: 'queued',
            verifyState: 'pending',
            verifyText: '',
            methodLabel: '',
            outBlob: null,
            outUrl: null,
            outName: '',
            error: '',
          };
          state.opsec.scrubItems.push(item);
          added.push(item);
        }
        renderScrubQueue();

        for (const item of added) {
          await scanScrubRisk(item);
          renderScrubQueue();
        }
      }

      export function removeScrubItem(id) {
        const idx = state.opsec.scrubItems.findIndex((x) => x.id === id);
        if (idx === -1) return;
        const [rm] = state.opsec.scrubItems.splice(idx, 1);
        if (rm.thumbUrl) URL.revokeObjectURL(rm.thumbUrl);
        if (rm.outUrl) URL.revokeObjectURL(rm.outUrl);
        renderScrubQueue();
      }

      export function clearScrubQueue() {
        state.opsec.scrubItems.forEach((it) => {
          if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
          if (it.outUrl) URL.revokeObjectURL(it.outUrl);
        });
        if (state.opsec.scrubZipUrl) { URL.revokeObjectURL(state.opsec.scrubZipUrl); state.opsec.scrubZipUrl = null; }
        state.opsec.scrubItems = [];
        document.getElementById('scrubProgressBox').classList.add('hidden');
        renderScrubQueue();
      }

      export function renderScrubQueue() {
        const listEl = document.getElementById('scrubQueueList');
        const total = state.opsec.scrubItems.length;
        const doneCount = state.opsec.scrubItems.filter((x) => x.status === 'done' && x.outBlob).length;

        document.getElementById('scrubQueueCount').textContent = `Scans EXIF/XMP/IPTC/ICC/COM segments before & after · ${total} queued`;
        document.getElementById('scrubRunBtn').disabled = state.busy.scrub || total === 0;
        document.getElementById('scrubCancelBtn').classList.toggle('hidden', !state.busy.scrub);
        document.getElementById('scrubZipBtn').disabled = state.busy.scrub || doneCount === 0;

        if (total === 0) {
          listEl.innerHTML = '';
          return;
        }

        listEl.innerHTML = state.opsec.scrubItems.map((item) => {
          let riskCls = 'var(--text-muted)';
          if (item.riskStatus === 'high') riskCls = 'var(--rose)';
          else if (item.riskStatus === 'warn') riskCls = 'var(--amber)';
          else if (item.riskStatus === 'low') riskCls = 'var(--teal)';

          let statusLine = `<span style="color:${riskCls};">${escapeHtml(item.riskText)}</span>`;
          let verifyBadge = '';

          if (item.status === 'working') {
            statusLine = `<span style="color:var(--accent-hi);">Sanitizing &amp; verifying...</span>`;
          } else if (item.status === 'done') {
            statusLine = `<span style="color:var(--text-muted);">${escapeHtml(item.methodLabel)} · ${formatBytes(item.outBlob.size)} · ${escapeHtml(item.verifyText)}</span>`;
            if (item.verifyState === 'verified-clean') verifyBadge = `<span class="badge badge-teal font-mono-tech">VERIFIED CLEAN</span>`;
            else if (item.verifyState === 'metadata-remaining') verifyBadge = `<span class="badge badge-rose font-mono-tech">METADATA REMAINING</span>`;
            else if (item.verifyState === 'verification-failed') verifyBadge = `<span class="badge badge-amber font-mono-tech">VERIFICATION FAILED</span>`;
            else verifyBadge = `<span class="badge badge-amber font-mono-tech">VERIFICATION UNAVAILABLE</span>`;
          } else if (item.status === 'error') {
            statusLine = `<span style="color:var(--rose);">ERR: ${escapeHtml(item.error)}</span>`;
          }

          return `
            <div class="px-card-sm flex-row flex-wrap justify-between gap-2-5">
              <div class="flex-row gap-2-5 min-w-0 flex-1">
                ${renderThumbMarkup(item.thumbUrl, 'photo')}
                <div class="min-w-0 flex-1">
                  <div class="flex-row flex-wrap gap-1-5">
                    ${verifyBadge}
                    <p class="font-mono-tech truncate" style="margin:0;font-size:0.75rem;" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</p>
                  </div>
                  <p class="sub-muted font-mono-tech">${formatBytes(item.file.size)} · ${statusLine}</p>
                </div>
              </div>
              <div class="flex-row gap-1-5 shrink-0">
                ${item.status === 'done' && item.outUrl
                  ? `<a href="${item.outUrl}" download="${escapeHtml(item.outName)}" class="px-btn px-btn-primary font-mono-tech" style="padding:0.25rem 0.55rem;font-size:0.6875rem;">Save</a>`
                  : ''}
                <button type="button" data-remove-scrub="${item.id}" class="px-btn font-mono-tech" style="padding:0.25rem 0.5rem;" ${state.busy.scrub ? 'disabled' : ''}>×</button>
              </div>
            </div>
          `;
        }).join('');
      }

      export async function verifyScrubbedOutput(blob) {
        const segScan = await inspectImageBinaryMetadataSegments(blob);
        if (!['jpeg', 'png', 'webp'].includes(segScan.format)) {
          return { state: 'verification-unavailable', text: 'Unsupported verifier format' };
        }

        const hasExifr = await ensureDependency('exifr', () => Boolean(window.exifr));
        if (!hasExifr || !window.exifr) {
          if (segScan.segments.length > 0) {
            return { state: 'metadata-remaining', text: `${segScan.segments.length} binary metadata segment(s) remain` };
          }
          return { state: 'verification-unavailable', text: 'Binary segments clean; exifr parser unavailable' };
        }

        try {
          const postMeta = await window.exifr.parse(blob, {
            tiff: true, ifd0: true, exif: true, gps: true, interop: true, ifd1: true, iptc: true, xmp: true, icc: true,
          });
          const tagCount = postMeta && typeof postMeta === 'object' ? Object.keys(postMeta).length : 0;
          const segCount = segScan.segments.length;

          if (tagCount > 0 || segCount > 0) {
            return {
              state: 'metadata-remaining',
              text: `${tagCount} tag(s) & ${segCount} metadata segment(s) still detected`,
            };
          }
          return {
            state: 'verified-clean',
            text: '0 metadata segments & 0 EXIF/XMP/IPTC/ICC tags detected',
          };
        } catch (err) {
          return {
            state: 'verification-failed',
            text: `Post scrub parser threw error: ${(err && err.message) || 'Unknown parse error'}`,
          };
        }
      }

      export async function runBulkScrub() {
        if (state.busy.scrub || state.opsec.scrubItems.length === 0) return;
        state.busy.scrub = true;
        state.cancel.scrub = false;
        renderScrubQueue();

        try {
        const progBox = document.getElementById('scrubProgressBox');
        const statusEl = document.getElementById('scrubStatusLabel');
        const pctEl = document.getElementById('scrubPctLabel');
        progBox.classList.remove('hidden');

        const modeChoice = document.getElementById('scrubModeSelect').value;
        const fmtChoice = document.getElementById('scrubFormatSelect').value;
        let ok = 0;
        let idx = 0;

        while (idx < state.opsec.scrubItems.length) {
          if (state.cancel.scrub) {
            showToast('Scrub batch cancelled', 'warn');
            break;
          }
          const item = state.opsec.scrubItems[idx];
          if (!item) break;
          item.status = 'working';
          item.error = '';
          if (item.outUrl) { URL.revokeObjectURL(item.outUrl); item.outUrl = null; }
          renderScrubQueue();

          const total = state.opsec.scrubItems.length;
          const pct = Math.round(((idx + 1) / total) * 100);
          statusEl.textContent = `Scrubbing ${idx + 1} / ${total}: ${item.file.name}`;
          pctEl.textContent = `${pct}%`;
          setSegmentedProgress('scrubSegTrack', pct, 'blue');

          try {
            let outBlob = null;
            let outExt = 'jpg';
            let methodLabel = '';

            if (modeChoice === 'lossless-bin' && (item.sigId === 'jpeg' || item.sigId === 'png')) {
              const res = await stripMetadataLosslessBinary(item.file);
              outBlob = res.blob;
              outExt = res.ext;
              methodLabel = `${res.method} (removed ${res.strippedCount} segment(s))`;
            } else {
              let mime = fmtChoice;
              if (fmtChoice === 'auto') {
                if (item.sigId === 'png') mime = 'image/png';
                else if (item.sigId === 'webp') mime = 'image/webp';
                else mime = 'image/jpeg';
              }
              outExt = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
              const { blob } = await processPhotoBlob(item.file, mime, 100, 'scale:1', null);
              outBlob = blob;
              methodLabel = mime === 'image/png' ? 'Canvas PNG Redraw' : `Canvas ${outExt.toUpperCase()} Redraw (Q100)`;
            }

            const verification = await verifyScrubbedOutput(outBlob);
            item.outBlob = outBlob;
            item.outUrl = URL.createObjectURL(outBlob);
            item.outName = `${baseName(item.file.name)}-clean.${outExt}`;
            item.methodLabel = methodLabel;
            item.verifyState = verification.state;
            item.verifyText = verification.text;
            item.status = 'done';
            ok++;
          } catch (err) {
            item.status = 'error';
            item.error = err.message || 'Scrub failed';
            logLine(`Scrub error (${item.file.name}): ${item.error}`);
          }
          renderScrubQueue();
          idx++;
        }

        statusEl.textContent = state.cancel.scrub ? `Cancelled (${ok} processed)` : `Processed ${ok} / ${state.opsec.scrubItems.length} image(s)`;
        pctEl.textContent = '100%';
        setSegmentedProgress('scrubSegTrack', 100, 'teal');
        if (ok > 0 && !state.cancel.scrub) showToast(`Processed ${ok} image(s), inspect verification badges`, 'success');

        } finally {
          state.busy.scrub = false;
          renderScrubQueue();
        }
      }

      

      export const LOCKER_MAGIC_V3 = new Uint8Array([0x53, 0x57, 0x49, 0x53, 0x53, 0x4C, 0x4B, 0x33]); // SWISSLK3
      export const LOCKER_MAGIC_V2 = new Uint8Array([0x53, 0x57, 0x4C, 0x4B, 0x30, 0x32, 0x00, 0x00]); // SWLK02\0\0
      export const LOCKER_MAGIC_V1 = new Uint8Array([0x53, 0x57, 0x4C, 0x4B, 0x30, 0x31, 0x00, 0x00]); // SWLK01\0\0
      const LOCKER_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MB chunks
      const LOCKER_V3_ITERS = 600000;

      export function evaluatePassphraseStrength(pass) {
        if (!pass) return { label: 'None', hint: '', color: 'var(--text-muted)', weak: true };
        let pool = 0;
        if (/[a-z]/.test(pass)) pool += 26;
        if (/[A-Z]/.test(pass)) pool += 26;
        if (/[0-9]/.test(pass)) pool += 10;
        if (/[^a-zA-Z0-9]/.test(pass)) pool += 32;
        const entropy = Math.round(pass.length * Math.log2(Math.max(1, pool)));
        if (pass.length < 8 || entropy < 45) {
          return { label: `WEAK (~${entropy} bits)`, hint: 'Vulnerable to offline guessing, use 12 or more mixed chars', color: 'var(--rose)', weak: true };
        }
        if (pass.length < 12 || entropy < 68) {
          return { label: `MODERATE (~${entropy} bits)`, hint: 'Acceptable; 14+ chars recommended for sensitive files', color: 'var(--amber)', weak: false };
        }
        return { label: `STRONG (~${entropy} bits)`, hint: '600k PBKDF2 SHA256 iterations', color: 'var(--teal)', weak: false };
      }

      export async function deriveAesKey(password, salt, iterations) {
        const passBytes = new TextEncoder().encode(password);
        const keyMaterial = await crypto.subtle.importKey('raw', passBytes, 'PBKDF2', false, ['deriveKey']);
        passBytes.fill(0);
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
          keyMaterial,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
      }

      export function deriveChunkIv(baseIv, chunkIndex) {
        const iv = new Uint8Array(12);
        iv.set(baseIv, 0);
        const dv = new DataView(iv.buffer);
        const hi = Math.floor(chunkIndex / 0x100000000) >>> 0;
        const lo = chunkIndex >>> 0;
        dv.setUint32(4, (dv.getUint32(4, false) ^ hi) >>> 0, false);
        dv.setUint32(8, (dv.getUint32(8, false) ^ lo) >>> 0, false);
        return iv;
      }

      export function buildChunkAad(headerBytes, chunkIndex, isFinal) {
        const aad = new Uint8Array(headerBytes.length + 5);
        aad.set(headerBytes, 0);
        const dv = new DataView(aad.buffer);
        dv.setUint32(headerBytes.length, chunkIndex >>> 0, false);
        aad[headerBytes.length + 4] = isFinal ? 1 : 0;
        return aad;
      }

      export function handleLockerFile(file) {
        if (!file) return;
        if (state.opsec.lockerThumbUrl) { URL.revokeObjectURL(state.opsec.lockerThumbUrl); state.opsec.lockerThumbUrl = null; }
        if (state.opsec.lockerOutUrl) { URL.revokeObjectURL(state.opsec.lockerOutUrl); state.opsec.lockerOutUrl = null; }
        document.getElementById('lockerDownloadSlot').innerHTML = '';
        state.opsec.lockerFile = file;

        document.getElementById('lockerFileCard').classList.remove('hidden');
        document.getElementById('lockerFileName').textContent = file.name;
        document.getElementById('lockerFileSize').textContent = formatBytes(file.size);

        const slot = document.getElementById('lockerThumbSlot');
        if (extOf(file.name) === 'swisslock') slot.innerHTML = SVG_LOCK;
        else if (isImageFile(file)) {
          state.opsec.lockerThumbUrl = URL.createObjectURL(file);
          slot.innerHTML = `<img src="${state.opsec.lockerThumbUrl}" alt="" />`;
        } else if (isVideoFile(file)) {
          slot.innerHTML = SVG_VIDEO;
          probeVideoAndThumb(file).then((info) => {
            if (info.thumbUrl && state.opsec.lockerFile === file) {
              state.opsec.lockerThumbUrl = info.thumbUrl;
              slot.innerHTML = `<img src="${info.thumbUrl}" alt="" />`;
            } else if (info.thumbUrl) URL.revokeObjectURL(info.thumbUrl);
          });
        } else if (isAudioFile(file)) slot.innerHTML = SVG_AUDIO;
        else slot.innerHTML = SVG_BINARY;

        document.getElementById('lockerEncryptBtn').disabled = false;
        document.getElementById('lockerDecryptBtn').disabled = false;
      }

      export async function encryptLockerFile() {
        const file = state.opsec.lockerFile;
        const passInput = document.getElementById('lockerPassword');
        const pass = passInput.value;
        if (!file) return;
        if (!pass) { showToast('Enter a passphrase first', 'warn'); return; }

        const strength = evaluatePassphraseStrength(pass);
        if (strength.weak) {
          showToast('Warning: Weak passphrase used, consider 12 or more mixed characters.', 'warn');
        }

        const encBtn = document.getElementById('lockerEncryptBtn');
        const decBtn = document.getElementById('lockerDecryptBtn');
        encBtn.disabled = true;
        decBtn.disabled = true;

        const progBox = document.getElementById('lockerProgressBox');
        const progLabel = document.getElementById('lockerProgLabel');
        const progPct = document.getElementById('lockerProgPct');
        progBox.classList.remove('hidden');

        try {
          progLabel.textContent = 'Deriving AES-256-GCM key (600,000 PBKDF2 iterations)...';
          progPct.textContent = '5%';
          setSegmentedProgress('lockerSegTrack', 5, 'blue');

          const salt = crypto.getRandomValues(new Uint8Array(16));
          const baseIv = crypto.getRandomValues(new Uint8Array(12));
          const key = await deriveAesKey(pass, salt, LOCKER_V3_ITERS);
          passInput.value = '';
          updatePassphraseMeter();

          const payloadChunks = Math.max(1, Math.ceil(file.size / LOCKER_CHUNK_BYTES));
          const totalChunks = 1 + payloadChunks;

          const header = new Uint8Array(48);
          header.set(LOCKER_MAGIC_V3, 0);
          const hView = new DataView(header.buffer);
          hView.setUint32(8, LOCKER_V3_ITERS, false);
          header.set(salt, 12);
          header.set(baseIv, 28);
          hView.setUint32(40, LOCKER_CHUNK_BYTES, false);
          hView.setUint32(44, totalChunks, false);

          const blobParts = [header];

          // Chunk 0: UTF-8 filename metadata
          const nameBytes = new TextEncoder().encode(file.name);
          if (nameBytes.length > 4096) throw new Error('Filename exceeds 4096-byte container limit');
          const c0Cipher = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: deriveChunkIv(baseIv, 0), additionalData: buildChunkAad(header, 0, totalChunks === 1) },
            key,
            nameBytes
          ));
          const c0LenBuf = new Uint8Array(4);
          new DataView(c0LenBuf.buffer).setUint32(0, c0Cipher.length, false);
          blobParts.push(c0LenBuf, c0Cipher);

          // Chunks 1..N: 4 MB payload slices
          for (let c = 0; c < payloadChunks; c++) {
            const chunkIdx = c + 1;
            const start = c * LOCKER_CHUNK_BYTES;
            const end = Math.min(file.size, start + LOCKER_CHUNK_BYTES);
            const sliceBytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
            const isFinal = chunkIdx === totalChunks - 1;

            const cipherChunk = new Uint8Array(await crypto.subtle.encrypt(
              { name: 'AES-GCM', iv: deriveChunkIv(baseIv, chunkIdx), additionalData: buildChunkAad(header, chunkIdx, isFinal) },
              key,
              sliceBytes
            ));
            sliceBytes.fill(0);

            const lenBuf = new Uint8Array(4);
            new DataView(lenBuf.buffer).setUint32(0, cipherChunk.length, false);
            blobParts.push(lenBuf, cipherChunk);

            const pct = Math.round(((chunkIdx + 1) / totalChunks) * 100);
            progLabel.textContent = `Encrypting chunk ${chunkIdx} / ${payloadChunks}...`;
            progPct.textContent = `${pct}%`;
            setSegmentedProgress('lockerSegTrack', pct, 'blue');
          }

          salt.fill(0);
          baseIv.fill(0);

          const outBlob = new Blob(blobParts, { type: 'application/octet-stream' });
          if (state.opsec.lockerOutUrl) URL.revokeObjectURL(state.opsec.lockerOutUrl);
          state.opsec.lockerOutUrl = URL.createObjectURL(outBlob);

          const outName = `${baseName(file.name)}.swisslock`;
          progLabel.textContent = 'Encrypted & authenticated';
          progPct.textContent = '100%';
          setSegmentedProgress('lockerSegTrack', 100, 'teal');

          document.getElementById('lockerStatusText').textContent =
            `Encrypted (${formatBytes(outBlob.size)}) → ${outName} (${payloadChunks} authenticated 4 MB chunk(s); passphrase cleared from field)`;
          document.getElementById('lockerStatusText').style.color = 'var(--teal)';
          document.getElementById('lockerDownloadSlot').innerHTML =
            `<a href="${state.opsec.lockerOutUrl}" download="${escapeHtml(outName)}" class="px-btn px-btn-primary font-mono-tech">Download ${escapeHtml(outName)}</a>`;
          showToast(`Encrypted ${file.name} (SWISSLK3)`, 'success');
        } catch (err) {
          document.getElementById('lockerStatusText').textContent = `Encryption error: ${err.message}`;
          document.getElementById('lockerStatusText').style.color = 'var(--rose)';
          showToast(`Encryption failed: ${err.message}`, 'error');
        } finally {
          encBtn.disabled = false;
          decBtn.disabled = false;
        }
      }

      export async function decryptLockerFile() {
        const file = state.opsec.lockerFile;
        const passInput = document.getElementById('lockerPassword');
        const pass = passInput.value;
        if (!file) return;
        if (!pass) { showToast('Enter passphrase to unlock', 'warn'); return; }

        const encBtn = document.getElementById('lockerEncryptBtn');
        const decBtn = document.getElementById('lockerDecryptBtn');
        encBtn.disabled = true;
        decBtn.disabled = true;

        const progBox = document.getElementById('lockerProgressBox');
        const progLabel = document.getElementById('lockerProgLabel');
        const progPct = document.getElementById('lockerProgPct');
        progBox.classList.remove('hidden');

        try {
          if (file.size < 38) throw new Error('Container too small (< 38 bytes) to be a valid .swisslock file');
          const magic = new Uint8Array(await file.slice(0, 8).arrayBuffer());

          const isV3 = LOCKER_MAGIC_V3.every((v, i) => magic[i] === v);
          const isV2 = LOCKER_MAGIC_V2.every((v, i) => magic[i] === v);
          const isV1 = LOCKER_MAGIC_V1.every((v, i) => magic[i] === v);

          if (!isV3 && !isV2 && !isV1) {
            throw new Error('Unrecognized container magic bytes (expected SWISSLK3, SWLK02, or SWLK01)');
          }

          if (isV3) {
            if (file.size < 48) throw new Error('Truncated SWISSLK3 header (< 48 bytes)');
            const header = new Uint8Array(await file.slice(0, 48).arrayBuffer());
            const hView = new DataView(header.buffer);
            const iterations = hView.getUint32(8, false);
            if (iterations < 10000 || iterations > 10000000) throw new Error(`Invalid PBKDF2 iteration count in header (${iterations})`);
            const salt = header.slice(12, 28);
            const baseIv = header.slice(28, 40);
            const chunkSize = hView.getUint32(40, false);
            const totalChunks = hView.getUint32(44, false);
            if (chunkSize === 0 || chunkSize > 64 * 1024 * 1024 || totalChunks < 2) {
              throw new Error('Malformed SWISSLK3 chunk geometry in header');
            }

            progLabel.textContent = `Deriving key (${iterations.toLocaleString()} PBKDF2 iterations)...`;
            progPct.textContent = '5%';
            setSegmentedProgress('lockerSegTrack', 5, 'blue');

            const key = await deriveAesKey(pass, salt, iterations);
            let pos = 48;
            let origName = 'unlocked-file';
            const plainParts = [];

            for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
              if (pos + 4 > file.size) throw new Error(`Truncated container at chunk ${chunkIdx} length prefix`);
              const lenBytes = new Uint8Array(await file.slice(pos, pos + 4).arrayBuffer());
              const cipherLen = new DataView(lenBytes.buffer).getUint32(0, false);
              pos += 4;

              if (cipherLen < 16 || cipherLen > chunkSize + 1024 || pos + cipherLen > file.size) {
                throw new Error(`Corrupted or truncated chunk ${chunkIdx} (declared ${cipherLen} bytes)`);
              }

              const cipherChunk = new Uint8Array(await file.slice(pos, pos + cipherLen).arrayBuffer());
              pos += cipherLen;
              const isFinal = chunkIdx === totalChunks - 1;

              const plainChunk = new Uint8Array(await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: deriveChunkIv(baseIv, chunkIdx), additionalData: buildChunkAad(header, chunkIdx, isFinal) },
                key,
                cipherChunk
              ));

              if (chunkIdx === 0) {
                if (plainChunk.length > 4096) throw new Error('Invalid decrypted filename length (> 4096 bytes)');
                origName = new TextDecoder().decode(plainChunk) || 'unlocked-file';
              } else {
                plainParts.push(plainChunk);
              }

              const pct = Math.round(((chunkIdx + 1) / totalChunks) * 100);
              progLabel.textContent = `Decrypting & verifying chunk ${chunkIdx + 1} / ${totalChunks}...`;
              progPct.textContent = `${pct}%`;
              setSegmentedProgress('lockerSegTrack', pct, 'blue');
            }

            if (pos !== file.size) {
              throw new Error(`Trailing unauthenticated bytes detected (${file.size - pos} extra bytes)`);
            }

            passInput.value = '';
            updatePassphraseMeter();

            const outBlob = new Blob(plainParts, { type: 'application/octet-stream' });
            if (state.opsec.lockerOutUrl) URL.revokeObjectURL(state.opsec.lockerOutUrl);
            state.opsec.lockerOutUrl = URL.createObjectURL(outBlob);

            progLabel.textContent = 'Decrypted & authenticated';
            progPct.textContent = '100%';
            setSegmentedProgress('lockerSegTrack', 100, 'teal');

            document.getElementById('lockerStatusText').textContent =
              `Decrypted & restored (${formatBytes(outBlob.size)}) → ${origName} (SWISSLK3 verified)`;
            document.getElementById('lockerStatusText').style.color = 'var(--teal)';
            document.getElementById('lockerDownloadSlot').innerHTML =
              `<a href="${state.opsec.lockerOutUrl}" download="${escapeHtml(origName)}" class="px-btn px-btn-primary font-mono-tech">Download ${escapeHtml(origName)}</a>`;
            showToast(`Unlocked ${origName}`, 'success');
          } else {
            // Legacy SWLK02 & SWLK01 backward compatibility (100,000 iterations)
            const bytes = new Uint8Array(await file.arrayBuffer());
            const salt = bytes.slice(8, 24);
            const iv = bytes.slice(24, 36);
            const key = await deriveAesKey(pass, salt, 100000);
            let origName = 'unlocked-file';
            let plainPayload = null;

            if (isV2) {
              const cipherBytes = bytes.slice(36);
              if (cipherBytes.length < 18) throw new Error('Truncated SWLK02 payload');
              const inner = new Uint8Array(await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv, additionalData: LOCKER_MAGIC_V2 },
                key,
                cipherBytes
              ));
              const nameLen = new DataView(inner.buffer, inner.byteOffset, 2).getUint16(0, false);
              if (nameLen > 4096 || 2 + nameLen > inner.length) throw new Error('Invalid SWLK02 filename boundary');
              origName = new TextDecoder().decode(inner.slice(2, 2 + nameLen)) || 'unlocked-file';
              plainPayload = inner.slice(2 + nameLen);
            } else {
              const nameLen = new DataView(bytes.buffer, bytes.byteOffset + 36, 2).getUint16(0, false);
              if (nameLen > 4096 || 38 + nameLen + 16 > bytes.length) throw new Error('Invalid SWLK01 header boundary');
              const nameBytes = bytes.slice(38, 38 + nameLen);
              origName = new TextDecoder().decode(nameBytes) || 'unlocked-file';
              const cipherBytes = bytes.slice(38 + nameLen);
              plainPayload = new Uint8Array(await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv, additionalData: nameBytes },
                key,
                cipherBytes
              ));
            }

            passInput.value = '';
            updatePassphraseMeter();

            const outBlob = new Blob([plainPayload], { type: 'application/octet-stream' });
            if (state.opsec.lockerOutUrl) URL.revokeObjectURL(state.opsec.lockerOutUrl);
            state.opsec.lockerOutUrl = URL.createObjectURL(outBlob);

            progLabel.textContent = 'Legacy container decrypted';
            progPct.textContent = '100%';
            setSegmentedProgress('lockerSegTrack', 100, 'teal');

            document.getElementById('lockerStatusText').textContent =
              `Decrypted legacy ${isV2 ? 'SWLK02' : 'SWLK01'} (${formatBytes(outBlob.size)}) → ${origName}`;
            document.getElementById('lockerStatusText').style.color = 'var(--teal)';
            document.getElementById('lockerDownloadSlot').innerHTML =
              `<a href="${state.opsec.lockerOutUrl}" download="${escapeHtml(origName)}" class="px-btn px-btn-primary font-mono-tech">Download ${escapeHtml(origName)}</a>`;
            showToast(`Unlocked legacy ${origName}`, 'success');
          }
        } catch (err) {
          progLabel.textContent = 'Authentication / Validation Failed';
          progPct.textContent = '0%';
          setSegmentedProgress('lockerSegTrack', 0, 'amber');
          const msg = err && err.name === 'OperationError'
            ? 'Authentication failed: wrong passphrase or tampered container.'
            : (err.message || 'Decryption failed');
          document.getElementById('lockerStatusText').textContent = msg;
          document.getElementById('lockerStatusText').style.color = 'var(--rose)';
          showToast(msg, 'error');
          logLine(`Locker decrypt error: ${msg}`);
        } finally {
          encBtn.disabled = false;
          decBtn.disabled = false;
        }
      }

      export function updatePassphraseMeter() {
        const val = document.getElementById('lockerPassword').value;
        const st = evaluatePassphraseStrength(val);
        const lbl = document.getElementById('lockerStrengthLabel');
        const hint = document.getElementById('lockerStrengthHint');
        lbl.textContent = `Passphrase strength: ${st.label}`;
        lbl.style.color = st.color;
        hint.textContent = st.hint;
      }

      

export const downloadScrubZip = () => exportZipBundle(state.opsec.scrubItems, 'swissfile_scrubbed', state.opsec, 'scrubZipUrl');


import { state, uid, nextId, SVG_VIDEO, SVG_AUDIO, SVG_LOCK, SVG_BINARY } from './state.js';
import {
  $, $$, escapeHtml, formatBytes, baseName, extOf, checkFileSizeGuardrail,
  showToast, logLine, setSegmentedProgress, renderThumbMarkup,
  copyToClipboard, isImageFile, isVideoFile, isAudioFile,
  probeVideoAndThumb, probeAudioMetadata
} from './dom.js';
import { ensureDependency, getFFmpeg, safeDelete } from './vendors.js';
import {
  bytesToHex, bytesToAscii, detectMagicSignature,
  inspectImageBinaryMetadataSegments, parseIsoBmffHeader
} from './binary.js';
import { decodeImageSource } from './photo-video-audio.js';

export function formatTagValue(val) {
        if (val === null || val === undefined) return 'None';
        if (val instanceof Date) {
          return Number.isNaN(val.getTime()) ? String(val) : val.toISOString().replace('T', ' ').slice(0, 23) + ' UTC';
        }
        if (val instanceof Uint8Array || val instanceof ArrayBuffer) {
          const arr = val instanceof Uint8Array ? val : new Uint8Array(val);
          const preview = bytesToHex(arr.slice(0, 16));
          return `[Binary ${arr.length} bytes: ${preview}${arr.length > 16 ? ' ...' : ''}]`;
        }
        if (Array.isArray(val)) {
          if (val.length > 24) return `[Array(${val.length}): ${val.slice(0, 12).join(', ')}, ...]`;
          return val.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
        }
        if (typeof val === 'object') {
          try { return JSON.stringify(val); } catch (_) { return String(val); }
        }
        return String(val);
      }

      export async function extractMediaMetadata(file) {
        const flatTags = [];
        const groups = {};
        const pushTag = (group, key, rawVal) => {
          if (rawVal === undefined || rawVal === null || rawVal === '') return;
          const value = formatTagValue(rawVal);
          flatTags.push({ group, key, value });
          groups[group] = (groups[group] || 0) + 1;
        };

        const head16 = new Uint8Array(await file.slice(0, 16).arrayBuffer());
        const sig = detectMagicSignature(head16);
        pushTag('FILE', 'FileName', file.name);
        pushTag('FILE', 'FileSizeBytes', `${file.size} (${formatBytes(file.size)})`);
        pushTag('FILE', 'LastModified', file.lastModified ? new Date(file.lastModified) : 'None');
        pushTag('FILE', 'DeclaredMIME', file.type || 'none');
        pushTag('FILE', 'DetectedMagicSignature', sig.label);

        let thumbUrl = null;
        let dimensions = 'None';
        let codecSummary = '';

        if (isImageFile(file)) {
          thumbUrl = URL.createObjectURL(file);
          try {
            const dec = await decodeImageSource(file);
            dimensions = `${dec.width}×${dec.height} px`;
            pushTag('IMAGE', 'PixelWidth', dec.width);
            pushTag('IMAGE', 'PixelHeight', dec.height);
            pushTag('IMAGE', 'Megapixels', `${((dec.width * dec.height) / 1000000).toFixed(2)} MP`);
            dec.cleanup();
          } catch (_) {}

          const segScan = await inspectImageBinaryMetadataSegments(file);
          if (segScan.segments.length > 0) {
            segScan.segments.forEach((s, idx) => {
              pushTag('SEGMENTS', `Marker_${idx + 1}`, `${s.label} @ offset ${s.offset}`);
            });
          } else {
            pushTag('SEGMENTS', 'EmbeddedSegments', 'None detected');
          }
        } else if (isVideoFile(file)) {
          const info = await probeVideoAndThumb(file);
          thumbUrl = info.thumbUrl;
          if (info.width) {
            dimensions = `${info.width}×${info.height} · ${info.duration.toFixed(2)}s`;
            pushTag('STREAM', 'VideoWidth', info.width);
            pushTag('STREAM', 'VideoHeight', info.height);
            pushTag('STREAM', 'DurationSeconds', info.duration.toFixed(3));
          }
        } else if (isAudioFile(file)) {
          const info = await probeAudioMetadata(file);
          if (info.duration) {
            dimensions = `Audio · ${info.duration.toFixed(2)}s`;
            pushTag('STREAM', 'DurationSeconds', info.duration.toFixed(3));
          }
        }

        if (sig.id === 'isobmff' || sig.id === 'isobmff-audio' || ['mp4', 'mov', 'm4a'].includes(extOf(file.name))) {
          const iso = await parseIsoBmffHeader(file);
          if (iso.brands) pushTag('CONTAINER', 'ISOBMFF_Brands', iso.brands);
          if (iso.codecs) {
            pushTag('CONTAINER', 'SampleEntryFourCCs', iso.codecs);
            codecSummary = iso.codecs;
          }
          if (iso.durationSec) pushTag('CONTAINER', 'MovieHeaderDurationSec', iso.durationSec);
          if (iso.atoms) pushTag('CONTAINER', 'TopLevelBoxes', iso.atoms);
        }

        await ensureDependency('exifr', () => Boolean(window.exifr));
        let rawBlocks = null;
        let mergedMeta = {};
        try {
          if (window.exifr) {
            rawBlocks = await window.exifr.parse(file, {
              tiff: true, ifd0: true, exif: true, gps: true, interop: true,
              ifd1: true, iptc: true, xmp: true, icc: true, jfif: true, ihdr: true,
              translateKeys: true, translateValues: true, reviveValues: true,
              mergeOutput: false,
            });
            mergedMeta = (await window.exifr.parse(file, {
              tiff: true, exif: true, gps: true, iptc: true, xmp: true, icc: true,
              mergeOutput: true,
            })) || {};
          }
        } catch (err) {
          logLine(`exifr notice (${file.name}): ${err.message}`);
        }

        if (rawBlocks && typeof rawBlocks === 'object') {
          for (const [blockKey, blockVal] of Object.entries(rawBlocks)) {
            if (!blockVal || typeof blockVal !== 'object') continue;
            const grpLabel = blockKey.toUpperCase();
            for (const [k, v] of Object.entries(blockVal)) {
              pushTag(grpLabel, k, v);
            }
          }
        }

        const camera = [mergedMeta.Make, mergedMeta.Model].filter(Boolean).join(' ').trim()
          || (codecSummary ? `Codecs: ${codecSummary}` : (isVideoFile(file) ? 'Video Container' : isAudioFile(file) ? 'Audio Container' : 'None'));
        const hasGps = typeof mergedMeta.latitude === 'number' && typeof mergedMeta.longitude === 'number';
        const gps = hasGps ? `${mergedMeta.latitude.toFixed(6)}, ${mergedMeta.longitude.toFixed(6)}` : 'None';
        const gpsUrl = hasGps
          ? `https://www.openstreetmap.org/?mlat=${mergedMeta.latitude}&mlon=${mergedMeta.longitude}#map=15/${mergedMeta.latitude}/${mergedMeta.longitude}`
          : '';

        return {
          id: nextId(),
          file,
          thumbUrl,
          filename: file.name,
          dimensions,
          camera,
          gps,
          gpsUrl,
          totalTags: flatTags.length,
          flatTags,
          groups,
        };
      }

      export async function deepProbeSelectedMediaWithFFmpeg() {
        const selected = state.forensics.exifRows.find((r) => r.id === state.forensics.selectedExifId);
        if (!selected) return;
        const btn = document.getElementById('deepProbeStreamsBtn');
        btn.disabled = true;
        btn.textContent = 'Probing Streams...';

        try {
          const ffmpeg = await getFFmpeg();
          const lines = [];
          const onLog = ({ message }) => { if (message) lines.push(message.trim()); };
          ffmpeg.on('log', onLog);
          await ffmpeg.writeFile('probe_in', new Uint8Array(await selected.file.arrayBuffer()));
          try {
            await ffmpeg.exec(['-hide_banner', '-i', 'probe_in']);
          } catch (_) {
            // ffmpeg -i without output exits non-zero after printing full container/stream info
          } finally {
            ffmpeg.off('log', onLog);
            await safeDelete(ffmpeg, 'probe_in');
          }

          let streamIdx = 1;
          for (const line of lines) {
            if (line.startsWith('Duration:')) {
              selected.flatTags.push({ group: 'FFMPEG_PROBE', key: 'Duration_Bitrate', value: line });
              selected.groups['FFMPEG_PROBE'] = (selected.groups['FFMPEG_PROBE'] || 0) + 1;
            } else if (line.startsWith('Stream #')) {
              selected.flatTags.push({ group: 'FFMPEG_PROBE', key: `Stream_${streamIdx++}`, value: line });
              selected.groups['FFMPEG_PROBE'] = (selected.groups['FFMPEG_PROBE'] || 0) + 1;
            } else if (line.includes(':') && !line.startsWith('Input #') && !line.startsWith('Metadata:') && !line.startsWith('At least one')) {
              const sep = line.indexOf(':');
              const k = line.slice(0, sep).trim();
              const v = line.slice(sep + 1).trim();
              if (k && v) {
                selected.flatTags.push({ group: 'CONTAINER_META', key: k, value: v });
                selected.groups['CONTAINER_META'] = (selected.groups['CONTAINER_META'] || 0) + 1;
              }
            }
          }
          selected.totalTags = selected.flatTags.length;
          renderExifTable();
          renderTotalMetadataDrawer();
          showToast('Extracted FFmpeg stream & container metadata', 'success');
        } catch (err) {
          const errStr = (err && (err.message || String(err))) || 'Stream probe failed';
          showToast(`Stream probe failed: ${errStr}`, 'error');
          logLine(`[forensics] Stream probe error: ${errStr}`);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Deep Stream Probe (FFmpeg)';
        }
      }

      export async function addExifFiles(files) {
        for (const f of files) {
          if (!checkFileSizeGuardrail(f, false)) continue;
          const row = await extractMediaMetadata(f);
          state.forensics.exifRows.push(row);
          state.forensics.selectedExifId = row.id;
          state.forensics.totalMetaGroup = 'ALL';
        }
        renderExifTable();
        renderTotalMetadataDrawer();
      }

      export function renderExifTable() {
        const tbody = document.getElementById('exifTableBody');
        const rows = state.forensics.exifRows;
        const hasRows = rows.length > 0;

        document.getElementById('forensicsQueueSummary').textContent =
          `${rows.length} file(s) inspected · click any row to inspect extracted fields`;
        document.getElementById('exifExportJsonBtn').disabled = !hasRows;
        document.getElementById('exifExportCsvBtn').disabled = !hasRows;

        if (!hasRows) {
          tbody.innerHTML = `<tr><td colspan="5" style="padding:1.25rem;text-align:center;color:var(--text-muted);">No files inspected yet.</td></tr>`;
          return;
        }

        tbody.innerHTML = rows.map((r) => {
          const isSelected = r.id === state.forensics.selectedExifId;
          const rowCls = isSelected ? 'row-selected' : 'row-hover';
          const fallback = isVideoFile(r.file) ? 'video' : isAudioFile(r.file) ? 'audio' : 'photo';
          const gpsCell = r.gpsUrl
            ? `<div class="stack-1">
                 <span style="color:var(--teal);">${escapeHtml(r.gps)}</span>
                 <a href="${r.gpsUrl}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="color:var(--accent-hi);text-decoration:underline;font-size:0.6875rem;display:inline-block;">Open External Map ↗ (sends coords to openstreetmap.org)</a>
               </div>`
            : `<span style="color:var(--text-muted);">${escapeHtml(r.gps)}</span>`;

          return `
            <tr data-select-exif="${r.id}" class="${rowCls}" style="cursor:pointer;">
              <td>
                <div class="flex-row gap-2-5">
                  ${renderThumbMarkup(r.thumbUrl, fallback)}
                  <span class="truncate" style="max-width:210px;" title="${escapeHtml(r.filename)}">${escapeHtml(r.filename)}</span>
                </div>
              </td>
              <td style="color:var(--text-muted);">${escapeHtml(r.dimensions)}</td>
              <td>${escapeHtml(r.camera)}</td>
              <td>${gpsCell}</td>
              <td><span class="badge badge-teal font-mono-tech">${r.totalTags} Fields</span></td>
            </tr>
          `;
        }).join('');
      }

      export function renderTotalMetadataDrawer() {
        const drawer = document.getElementById('totalMetaDrawer');
        const selected = state.forensics.exifRows.find((r) => r.id === state.forensics.selectedExifId);
        if (!selected) {
          drawer.classList.add('hidden');
          return;
        }

        drawer.classList.remove('hidden');
        document.getElementById('totalMetaTitle').textContent = `Extracted Metadata | ${selected.filename}`;
        document.getElementById('totalMetaSubtitle').textContent =
          `${selected.totalTags} fields extracted across ${Object.keys(selected.groups).length} metadata group(s)`;

        const pillsEl = document.getElementById('totalMetaGroupPills');
        const groupEntries = [['ALL', selected.totalTags], ...Object.entries(selected.groups)];
        pillsEl.innerHTML = groupEntries.map(([grp, count]) => {
          const active = state.forensics.totalMetaGroup === grp;
          return `<button type="button" data-meta-group="${escapeHtml(grp)}" class="px-btn font-mono-tech ${active ? 'px-btn-primary' : ''}" style="padding:0.25rem 0.55rem;font-size:0.6875rem;">${escapeHtml(grp)} (${count})</button>`;
        }).join('');

        const q = state.forensics.totalMetaSearch.trim().toLowerCase();
        const visibleTags = selected.flatTags.filter((t) => {
          if (state.forensics.totalMetaGroup !== 'ALL' && t.group !== state.forensics.totalMetaGroup) return false;
          if (!q) return true;
          return t.group.toLowerCase().includes(q) || t.key.toLowerCase().includes(q) || t.value.toLowerCase().includes(q);
        });

        const tbody = document.getElementById('totalMetaTableBody');
        if (visibleTags.length === 0) {
          tbody.innerHTML = `<tr><td colspan="3" style="padding:1rem;text-align:center;color:var(--text-muted);">No matching metadata tags.</td></tr>`;
          return;
        }

        tbody.innerHTML = visibleTags.map((t) => `
          <tr class="row-hover">
            <td style="color:var(--accent-hi);vertical-align:top;white-space:nowrap;">${escapeHtml(t.group)}</td>
            <td style="vertical-align:top;" class="break-all">${escapeHtml(t.key)}</td>
            <td style="color:var(--teal);vertical-align:top;" class="break-all">${escapeHtml(t.value)}</td>
          </tr>
        `).join('');
      }

      export function clearExifInspector() {
        state.forensics.exifRows.forEach((r) => { if (r.thumbUrl) URL.revokeObjectURL(r.thumbUrl); });
        state.forensics.exifRows = [];
        state.forensics.selectedExifId = null;
        renderExifTable();
        renderTotalMetadataDrawer();
      }

      export function exportExifJson() {
        const dump = state.forensics.exifRows.map((r) => {
          const grouped = {};
          for (const t of r.flatTags) {
            if (!grouped[t.group]) grouped[t.group] = {};
            grouped[t.group][t.key] = t.value;
          }
          return { filename: r.filename, extractedFields: r.totalTags, metadata: grouped };
        });
        const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'swissfile-metadata.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      }

      export function exportExifCsv() {
        const cols = ['filename', 'group', 'tag', 'value'];
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const lines = [cols.join(',')];
        for (const r of state.forensics.exifRows) {
          for (const t of r.flatTags) {
            lines.push([esc(r.filename), esc(t.group), esc(t.key), esc(t.value)].join(','));
          }
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'swissfile-metadata.csv';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      }

      export class StreamingSha256 {
        constructor() {
          this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
          this.k = new Uint32Array([
            0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
            0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
            0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
            0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
            0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
            0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
            0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
            0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
          ]);
          this.buf = new Uint8Array(64);
          this.bufLen = 0;
          this.bytesHashed = 0;
          this.w = new Uint32Array(64);
        }
        _compress(block) {
          const w = this.w;
          const k = this.k;
          const h = this.h;
          for (let i = 0; i < 16; i++) {
            const j = i * 4;
            w[i] = ((block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3]) >>> 0;
          }
          for (let i = 16; i < 64; i++) {
            const s0 = (((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3)) >>> 0;
            const s1 = (((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10)) >>> 0;
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
          }
          let [a, b, c, d, e, f, g, hh] = h;
          for (let i = 0; i < 64; i++) {
            const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
            const ch = ((e & f) ^ (~e & g)) >>> 0;
            const temp1 = (hh + S1 + ch + k[i] + w[i]) >>> 0;
            const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
            const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
            const temp2 = (S0 + maj) >>> 0;
            hh = g; g = f; f = e; e = (d + temp1) >>> 0;
            d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
          }
          h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
          h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
        }
        update(chunk) {
          let offset = 0;
          this.bytesHashed += chunk.length;
          if (this.bufLen > 0) {
            const take = Math.min(64 - this.bufLen, chunk.length);
            this.buf.set(chunk.subarray(0, take), this.bufLen);
            this.bufLen += take;
            offset += take;
            if (this.bufLen === 64) {
              this._compress(this.buf);
              this.bufLen = 0;
            }
          }
          while (offset + 64 <= chunk.length) {
            this._compress(chunk.subarray(offset, offset + 64));
            offset += 64;
          }
          if (offset < chunk.length) {
            this.buf.set(chunk.subarray(offset), 0);
            this.bufLen = chunk.length - offset;
          }
        }
        digestHex() {
          const bitLenHi = Math.floor((this.bytesHashed * 8) / 0x100000000) >>> 0;
          const bitLenLo = ((this.bytesHashed * 8) >>> 0);
          const pad = new Uint8Array(this.bufLen < 56 ? 64 - this.bufLen : 128 - this.bufLen);
          pad[0] = 0x80;
          const dv = new DataView(pad.buffer);
          dv.setUint32(pad.length - 8, bitLenHi, false);
          dv.setUint32(pad.length - 4, bitLenLo, false);
          this.update(pad);
          return Array.from(this.h).map((v) => v.toString(16).padStart(8, '0')).join('');
        }
      }

      export class StreamingSha512 {
        constructor() {
          this.h = new BigUint64Array([
            0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
            0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
          ]);
          this.k = new BigUint64Array([
            0x428a2f98d728ae22n,0x7137449123ef65cdn,0xb5c0fbcfec4d3b2fn,0xe9b5dba58189dbbcn,
            0x3956c25bf348b538n,0x59f111f1b605d019n,0x923f82a4af194f9bn,0xab1c5ed5da6d8118n,
            0xd807aa98a3030242n,0x12835b0145706fben,0x243185be4ee4b28cn,0x550c7dc3d5ffb4e2n,
            0x72be5d74f27b896fn,0x80deb1fe3b1696b1n,0x9bdc06a725c71235n,0xc19bf174cf692694n,
            0xe49b69c19ef14ad2n,0xefbe4786384f25e3n,0x0fc19dc68b8cd5b5n,0x240ca1cc77ac9c65n,
            0x2de92c6f592b0275n,0x4a7484aa6ea6e483n,0x5cb0a9dcbd41fbd4n,0x76f988da831153b5n,
            0x983e5152ee66dfabn,0xa831c66d2db43210n,0xb00327c898fb213fn,0xbf597fc7beef0ee4n,
            0xc6e00bf33da88fc2n,0xd5a79147930aa725n,0x06ca6351e003826fn,0x142929670a0e6e70n,
            0x27b70a8546d22ffcn,0x2e1b21385c26c926n,0x4d2c6dfc5ac42aedn,0x53380d139d95b3dfn,
            0x650a73548baf63den,0x766a0abb3c77b2a8n,0x81c2c92e47edaee6n,0x92722c851482353bn,
            0xa2bfe8a14cf10364n,0xa81a664bbc423001n,0xc24b8b70d0f89791n,0xc76c51a30654be30n,
            0xd192e819d6ef5218n,0xd69906245565a910n,0xf40e35855771202an,0x106aa07032bbd1b8n,
            0x19a4c116b8d2d0c8n,0x1e376c085141ab53n,0x2748774cdf8eeb99n,0x34b0bcb5e19b48a8n,
            0x391c0cb3c5c95a63n,0x4ed8aa4ae3418acbn,0x5b9cca4f7763e373n,0x682e6ff3d6b2b8a3n,
            0x748f82ee5defb2fcn,0x78a5636f43172f60n,0x84c87814a1f0ab72n,0x8cc702081a6439ecn,
            0x90befffa23631e28n,0xa4506cebde82bde9n,0xbef9a3f7b2c67915n,0xc67178f2e372532bn,
            0xca273eceea26619cn,0xd186b8c721c0c207n,0xeada7dd6cde0eb1en,0xf57d4f7fee6ed178n,
            0x06f067aa72176fban,0x0a637dc5a2c898a6n,0x113f9804bef90daen,0x1b710b35131c471bn,
            0x28db77f523047d84n,0x32caab7b40c72493n,0x3c9ebe0a15c9bebcn,0x431d67c49c100d4cn,
            0x4cc5d4becb3e42b6n,0x597f299cfc657e2an,0x5fcb6fab3ad6faecn,0x6c44198c4a475817n,
          ]);
          this.buf = new Uint8Array(128);
          this.bufLen = 0;
          this.bytesHashed = 0n;
          this.w = new BigUint64Array(80);
        }
        _rotr(x, n) { return ((x >> n) | (x << (64n - n))) & 0xffffffffffffffffn; }
        _compress(block) {
          const w = this.w;
          const k = this.k;
          const h = this.h;
          const dv = new DataView(block.buffer, block.byteOffset, 128);
          for (let i = 0; i < 16; i++) w[i] = dv.getBigUint64(i * 8, false);
          for (let i = 16; i < 80; i++) {
            const s0 = this._rotr(w[i - 15], 1n) ^ this._rotr(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
            const s1 = this._rotr(w[i - 2], 19n) ^ this._rotr(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & 0xffffffffffffffffn;
          }
          let [a, b, c, d, e, f, g, hh] = h;
          for (let i = 0; i < 80; i++) {
            const S1 = this._rotr(e, 14n) ^ this._rotr(e, 18n) ^ this._rotr(e, 41n);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (hh + S1 + ch + k[i] + w[i]) & 0xffffffffffffffffn;
            const S0 = this._rotr(a, 28n) ^ this._rotr(a, 34n) ^ this._rotr(a, 39n);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) & 0xffffffffffffffffn;
            hh = g; g = f; f = e; e = (d + temp1) & 0xffffffffffffffffn;
            d = c; c = b; b = a; a = (temp1 + temp2) & 0xffffffffffffffffn;
          }
          h[0] = (h[0] + a) & 0xffffffffffffffffn; h[1] = (h[1] + b) & 0xffffffffffffffffn;
          h[2] = (h[2] + c) & 0xffffffffffffffffn; h[3] = (h[3] + d) & 0xffffffffffffffffn;
          h[4] = (h[4] + e) & 0xffffffffffffffffn; h[5] = (h[5] + f) & 0xffffffffffffffffn;
          h[6] = (h[6] + g) & 0xffffffffffffffffn; h[7] = (h[7] + hh) & 0xffffffffffffffffn;
        }
        update(chunk) {
          let offset = 0;
          this.bytesHashed += BigInt(chunk.length);
          if (this.bufLen > 0) {
            const take = Math.min(128 - this.bufLen, chunk.length);
            this.buf.set(chunk.subarray(0, take), this.bufLen);
            this.bufLen += take;
            offset += take;
            if (this.bufLen === 128) { this._compress(this.buf); this.bufLen = 0; }
          }
          while (offset + 128 <= chunk.length) {
            this._compress(chunk.subarray(offset, offset + 128));
            offset += 128;
          }
          if (offset < chunk.length) {
            this.buf.set(chunk.subarray(offset), 0);
            this.bufLen = chunk.length - offset;
          }
        }
        digestHex() {
          const bitLen = this.bytesHashed * 8n;
          const padLen = this.bufLen < 112 ? 128 - this.bufLen : 256 - this.bufLen;
          const pad = new Uint8Array(padLen);
          pad[0] = 0x80;
          const dv = new DataView(pad.buffer);
          dv.setBigUint64(padLen - 8, bitLen, false);
          this.update(pad);
          return Array.from(this.h).map((v) => v.toString(16).padStart(16, '0')).join('');
        }
      }

      export async function computeStreamingHashes(file, onProgress) {
        const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB chunks
        const s256 = new StreamingSha256();
        const s512 = new StreamingSha512();
        let offset = 0;
        while (offset < file.size) {
          const slice = file.slice(offset, Math.min(file.size, offset + CHUNK_SIZE));
          const chunk = new Uint8Array(await slice.arrayBuffer());
          s256.update(chunk);
          s512.update(chunk);
          offset += chunk.length;
          if (onProgress) onProgress(Math.round((offset / Math.max(1, file.size)) * 100));
        }
        return { sha256: s256.digestHex(), sha512: s512.digestHex() };
      }

      export function updateHashVerification() {
        const expected = document.getElementById('expectedHashInput').value.trim().toLowerCase();
        const badge = document.getElementById('expectedHashBadge');
        const note = document.getElementById('expectedHashNote');

        if (!expected) {
          badge.classList.add('hidden');
          note.textContent = state.forensics.file
            ? 'Paste a published SHA-256 or SHA-512 hash above to verify integrity.'
            : 'Drop a file in the verifier card on the left, then paste a published checksum to check integrity.';
          note.style.color = 'var(--text-muted)';
          return;
        }

        if (!state.forensics.sha256) {
          badge.classList.add('hidden');
          note.textContent = 'Drop a file first to compute its checksums.';
          note.style.color = 'var(--amber)';
          return;
        }

        badge.classList.remove('hidden');
        if (expected === state.forensics.sha256 || expected === state.forensics.sha512) {
          const algo = expected === state.forensics.sha256 ? 'SHA-256' : 'SHA-512';
          badge.textContent = `MATCH (${algo})`;
          badge.className = 'badge badge-teal font-mono-tech';
          note.textContent = `Exact cryptographic ${algo} match verified locally.`;
          note.style.color = 'var(--teal)';
        } else {
          badge.textContent = 'MISMATCH';
          badge.className = 'badge badge-rose font-mono-tech';
          note.textContent = 'Expected hash does not match computed SHA-256 or SHA-512.';
          note.style.color = 'var(--rose)';
        }
      }

      export async function handleForensicsFile(file) {
        if (!file) return;
        if (!checkFileSizeGuardrail(file, false)) return;
        if (state.forensics.thumbUrl) { URL.revokeObjectURL(state.forensics.thumbUrl); state.forensics.thumbUrl = null; }
        state.forensics.file = file;

        document.getElementById('forensicsFileCard').classList.remove('hidden');
        document.getElementById('forensicsFileName').textContent = file.name;
        document.getElementById('forensicsFileSize').textContent = `${formatBytes(file.size)} · Reported MIME: ${file.type || 'none'}`;

        const slot = document.getElementById('forensicsThumbSlot');
        if (isImageFile(file)) {
          state.forensics.thumbUrl = URL.createObjectURL(file);
          slot.innerHTML = `<img src="${state.forensics.thumbUrl}" alt="" />`;
        } else if (isVideoFile(file)) {
          slot.innerHTML = SVG_VIDEO;
          probeVideoAndThumb(file).then((info) => {
            if (info.thumbUrl && state.forensics.file === file) {
              state.forensics.thumbUrl = info.thumbUrl;
              slot.innerHTML = `<img src="${info.thumbUrl}" alt="" />`;
            } else if (info.thumbUrl) URL.revokeObjectURL(info.thumbUrl);
          });
        } else if (isAudioFile(file)) {
          slot.innerHTML = SVG_AUDIO;
        } else if (extOf(file.name) === 'swisslock') {
          slot.innerHTML = SVG_LOCK;
        } else {
          slot.innerHTML = SVG_BINARY;
        }

        const headBytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
        const tailBytes = new Uint8Array(await file.slice(Math.max(0, file.size - 16), file.size).arrayBuffer());
        const sig = detectMagicSignature(headBytes);
        const ext = extOf(file.name);

        document.getElementById('magicDetectedType').textContent = sig.label;
        document.getElementById('magicHeadHex').textContent = bytesToHex(headBytes) || 'Empty';
        document.getElementById('magicHeadAscii').textContent = `ASCII: ${bytesToAscii(headBytes) || 'None'}`;
        document.getElementById('magicTailHex').textContent = bytesToHex(tailBytes) || 'Empty';
        document.getElementById('magicTailAscii').textContent = `ASCII: ${bytesToAscii(tailBytes) || 'None'}`;

        const badge = document.getElementById('forensicsSpoofBadge');
        if (sig.exts === null) {
          badge.textContent = 'UNCLASSIFIED';
          badge.className = 'badge font-mono-tech';
        } else if (sig.exts.length === 0) {
          badge.textContent = 'CORRUPT / EMPTY';
          badge.className = 'badge badge-amber font-mono-tech';
        } else if (sig.exts.includes(ext)) {
          badge.textContent = 'EXT VERIFIED';
          badge.className = 'badge badge-teal font-mono-tech';
        } else {
          badge.textContent = 'SPOOFED / MISMATCH';
          badge.className = 'badge badge-rose font-mono-tech';
          showToast(`Extension .${ext || '(none)'} mismatches magic bytes (${sig.label})!`, 'error');
        }

        const hashBox = document.getElementById('hashProgressBox');
        const hashLabel = document.getElementById('hashProgressLabel');
        const hashPct = document.getElementById('hashProgressPct');
        hashBox.classList.remove('hidden');
        document.getElementById('sha256Output').textContent = 'Streaming chunks...';
        document.getElementById('sha512Output').textContent = 'Streaming chunks...';

        const { sha256, sha512 } = await computeStreamingHashes(file, (pct) => {
          hashLabel.textContent = `Hashing ${file.name} (2 MB chunks)...`;
          hashPct.textContent = `${pct}%`;
          setSegmentedProgress('hashSegTrack', pct, 'blue');
        });

        state.forensics.sha256 = sha256;
        state.forensics.sha512 = sha512;
        document.getElementById('sha256Output').textContent = sha256;
        document.getElementById('sha512Output').textContent = sha512;
        hashLabel.textContent = 'Checksum complete';
        hashPct.textContent = '100%';
        setSegmentedProgress('hashSegTrack', 100, 'teal');
        updateHashVerification();
      }



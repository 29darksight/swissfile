import { archiverState, SVG_BINARY } from './state.js';
import {
  $, $$, escapeHtml, formatBytes, baseName, extOf, showToast, logLine, setSegmentedProgress, checkFileSizeGuardrail
} from './dom.js';
import { ensureDependency } from './vendors.js';

export function buildTar(items) {
        const encoder = new TextEncoder();
        const blocks = [];

        for (const item of items) {
          const file = item.file;
          const header = new Uint8Array(512);
          const nameBytes = encoder.encode(file.name);
          header.set(nameBytes.subarray(0, 100), 0);

          // mode 0644
          header.set(encoder.encode('0000644 \0').subarray(0, 8), 100);
          // uid 0 & gid 0
          header.set(encoder.encode('0000000 \0').subarray(0, 8), 108);
          header.set(encoder.encode('0000000 \0').subarray(0, 8), 116);

          // size in octal (11 octal digits + space)
          const sizeStr = item.data.byteLength.toString(8).padStart(11, '0') + ' ';
          header.set(encoder.encode(sizeStr).subarray(0, 12), 124);

          // mtime
          const mtime = Math.floor((file.lastModified || Date.now()) / 1000);
          const mtimeStr = mtime.toString(8).padStart(11, '0') + ' ';
          header.set(encoder.encode(mtimeStr).subarray(0, 12), 136);

          // typeflag '0' (regular file)
          header[156] = 48;

          // ustar magic & version
          header.set(encoder.encode('ustar\0'), 257);
          header.set(encoder.encode('00'), 263);

          // uname & gname
          header.set(encoder.encode('swissfile\0'), 265);
          header.set(encoder.encode('swissfile\0'), 297);

          // Checksum (header bytes 148-155 treated as ASCII spaces 0x20)
          for (let i = 148; i < 156; i++) header[i] = 32;
          let sum = 0;
          for (let i = 0; i < 512; i++) sum += header[i];
          const chkStr = sum.toString(8).padStart(6, '0') + '\0 ';
          header.set(encoder.encode(chkStr).subarray(0, 8), 148);

          blocks.push(header);
          blocks.push(item.data);

          const pad = (512 - (item.data.byteLength % 512)) % 512;
          if (pad > 0) blocks.push(new Uint8Array(pad));
        }

        // Two 512-byte zero blocks mark end of TAR archive
        blocks.push(new Uint8Array(1024));

        const totalLen = blocks.reduce((acc, b) => acc + b.byteLength, 0);
        const out = new Uint8Array(totalLen);
        let offset = 0;
        for (const b of blocks) {
          out.set(b, offset);
          offset += b.byteLength;
        }
        return out;
      }

      export function parseTar(bytes) {
        const entries = [];
        let offset = 0;
        const decoder = new TextDecoder();

        while (offset + 512 <= bytes.byteLength) {
          const header = bytes.subarray(offset, offset + 512);
          if (header.every((b) => b === 0)) break;

          let nameEnd = 0;
          while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
          let name = decoder.decode(header.subarray(0, nameEnd)).trim();

          // Prefix support in USTAR
          let prefixEnd = 0;
          while (prefixEnd < 155 && header[345 + prefixEnd] !== 0) prefixEnd++;
          if (prefixEnd > 0) {
            const prefix = decoder.decode(header.subarray(345, 345 + prefixEnd)).trim();
            if (prefix) name = `${prefix}/${name}`;
          }

          let sizeStr = '';
          for (let i = 124; i < 136; i++) {
            if (header[i] === 0 || header[i] === 32) {
              if (sizeStr.length > 0) break;
            } else {
              sizeStr += String.fromCharCode(header[i]);
            }
          }
          const size = parseInt(sizeStr.trim(), 8) || 0;
          const typeFlag = String.fromCharCode(header[156] || 48);

          offset += 512;
          if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
            const data = bytes.subarray(offset, offset + size);
            entries.push({
              path: name || 'file',
              size,
              getBlob: async () => new Blob([data]),
            });
          }
          const pad = (512 - (size % 512)) % 512;
          offset += size + pad;
        }
        return entries;
      }

      export async function compressGzip(uint8Array, level = 'balanced') {
        if (typeof window !== "undefined" && window.pako && window.pako.gzip) {
          const lvl = level === 'fast' ? 1 : level === 'maximum' ? 9 : 6;
          return window.pako.gzip(uint8Array, { level: lvl });
        }
        if (typeof CompressionStream !== 'undefined') {
          const cs = new CompressionStream('gzip');
          const writer = cs.writable.getWriter();
          writer.write(uint8Array);
          writer.close();
          const buf = await new Response(cs.readable).arrayBuffer();
          return new Uint8Array(buf);
        }
        const okPako = await ensureDependency('pako', () => Boolean(window.pako));
        if (okPako && window.pako && window.pako.gzip) {
          const lvl = level === 'fast' ? 1 : level === 'maximum' ? 9 : 6;
          return window.pako.gzip(uint8Array, { level: lvl });
        }
        throw new Error('Gzip compression stream is not available');
      }

      export async function decompressGzip(uint8Array) {
        if (typeof DecompressionStream !== 'undefined') {
          try {
            const ds = new DecompressionStream('gzip');
            const writer = ds.writable.getWriter();
            writer.write(uint8Array);
            writer.close();
            const buf = await new Response(ds.readable).arrayBuffer();
            return new Uint8Array(buf);
          } catch (e) {
            // Fall through to pako
          }
        }
        if (typeof window !== "undefined" && window.pako && window.pako.ungzip) {
          return window.pako.ungzip(uint8Array);
        }
        const okPako = await ensureDependency('pako', () => Boolean(window.pako));
        if (okPako && window.pako && window.pako.ungzip) {
          return window.pako.ungzip(uint8Array);
        }
        throw new Error('Gzip decompression stream is not available');
      }

      // Flatten nested directory objects from libarchive.js
      export function flattenArchFiles(obj, prefix = '') {
        const list = [];
        for (const [k, v] of Object.entries(obj)) {
          const p = prefix ? `${prefix}/${k}` : k;
          if (v instanceof File || v instanceof Blob) {
            list.push({ path: p, size: v.size, getBlob: async () => v });
          } else if (v && typeof v === 'object') {
            list.push(...flattenArchFiles(v, p));
          }
        }
        return list;
      }

      export function addZipFiles(files) {
        for (const f of files) {
          if (!checkFileSizeGuardrail(f, false)) continue;
          if (f.size === 0) { showToast(`${f.name}: empty file skipped`, 'warn'); continue; }
          if (archiverState.zipItems.some((i) => i.file.name === f.name && i.file.size === f.size)) continue;
          archiverState.zipItems.push({ file: f, id: crypto.randomUUID() });
        }
        renderZipQueue();
      }

      export function removeZipItem(id) {
        archiverState.zipItems = archiverState.zipItems.filter((i) => i.id !== id);
        renderZipQueue();
      }

      export function clearZipQueue() {
        archiverState.zipItems = [];
        if (archiverState.zipBlobUrl) {
          URL.revokeObjectURL(archiverState.zipBlobUrl);
          archiverState.zipBlobUrl = null;
        }
        document.getElementById('zipDownloadSlot').innerHTML = '';
        document.getElementById('zipProgressBox').classList.add('hidden');
        renderZipQueue();
      }

      export function renderZipQueue() {
        const list = document.getElementById('zipQueueList');
        const countEl = document.getElementById('zipQueueCount');
        const btn = document.getElementById('zipRunBtn');
        const items = archiverState.zipItems;
        countEl.textContent = `Any file type accepted · ${items.length} queued`;
        btn.disabled = items.length === 0 || archiverState.busy.pack;
        if (items.length === 0) { list.innerHTML = ''; return; }
        list.innerHTML = items.map((i) => `
          <div class="px-card-sm flex-row gap-3" style="padding:0.5rem 0.75rem;">
            <div class="file-thumb">${SVG_BINARY}</div>
            <div class="min-w-0 flex-1">
              <p class="font-mono-tech truncate" style="margin:0;font-size:0.8125rem;">${escapeHtml(i.file.name)}</p>
              <p class="sub-muted font-mono-tech">${formatBytes(i.file.size)}</p>
            </div>
            <button data-remove-zip="${i.id}" type="button" class="px-btn font-mono-tech" style="padding:0.25rem 0.5rem;font-size:0.7rem;">Remove</button>
          </div>
        `).join('');
      }

      export async function runZipCompress() {
        const items = archiverState.zipItems;
        if (items.length === 0 || archiverState.busy.pack) return;

        archiverState.busy.pack = true;
        const runBtn = document.getElementById('zipRunBtn');
        runBtn.disabled = true;

        const progBox = document.getElementById('zipProgressBox');
        const statusEl = document.getElementById('zipStatusLabel');
        const pctEl = document.getElementById('zipPctLabel');
        progBox.classList.remove('hidden');

        try {
          const targetFmt = document.getElementById('zipTargetFormat').value;
          const compLevel = document.getElementById('zipCompressionLevel').value;
          let rawName = (document.getElementById('zipArchiveName').value.trim() || 'archive')
            .replace(/\.(zip|tar|tar\.gz|tgz|gz)$/i, '');

          let blob = null;
          let finalName = '';

          if (targetFmt === 'zip') {
            const okZip = await ensureDependency('jszip', () => Boolean(window.JSZip));
            if (!okZip) throw new Error('Failed to load JSZip library');

            const zip = new window.JSZip();
            for (let i = 0; i < items.length; i++) {
              const item = items[i];
              statusEl.textContent = `Adding ${i + 1} of ${items.length}: ${item.file.name}`;
              const pct = Math.round(((i + 1) / items.length) * 40);
              pctEl.textContent = `${pct}%`;
              setSegmentedProgress('zipSegTrack', pct, 'blue');
              zip.file(item.file.name, item.file);
            }

            statusEl.textContent = 'Generating zip archive...';
            const zipLvl = compLevel === 'fast' ? 1 : compLevel === 'maximum' ? 9 : 6;
            blob = await zip.generateAsync(
              { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: zipLvl } },
              (meta) => {
                const pct = Math.round(40 + (meta.percent * 0.6));
                pctEl.textContent = `${pct}%`;
                setSegmentedProgress('zipSegTrack', pct, 'blue');
              }
            );
            finalName = `${rawName}.zip`;

          } else if (targetFmt === 'tar' || targetFmt === 'tar.gz') {
            const itemsWithData = [];
            for (let i = 0; i < items.length; i++) {
              const it = items[i];
              statusEl.textContent = `Reading ${i + 1} of ${items.length}: ${it.file.name}`;
              const pct = Math.round(((i + 1) / items.length) * 50);
              pctEl.textContent = `${pct}%`;
              setSegmentedProgress('zipSegTrack', pct, 'blue');
              const buf = await it.file.arrayBuffer();
              itemsWithData.push({ file: it.file, data: new Uint8Array(buf) });
            }

            statusEl.textContent = 'Building POSIX TAR structure...';
            const tarBytes = buildTar(itemsWithData);

            if (targetFmt === 'tar') {
              blob = new Blob([tarBytes], { type: 'application/x-tar' });
              finalName = `${rawName}.tar`;
            } else {
              statusEl.textContent = 'Applying Gzip compression...';
              pctEl.textContent = '75%';
              setSegmentedProgress('zipSegTrack', 75, 'blue');
              const gzipped = await compressGzip(tarBytes, compLevel);
              blob = new Blob([gzipped], { type: 'application/gzip' });
              finalName = `${rawName}.tar.gz`;
            }

          } else if (targetFmt === 'gz') {
            if (items.length > 1) {
              showToast('Single file gzip compression applied. Queued files bundled as TAR.GZ.', 'info');
              const itemsWithData = [];
              for (let i = 0; i < items.length; i++) {
                const it = items[i];
                statusEl.textContent = `Reading ${i + 1} of ${items.length}: ${it.file.name}`;
                const pct = Math.round(((i + 1) / items.length) * 50);
                pctEl.textContent = `${pct}%`;
                setSegmentedProgress('zipSegTrack', pct, 'blue');
                const buf = await it.file.arrayBuffer();
                itemsWithData.push({ file: it.file, data: new Uint8Array(buf) });
              }
              statusEl.textContent = 'Building TAR and compressing...';
              const tarBytes = buildTar(itemsWithData);
              const gzipped = await compressGzip(tarBytes, compLevel);
              blob = new Blob([gzipped], { type: 'application/gzip' });
              finalName = `${rawName}.tar.gz`;
            } else {
              const single = items[0];
              statusEl.textContent = `Compressing ${single.file.name}...`;
              pctEl.textContent = '50%';
              setSegmentedProgress('zipSegTrack', 50, 'blue');
              const buf = await single.file.arrayBuffer();
              const gzipped = await compressGzip(new Uint8Array(buf), compLevel);
              blob = new Blob([gzipped], { type: 'application/gzip' });
              finalName = `${single.file.name}.gz`;
            }
          }

          if (archiverState.zipBlobUrl) {
            URL.revokeObjectURL(archiverState.zipBlobUrl);
            archiverState.zipBlobUrl = null;
          }
          archiverState.zipBlobUrl = URL.createObjectURL(blob);

          document.getElementById('zipDownloadSlot').innerHTML = `
            <a href="${archiverState.zipBlobUrl}" download="${escapeHtml(finalName)}" class="px-btn px-btn-teal w-full font-mono-tech" style="text-align:center;margin-top:0.5rem;display:block;text-decoration:none;">
              Download ${escapeHtml(finalName)} (${formatBytes(blob.size)})
            </a>
          `;

          statusEl.textContent = `Archive created: ${formatBytes(blob.size)}`;
          pctEl.textContent = '100%';
          setSegmentedProgress('zipSegTrack', 100, 'teal');
          logLine(`Archiver: created ${finalName} (${formatBytes(blob.size)}, ${items.length} files)`);
          showToast(`Created ${finalName}`, 'success');
        } catch (err) {
          statusEl.textContent = 'Compression failed';
          pctEl.textContent = '0%';
          setSegmentedProgress('zipSegTrack', 0, 'amber');
          showToast(`Compression failed: ${err.message}`, 'error');
          logLine(`Archiver compress error: ${err.message}`);
        } finally {
          archiverState.busy.pack = false;
          renderZipQueue();
        }
      }

      export async function handleUnzipFile(file) {
        if (!file) return;

        document.getElementById('unzipFileCard').classList.remove('hidden');
        document.getElementById('unzipFileName').textContent = file.name;
        document.getElementById('unzipFileSize').textContent = formatBytes(file.size);

        const progBox = document.getElementById('unzipProgressBox');
        const statusEl = document.getElementById('unzipStatusLabel');
        const pctEl = document.getElementById('unzipPctLabel');
        progBox.classList.remove('hidden');
        statusEl.textContent = 'Reading archive...';
        pctEl.textContent = '15%';
        setSegmentedProgress('unzipSegTrack', 15, 'blue');

        try {
          const headBytes = new Uint8Array(await file.slice(0, 512).arrayBuffer());
          const isGzip = headBytes[0] === 0x1F && headBytes[1] === 0x8B;
          const isZip = headBytes[0] === 0x50 && headBytes[1] === 0x4B;
          const is7z = headBytes[0] === 0x37 && headBytes[1] === 0x7A && headBytes[2] === 0xBC && headBytes[3] === 0xAF;
          const isRar = headBytes[0] === 0x52 && headBytes[1] === 0x61 && headBytes[2] === 0x72;
          const nameLower = file.name.toLowerCase();

          let entries = [];

          if (isGzip || nameLower.endsWith('.gz') || nameLower.endsWith('.tgz')) {
            statusEl.textContent = 'Decompressing Gzip stream...';
            pctEl.textContent = '40%';
            setSegmentedProgress('unzipSegTrack', 40, 'blue');

            const fullBytes = new Uint8Array(await file.arrayBuffer());
            const decompressed = await decompressGzip(fullBytes);

            const isTar = decompressed.length >= 512 && (
              nameLower.includes('.tar') ||
              nameLower.endsWith('.tgz') ||
              (decompressed[257] === 117 && decompressed[258] === 115 && decompressed[259] === 116 && decompressed[260] === 97 && decompressed[261] === 114)
            );

            if (isTar) {
              statusEl.textContent = 'Unpacking TAR directory...';
              pctEl.textContent = '75%';
              setSegmentedProgress('unzipSegTrack', 75, 'blue');
              entries = parseTar(decompressed);
            } else {
              const cleanName = file.name.replace(/\.(tar\.gz|tgz|gz)$/i, '') || 'extracted_file';
              entries = [{
                path: cleanName,
                size: decompressed.byteLength,
                getBlob: async () => new Blob([decompressed]),
              }];
            }

          } else if (nameLower.endsWith('.tar') || (headBytes[257] === 117 && headBytes[258] === 115 && headBytes[259] === 116 && headBytes[260] === 97 && headBytes[261] === 114)) {
            statusEl.textContent = 'Unpacking TAR directory...';
            pctEl.textContent = '50%';
            setSegmentedProgress('unzipSegTrack', 50, 'blue');
            const fullBytes = new Uint8Array(await file.arrayBuffer());
            entries = parseTar(fullBytes);

          } else if (is7z || isRar || nameLower.endsWith('.7z') || nameLower.endsWith('.rar')) {
            statusEl.textContent = 'Loading WASM archive engine...';
            pctEl.textContent = '35%';
            setSegmentedProgress('unzipSegTrack', 35, 'blue');

            const okArch = await ensureDependency('libarchive', () => Boolean(window.Archive));
            if (okArch && window.Archive) {
              window.Archive.init({ workerUrl: 'https://unpkg.com/libarchive.js@2.0.0/dist/worker-bundle.js' });
              statusEl.textContent = 'Extracting 7Z / RAR entries...';
              pctEl.textContent = '65%';
              setSegmentedProgress('unzipSegTrack', 65, 'blue');

              const archive = await window.Archive.open(file);
              if (archive.hasEncryptedData && (await archive.hasEncryptedData())) {
                showToast('Password protected archive detected. Decryption is not supported.', 'warn');
                statusEl.textContent = 'Password protected archive';
                progBox.classList.add('hidden');
                return;
              }
              const extractedTree = await archive.extractFiles();
              entries = flattenArchFiles(extractedTree);
            } else {
              throw new Error('WebAssembly extractor unavailable for 7Z or RAR files');
            }

          } else {
            // Default to ZIP
            const okZip = await ensureDependency('jszip', () => Boolean(window.JSZip));
            if (!okZip) throw new Error('Failed to load JSZip library');

            const ab = await file.arrayBuffer();
            const zip = await window.JSZip.loadAsync(ab);
            zip.forEach((path, entry) => {
              if (!entry.dir) {
                const s = entry._data ? (entry._data.uncompressedSize || 0) : 0;
                entries.push({
                  path,
                  size: s,
                  getBlob: () => entry.async('blob'),
                });
              }
            });
          }

          archiverState.unzipData = { entries, file };
          document.getElementById('unzipExtractAllBtn').disabled = entries.length === 0;

          statusEl.textContent = `Found ${entries.length} file(s)`;
          pctEl.textContent = '100%';
          setSegmentedProgress('unzipSegTrack', 100, 'teal');
          renderUnzipList(entries);
          logLine(`Archiver: opened ${file.name} (${entries.length} files inside)`);
        } catch (err) {
          showToast(`Failed to read archive: ${err.message}`, 'error');
          logLine(`Archiver unpack error: ${err.message}`);
          progBox.classList.add('hidden');
        }
      }

      export function renderUnzipList(entries) {
        const list = document.getElementById('unzipFileList');
        list.innerHTML = entries.map((e, i) => `
          <div class="px-card-sm flex-row gap-3" style="padding:0.5rem 0.75rem;">
            <div class="file-thumb">${SVG_BINARY}</div>
            <div class="min-w-0 flex-1">
              <p class="font-mono-tech truncate" style="margin:0;font-size:0.8125rem;">${escapeHtml(e.path)}</p>
              <p class="sub-muted font-mono-tech">${e.size > 0 ? formatBytes(e.size) : 'compressed'}</p>
            </div>
            <button data-extract-single="${i}" type="button" class="px-btn px-btn-primary font-mono-tech" style="padding:0.25rem 0.6rem;font-size:0.7rem;">Download</button>
          </div>
        `).join('');
      }

      export async function extractSingleFile(index) {
        const data = archiverState.unzipData;
        if (!data) return;
        const entry = data.entries[index];
        if (!entry) return;
        try {
          const blob = await entry.getBlob();
          const filename = entry.path.includes('/') ? entry.path.split('/').pop() : entry.path;
          const url = URL.createObjectURL(blob);
          archiverState.unzipBlobUrls.push(url);

          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          showToast(`Extracted ${filename}`, 'success');
          logLine(`Archiver: extracted ${filename} (${formatBytes(blob.size)})`);
        } catch (err) {
          showToast(`Extract failed: ${err.message}`, 'error');
        }
      }

      export async function extractAllFiles() {
        const data = archiverState.unzipData;
        if (!data || data.entries.length === 0 || archiverState.busy.unpack) return;

        archiverState.busy.unpack = true;
        const btn = document.getElementById('unzipExtractAllBtn');
        btn.disabled = true;

        const statusEl = document.getElementById('unzipStatusLabel');
        const pctEl = document.getElementById('unzipPctLabel');
        const progBox = document.getElementById('unzipProgressBox');
        progBox.classList.remove('hidden');

        try {
          const okZip = await ensureDependency('jszip', () => Boolean(window.JSZip));
          if (!okZip) throw new Error('Failed to load JSZip library');

          const zip = new window.JSZip();

          for (let i = 0; i < data.entries.length; i++) {
            const e = data.entries[i];
            statusEl.textContent = `Packing ${i + 1} of ${data.entries.length}: ${e.path.split('/').pop()}`;
            const pct = Math.round(((i + 1) / data.entries.length) * 50);
            pctEl.textContent = `${pct}%`;
            setSegmentedProgress('unzipSegTrack', pct, 'blue');
            const blob = await e.getBlob();
            zip.file(e.path, blob);
          }

          statusEl.textContent = 'Generating bundled zip...';
          const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }, (meta) => {
            const pct = Math.round(50 + (meta.percent * 0.5));
            pctEl.textContent = `${pct}%`;
            setSegmentedProgress('unzipSegTrack', pct, 'blue');
          });

          const baseName = data.file.name.replace(/\.[^.]+$/, '') || 'archive';
          const outName = `${baseName}_bundle.zip`;
          const url = URL.createObjectURL(zipBlob);
          archiverState.unzipBlobUrls.push(url);

          const a = document.createElement('a');
          a.href = url;
          a.download = outName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 10000);

          statusEl.textContent = `All ${data.entries.length} files bundled as ZIP`;
          pctEl.textContent = '100%';
          setSegmentedProgress('unzipSegTrack', 100, 'teal');
          showToast(`Downloaded ${outName}`, 'success');
          logLine(`Archiver: bundled ${data.entries.length} files from ${data.file.name} into ${outName}`);
        } catch (err) {
          showToast(`Failed to bundle files: ${err.message}`, 'error');
          logLine(`Archiver bundle error: ${err.message}`);
        } finally {
          archiverState.busy.unpack = false;
          btn.disabled = false;
        }
      }

      export function clearUnzipQueue() {
        if (archiverState.unzipBlobUrls.length > 0) {
          archiverState.unzipBlobUrls.forEach((u) => URL.revokeObjectURL(u));
          archiverState.unzipBlobUrls = [];
        }
        archiverState.unzipData = null;
        document.getElementById('unzipFileCard').classList.add('hidden');
        document.getElementById('unzipProgressBox').classList.add('hidden');
        document.getElementById('unzipFileList').innerHTML = '';
        document.getElementById('unzipExtractAllBtn').disabled = true;
      }


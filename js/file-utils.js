import {
  $, $$, escapeHtml, logLine, showToast, formatBytes, baseName, extOf,
  wireDropzone, buildSegmentedTrack, setSegmentedProgress, copyToClipboard
} from './dom.js';
import { ensureDependency } from './vendors.js';

// Archiver sub navigation
export function switchArchiverSub(subId) {
  $$('.archiver-sub-btn').forEach((btn) => {
    const active = btn.dataset.archiverSub === subId;
    btn.classList.toggle('px-btn-primary', active);
    if (!active) btn.style.color = 'var(--text-muted)';
    else btn.style.color = '';
  });
  $$('.archiver-sub-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `archiver-panel-${subId}`);
  });
}

// OpSec sub navigation
export function switchOpsecSub(subId) {
  $$('.opsec-sub-btn').forEach((btn) => {
    const active = btn.dataset.opsecSub === subId;
    btn.classList.toggle('px-btn-primary', active);
    if (!active) btn.style.color = 'var(--text-muted)';
    else btn.style.color = '';
  });
  $$('.opsec-sub-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `opsec-panel-${subId}`);
  });
}

let splitSourceFile = null;
let joinPartFiles = [];

function handleSplitSourceFile(file) {
  if (!file) return;
  if (file.size === 0) {
    showToast('File is empty (0 B)', 'warning');
    return;
  }
  splitSourceFile = file;
  const pill = $('#splitFilePill');
  if (pill) pill.textContent = `${file.name} · ${formatBytes(file.size)}`;

  updateSplitPartEstimate();
  const runBtn = $('#splitRunBtn');
  if (runBtn) runBtn.disabled = false;
  showToast(`Loaded ${file.name} for splitting`, 'info');
}

function getChosenSplitChunkSize() {
  const sel = $('#splitSizeSelect') ? $('#splitSizeSelect').value : '25';
  if (sel === 'custom') {
    const customMb = parseFloat($('#splitCustomMbInput') ? $('#splitCustomMbInput').value : '10') || 10;
    return Math.max(1, Math.round(customMb * 1024 * 1024));
  }
  return parseInt(sel, 10) * 1024 * 1024;
}

function updateSplitPartEstimate() {
  if (!splitSourceFile) return;
  const chunkSize = getChosenSplitChunkSize();
  const partCount = Math.ceil(splitSourceFile.size / chunkSize);
  const pill = $('#splitEstimatePill');
  if (pill) {
    if (partCount > 500) {
      pill.textContent = `Warning: Will generate ${partCount} parts (exceeds 500 limit). Please choose a larger chunk size.`;
      pill.style.color = 'var(--rose)';
    } else {
      pill.textContent = `Will generate ${partCount} part(s) of ~${formatBytes(chunkSize)}`;
      pill.style.color = '';
    }
  }
}

async function runSplitFile() {
  if (!splitSourceFile) return;
  const btn = $('#splitRunBtn');
  if (btn) btn.disabled = true;

  const chunkSize = getChosenSplitChunkSize();
  const total = splitSourceFile.size;
  const partCount = Math.ceil(total / chunkSize);

  if (partCount > 500) {
    showToast('Chunk size generates over 500 parts. Please choose a larger chunk size.', 'warning');
    if (btn) btn.disabled = false;
    return;
  }

  const progWrap = $('#splitProgressWrap');
  if (progWrap) progWrap.classList.remove('hidden');
  buildSegmentedTrack('splitSegTrack', 20);
  setSegmentedProgress('splitSegTrack', 5, 'blue');

  try {
    const parts = [];
    for (let i = 0; i < partCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(total, start + chunkSize);
      const slice = splitSourceFile.slice(start, end);
      const partNum = String(i + 1).padStart(3, '0');
      const partName = `${splitSourceFile.name}.part${partNum}`;
      parts.push({ name: partName, blob: slice });

      const pct = Math.round(((i + 1) / partCount) * 80);
      setSegmentedProgress('splitSegTrack', pct, 'teal');
      if ($('#splitPct')) $('#splitPct').textContent = `${pct}%`;
    }

    // If total size <= 500 MB, bundle in zip
    if (total <= 500 * 1024 * 1024) {
      logLine(`Bundling ${parts.length} split parts into a single ZIP archive...`);
      await ensureDependency('jszip', () => Boolean(window.JSZip));
      const zip = new window.JSZip();
      for (const p of parts) {
        zip.file(p.name, p.blob);
      }
      setSegmentedProgress('splitSegTrack', 90, 'teal');
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(zipBlob, `${splitSourceFile.name}_split_parts.zip`);
      showToast(`Split into ${parts.length} parts and downloaded as ZIP`, 'success');
    } else {
      // Sequential download for large files
      logLine(`Sequential download of ${parts.length} multi gigabyte parts...`);
      for (let i = 0; i < parts.length; i++) {
        downloadBlob(parts[i].blob, parts[i].name);
        await new Promise((r) => setTimeout(r, 600));
      }
      showToast(`Downloaded ${parts.length} split part files sequentially`, 'success');
    }

    setSegmentedProgress('splitSegTrack', 100, 'teal');
    if ($('#splitPct')) $('#splitPct').textContent = '100%';
  } catch (err) {
    showToast(`Splitting failed: ${err.message}`, 'danger');
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => {
      if (progWrap) progWrap.classList.add('hidden');
    }, 1500);
  }
}

function addJoinParts(files) {
  if (!files || !files.length) return;
  for (const f of files) {
    if (!joinPartFiles.some((existing) => existing.name === f.name)) {
      joinPartFiles.push(f);
    }
  }
  renderJoinList();
}

function renderJoinList() {
  const container = $('#joinPartsList');
  if (!container) return;
  container.innerHTML = '';

  // Sort naturally by part suffix .part001, .part002
  joinPartFiles.sort((a, b) => {
    const ma = a.name.match(/\.part(\d+)$/i);
    const mb = b.name.match(/\.part(\d+)$/i);
    const na = ma ? parseInt(ma[1], 10) : 0;
    const nb = mb ? parseInt(mb[1], 10) : 0;
    return na - nb;
  });

  const countPill = $('#joinSummaryPill');
  const totalBytes = joinPartFiles.reduce((acc, f) => acc + f.size, 0);
  if (countPill) countPill.textContent = `${joinPartFiles.length} part(s) · ${formatBytes(totalBytes)} combined`;

  const runBtn = $('#joinRunBtn');
  if (runBtn) runBtn.disabled = joinPartFiles.length === 0;

  if (joinPartFiles.length === 0) {
    container.innerHTML = `<div style="padding:1.25rem;text-align:center;color:var(--text-muted);">No .part001, .part002 files queued yet.</div>`;
    return;
  }

  joinPartFiles.forEach((file, idx) => {
    const row = document.createElement('div');
    row.className = 'flex-row justify-between items-center';
    row.style.padding = '0.35rem 0.6rem';
    row.style.borderBottom = '1px solid var(--border-px)';
    row.style.fontSize = '0.75rem';

    row.innerHTML = `
      <div class="flex-row items-center gap-2">
        <span class="badge badge-teal font-mono-tech">Part ${idx + 1}</span>
        <span style="color:var(--text-main);">${escapeHtml(file.name)}</span>
      </div>
      <div class="flex-row items-center gap-2 font-mono-tech">
        <span style="color:var(--text-muted);">${formatBytes(file.size)}</span>
        <button type="button" class="px-btn px-btn-rose font-mono-tech btn-rm-part" style="padding:0.15rem 0.4rem;font-size:0.6875rem;">✕</button>
      </div>
    `;

    row.querySelector('.btn-rm-part').addEventListener('click', () => {
      joinPartFiles.splice(idx, 1);
      renderJoinList();
    });

    container.appendChild(row);
  });
}

function runJoinFiles() {
  if (joinPartFiles.length === 0) return;

  // Derive target filename by stripping .part001 suffix
  const first = joinPartFiles[0].name;
  let targetName = first.replace(/\.part\d+$/i, '');
  if (!targetName || targetName === first) targetName = `${first}_restored.bin`;

  try {
    const combinedBlob = new Blob(joinPartFiles, { type: 'application/octet-stream' });
    downloadBlob(combinedBlob, targetName);
    showToast(`Joined ${joinPartFiles.length} parts into ${targetName} (${formatBytes(combinedBlob.size)})`, 'success');
  } catch (err) {
    showToast(`Join failed: ${err.message}`, 'danger');
  }
}

let renamerFiles = [];

function addRenamerFiles(files) {
  if (!files || !files.length) return;
  for (const f of files) {
    if (!renamerFiles.some((it) => it.file.name === f.name && it.file.size === f.size)) {
      renamerFiles.push({ file: f, newName: f.name });
    }
  }
  updateRenamerPreview();
}

function updateRenamerPreview() {
  const prefix = ($('#renamePrefix') ? $('#renamePrefix').value : '') || '';
  const suffix = ($('#renameSuffix') ? $('#renameSuffix').value : '') || '';
  const findStr = ($('#renameFind') ? $('#renameFind').value : '') || '';
  const replaceStr = ($('#renameReplace') ? $('#renameReplace').value : '') || '';
  const caseFmt = ($('#renameCase') ? $('#renameCase').value : 'keep') || 'keep';
  const numbering = $('#renameNumbering') ? $('#renameNumbering').checked : false;
  const startNum = parseInt($('#renameStartNum') ? $('#renameStartNum').value : '1', 10) || 1;

  renamerFiles.forEach((item, idx) => {
    let name = baseName(item.file.name);
    const ext = extOf(item.file.name);

    // Find and replace
    if (findStr) {
      name = name.split(findStr).join(replaceStr);
    }

    // Case formatting
    if (caseFmt === 'lower') name = name.toLowerCase();
    else if (caseFmt === 'upper') name = name.toUpperCase();
    else if (caseFmt === 'title') {
      name = name.replace(/\b\w/g, (c) => c.toUpperCase());
    } else if (caseFmt === 'clean') {
      name = name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    }

    // Sequential numbering
    let numStr = '';
    if (numbering) {
      const num = String(startNum + idx).padStart(3, '0');
      numStr = `_${num}`;
    }

    const finalBase = `${prefix}${name}${suffix}${numStr}`;
    item.newName = ext ? `${finalBase}.${ext}` : finalBase;
  });

  // Collision prevention: resolve duplicate names in batch
  const seen = new Map();
  renamerFiles.forEach((item) => {
    let candidate = item.newName;
    const ext = extOf(candidate);
    const bName = baseName(candidate);
    const lowerKey = candidate.toLowerCase();
    if (seen.has(lowerKey)) {
      const count = seen.get(lowerKey) + 1;
      seen.set(lowerKey, count);
      candidate = ext ? `${bName}_${count}.${ext}` : `${bName}_${count}`;
    } else {
      seen.set(lowerKey, 0);
    }
    item.newName = candidate;
  });

  renderRenamerTable();
}

function renderRenamerTable() {
  const tbody = $('#renameTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const pill = $('#renameCountPill');
  if (pill) pill.textContent = `${renamerFiles.length} file(s) queued for rename`;

  const runBtn = $('#renameRunBtn');
  if (runBtn) runBtn.disabled = renamerFiles.length === 0;

  if (renamerFiles.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:1.25rem;">No files queued for batch rename yet.</td></tr>`;
    return;
  }

  renamerFiles.forEach((item, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="color:var(--text-muted);font-size:0.75rem;">${escapeHtml(item.file.name)}</td>
      <td style="color:var(--teal);font-weight:600;font-size:0.75rem;">${escapeHtml(item.newName)}</td>
      <td style="text-align:right;">
        <button type="button" class="px-btn px-btn-rose font-mono-tech btn-rm-ren" style="padding:0.15rem 0.4rem;font-size:0.6875rem;">✕</button>
      </td>
    `;

    tr.querySelector('.btn-rm-ren').addEventListener('click', () => {
      renamerFiles.splice(idx, 1);
      updateRenamerPreview();
    });

    tbody.appendChild(tr);
  });
}

async function runBatchRenameDownload() {
  if (renamerFiles.length === 0) return;
  const btn = $('#renameRunBtn');
  if (btn) btn.disabled = true;

  try {
    await ensureDependency('jszip', () => Boolean(window.JSZip));
    const zip = new window.JSZip();

    for (const item of renamerFiles) {
      const buf = await item.file.arrayBuffer();
      zip.file(item.newName, buf);
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(zipBlob, 'renamed_files_bundle.zip');
    showToast(`Exported ${renamerFiles.length} renamed files in ZIP`, 'success');
  } catch (err) {
    showToast(`Rename export failed: ${err.message}`, 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

let encodedPayload = '';
let encodedFilename = 'encoded_data.txt';

async function handleEncodeFile(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    showToast('File exceeds 25 MB safety limit for text conversion', 'warning');
    return;
  }

  const fmt = $('#encodeFormatSelect') ? $('#encodeFormatSelect').value : 'base64';
  const pill = $('#encodeFilePill');
  if (pill) pill.textContent = `${file.name} · ${formatBytes(file.size)}`;

  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    if (fmt === 'hex') {
      let hex = '';
      for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0').toUpperCase() + ' ';
      }
      encodedPayload = hex.trim();
    } else {
      let binary = '';
      const len = bytes.byteLength;
      for (let i = 0; i < len; i += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(len, i + 8192)));
      }
      const b64 = btoa(binary);
      if (fmt === 'datauri') {
        const mime = file.type || 'application/octet-stream';
        encodedPayload = `data:${mime};base64,${b64}`;
      } else {
        encodedPayload = b64;
      }
    }

    const preview = $('#encodePreviewArea');
    if (preview) {
      preview.value = encodedPayload.length > 2000
        ? `${encodedPayload.slice(0, 2000)}\n\n[... +${encodedPayload.length - 2000} more characters]`
        : encodedPayload;
    }

    const copyBtn = $('#encodeCopyBtn');
    const dlBtn = $('#encodeDownloadBtn');
    if (copyBtn) copyBtn.disabled = false;
    if (dlBtn) dlBtn.disabled = false;

    encodedFilename = `${baseName(file.name)}_${fmt}.txt`;
    showToast(`Encoded ${file.name} (${encodedPayload.length} chars)`, 'success');
  } catch (err) {
    showToast(`Encoding failed: ${err.message}`, 'danger');
  }
}

function copyEncodedText() {
  if (!encodedPayload) return;
  copyToClipboard(encodedPayload, 'Encoded Text');
}

function downloadEncodedText() {
  if (!encodedPayload) return;
  const blob = new Blob([encodedPayload], { type: 'text/plain' });
  downloadBlob(blob, encodedFilename);
  showToast('Downloaded encoded text file', 'success');
}

function runDecodeTextToFile() {
  const input = $('#decodeTextInput');
  if (!input || !input.value.trim()) {
    showToast('Please paste Base64, Data URI, or Hex text to decode', 'warning');
    return;
  }
  let raw = input.value.trim();
  const filename = ($('#decodeFilenameInput') ? $('#decodeFilenameInput').value.trim() : '') || 'decoded_file.bin';

  try {
    let bytes = null;
    let mime = 'application/octet-stream';

    if (raw.startsWith('data:')) {
      const commaIdx = raw.indexOf(',');
      if (commaIdx !== -1) {
        const header = raw.slice(5, commaIdx);
        if (header.includes(';')) mime = header.split(';')[0];
        raw = raw.slice(commaIdx + 1);
      }
    }

    const cleanHex = raw.replace(/[\s:,\-]+/g, '');
    const isHexFormat = /^[0-9a-fA-F]+$/.test(cleanHex) && cleanHex.length % 2 === 0;
    const hasHexDelimiters = /[\s:,]/.test(raw) || raw.startsWith('0x');

    if (isHexFormat && (hasHexDelimiters || cleanHex.length <= 8 || raw.toLowerCase().startsWith('0x'))) {
      const len = cleanHex.length / 2;
      bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
      }
    } else {
      const cleanB64 = raw.replace(/\s+/g, '');
      if (cleanB64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleanB64)) {
        if (isHexFormat) {
          const len = cleanHex.length / 2;
          bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
          }
        } else {
          throw new Error('Invalid Base64 or Hex input');
        }
      } else {
        const binary = atob(cleanB64);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
      }
    }

    const blob = new Blob([bytes], { type: mime });
    downloadBlob(blob, filename);
    showToast(`Decoded ${filename} (${formatBytes(blob.size)})`, 'success');
  } catch (err) {
    showToast('Invalid Base64 or Hex input', 'danger');
  }
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 2000);
}

export function initFileUtils() {
  $$('.archiver-sub-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchArchiverSub(btn.dataset.archiverSub));
  });

  $$('.opsec-sub-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchOpsecSub(btn.dataset.opsecSub));
  });

  wireDropzone('splitDropzone', 'splitInput', (files) => {
    if (files && files.length) handleSplitSourceFile(files[0]);
  }, false);

  const splitSel = $('#splitSizeSelect');
  if (splitSel) {
    splitSel.addEventListener('change', () => {
      $('#splitCustomWrap')?.classList.toggle('hidden', splitSel.value !== 'custom');
      updateSplitPartEstimate();
    });
  }

  $('#splitCustomMbInput')?.addEventListener('input', updateSplitPartEstimate);
  $('#splitRunBtn')?.addEventListener('click', runSplitFile);

  wireDropzone('joinDropzone', 'joinInput', addJoinParts, true);
  $('#joinRunBtn')?.addEventListener('click', runJoinFiles);
  $('#joinClearBtn')?.addEventListener('click', () => {
    joinPartFiles = [];
    renderJoinList();
  });

  wireDropzone('renameDropzone', 'renameInput', addRenamerFiles, true);
  ['#renamePrefix', '#renameSuffix', '#renameFind', '#renameReplace', '#renameCase', '#renameStartNum'].forEach((id) => {
    $(id)?.addEventListener('input', updateRenamerPreview);
  });
  $('#renameNumbering')?.addEventListener('change', updateRenamerPreview);
  $('#renameRunBtn')?.addEventListener('click', runBatchRenameDownload);
  $('#renameClearBtn')?.addEventListener('click', () => {
    renamerFiles = [];
    updateRenamerPreview();
  });

  wireDropzone('encodeDropzone', 'encodeInput', (files) => {
    if (files && files.length) handleEncodeFile(files[0]);
  }, false);

  $('#encodeFormatSelect')?.addEventListener('change', () => {
    const dropInput = $('#encodeInput');
    if (dropInput?.files?.[0]) {
      handleEncodeFile(dropInput.files[0]);
    }
  });

  $('#encodeCopyBtn')?.addEventListener('click', copyEncodedText);
  $('#encodeDownloadBtn')?.addEventListener('click', downloadEncodedText);
  $('#decodeRunBtn')?.addEventListener('click', runDecodeTextToFile);
}

import {
  $, $$, escapeHtml, logLine, showToast, formatBytes, baseName, extOf,
  wireDropzone, SVG_DOC, SVG_PHOTO
} from './dom.js';
import { ensurePdfLib } from './vendors.js';
import { ensureDependency } from './vendors.js';

let editorDoc = null;
let editorFile = null;
let editorPages = [];

let mergeFiles = [];

let splitDoc = null;
let splitFile = null;

let scrubDoc = null;
let scrubFile = null;

let imgPdfQueue = [];

export function switchDocSub(subId) {
  $$('.doc-sub-btn').forEach((btn) => {
    const active = btn.dataset.docSub === subId;
    btn.classList.toggle('px-btn-primary', active);
    if (!active) btn.style.color = 'var(--text-muted)';
    else btn.style.color = '';
  });
  $$('.doc-sub-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `doc-panel-${subId}`);
  });
}

function isEncryptedPdfError(err) {
  const msg = (err && err.message ? err.message : String(err)).toLowerCase();
  return msg.includes('encrypt') || msg.includes('password') || msg.includes('decrypt');
}

async function handleEditorFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
    showToast('Please select a valid PDF file', 'warning');
    return;
  }
  editorFile = file;
  try {
    const { PDFDocument } = await ensurePdfLib();
    const buf = await file.arrayBuffer();
    editorDoc = await PDFDocument.load(buf);
    const count = editorDoc.getPageCount();
    editorPages = [];

    for (let i = 0; i < count; i++) {
      const page = editorDoc.getPage(i);
      const { width, height } = page.getSize();
      editorPages.push({
        origIndex: i,
        rotation: page.getRotation().angle || 0,
        width: Math.round(width),
        height: Math.round(height),
        deleted: false,
      });
    }

    $('#pdfEditorDropzone').classList.add('hidden');
    $('#pdfEditorWorkspace').classList.remove('hidden');
    renderEditorPages();
    logLine(`Loaded PDF into Page Editor: ${file.name} (${count} pages)`);
  } catch (err) {
    if (isEncryptedPdfError(err)) {
      showToast('Encrypted or password protected PDF is not supported', 'warning');
    } else {
      showToast(`Failed to parse PDF: ${err.message}`, 'danger');
    }
  }
}

function renderEditorPages() {
  const grid = $('#pdfEditorGrid');
  if (!grid) return;
  grid.innerHTML = '';

  const activeCount = editorPages.filter((p) => !p.deleted).length;
  const countPill = $('#pdfEditorPageCount');
  if (countPill) countPill.textContent = `${activeCount} of ${editorPages.length} pages kept`;

  editorPages.forEach((page, displayIdx) => {
    const card = document.createElement('div');
    card.className = `px-card stack-2 ${page.deleted ? 'page-dimmed' : ''}`;
    card.style.position = 'relative';
    card.style.border = page.deleted ? '2px dashed var(--border-px)' : '2px solid var(--border-px)';
    card.style.opacity = page.deleted ? '0.45' : '1';
    card.style.transition = 'all 0.15s ease';

    const inW = (page.width / 72).toFixed(1);
    const inH = (page.height / 72).toFixed(1);

    card.innerHTML = `
      <div class="flex-row justify-between items-center" style="border-bottom:1px solid var(--border-px);padding-bottom:0.35rem;">
        <span class="badge ${page.deleted ? 'badge-rose' : 'badge-blue'} font-mono-tech" style="font-weight:700;">Page ${page.origIndex + 1}</span>
        <span class="sub-muted font-mono-tech" style="font-size:0.6875rem;">${page.rotation}°</span>
      </div>
      <div style="height:6rem;background:var(--bg-deep);display:flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid var(--border-px);">
        ${SVG_DOC}
        <span class="sub-muted font-mono-tech" style="font-size:0.6875rem;margin-top:0.25rem;">${inW} x ${inH} in</span>
        <span class="sub-muted font-mono-tech" style="font-size:0.625rem;">${page.width} x ${page.height} pt</span>
      </div>
      <div class="flex-row justify-between gap-1" style="margin-top:0.25rem;">
        <div class="flex-row gap-1">
          <button type="button" class="px-btn font-mono-tech btn-move-left" style="padding:0.2rem 0.45rem;font-size:0.6875rem;" ${displayIdx === 0 ? 'disabled' : ''}>←</button>
          <button type="button" class="px-btn font-mono-tech btn-move-right" style="padding:0.2rem 0.45rem;font-size:0.6875rem;" ${displayIdx === editorPages.length - 1 ? 'disabled' : ''}>→</button>
          <button type="button" class="px-btn font-mono-tech btn-rotate" style="padding:0.2rem 0.45rem;font-size:0.6875rem;" title="Rotate 90 degrees">↻ 90°</button>
        </div>
        <button type="button" class="px-btn font-mono-tech ${page.deleted ? 'px-btn-teal' : 'px-btn-rose'} btn-toggle-del" style="padding:0.2rem 0.5rem;font-size:0.6875rem;">
          ${page.deleted ? 'Undo' : 'Delete'}
        </button>
      </div>
    `;

    card.querySelector('.btn-move-left').addEventListener('click', () => {
      if (displayIdx > 0) {
        const tmp = editorPages[displayIdx - 1];
        editorPages[displayIdx - 1] = editorPages[displayIdx];
        editorPages[displayIdx] = tmp;
        renderEditorPages();
      }
    });

    card.querySelector('.btn-move-right').addEventListener('click', () => {
      if (displayIdx < editorPages.length - 1) {
        const tmp = editorPages[displayIdx + 1];
        editorPages[displayIdx + 1] = editorPages[displayIdx];
        editorPages[displayIdx] = tmp;
        renderEditorPages();
      }
    });

    card.querySelector('.btn-rotate').addEventListener('click', () => {
      page.rotation = (page.rotation + 90) % 360;
      renderEditorPages();
    });

    card.querySelector('.btn-toggle-del').addEventListener('click', () => {
      page.deleted = !page.deleted;
      renderEditorPages();
    });

    grid.appendChild(card);
  });
}

function applyQuickPageFilter() {
  const input = $('#pdfPageFilterInput');
  if (!input || !input.value.trim()) return;
  const raw = input.value.trim();
  const normalized = raw.replace(/\s+to\s+/gi, '-');
  const parts = normalized.split(/[,;\s]+/);
  const targets = new Set();

  parts.forEach((p) => {
    const rangeMatch = p.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const s = parseInt(rangeMatch[1], 10);
      const e = parseInt(rangeMatch[2], 10);
      for (let n = Math.min(s, e); n <= Math.max(s, e); n++) targets.add(n);
    } else {
      const singleMatch = p.match(/^(\d+)$/);
      if (singleMatch) {
        const single = parseInt(singleMatch[1], 10);
        if (!isNaN(single)) targets.add(single);
      }
    }
  });

  let markedCount = 0;
  editorPages.forEach((p) => {
    const pageNum = p.origIndex + 1;
    if (targets.has(pageNum)) {
      p.deleted = true;
      markedCount++;
    }
  });

  renderEditorPages();
  showToast(`Marked ${markedCount} page(s) for deletion`, 'info');
}

async function exportEditedPdf() {
  if (!editorDoc) return;
  const kept = editorPages.filter((p) => !p.deleted);
  if (kept.length === 0) {
    showToast('Cannot export empty document. Please keep at least one page.', 'warning');
    return;
  }

  try {
    const { PDFDocument, degrees } = await ensurePdfLib();
    const newDoc = await PDFDocument.create();
    const origIndices = kept.map((p) => p.origIndex);
    const copied = await newDoc.copyPages(editorDoc, origIndices);

    copied.forEach((cp, idx) => {
      cp.setRotation(degrees(kept[idx].rotation));
      newDoc.addPage(cp);
    });

    const bytes = await newDoc.save();
    const origBase = editorFile ? baseName(editorFile.name) : 'document';
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${origBase}_edited.pdf`);
    showToast(`Exported edited PDF (${formatBytes(bytes.byteLength)})`, 'success');
  } catch (err) {
    showToast(`Export failed: ${err.message}`, 'danger');
  }
}

async function addMergeFiles(files) {
  if (!files || !files.length) return;
  const { PDFDocument } = await ensurePdfLib();

  for (const f of files) {
    if (!f.name.toLowerCase().endsWith('.pdf')) continue;
    try {
      const buf = await f.arrayBuffer();
      const doc = await PDFDocument.load(buf);
      mergeFiles.push({
        file: f,
        pageCount: doc.getPageCount(),
        size: f.size,
      });
    } catch (err) {
      if (isEncryptedPdfError(err)) {
        showToast(`Skipped ${f.name} (encrypted or password protected)`, 'warning');
      } else {
        showToast(`Could not parse ${f.name}`, 'warning');
      }
    }
  }
  renderMergeList();
}

function renderMergeList() {
  const tbody = $('#pdfMergeTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const totalPages = mergeFiles.reduce((acc, f) => acc + f.pageCount, 0);
  const pill = $('#pdfMergeSummary');
  if (pill) pill.textContent = `${mergeFiles.length} file(s) · ${totalPages} total pages`;

  const mergeBtn = $('#pdfMergeRunBtn');
  if (mergeBtn) mergeBtn.disabled = mergeFiles.length < 2;

  if (mergeFiles.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:1.25rem;">No PDF files added for merge yet.</td></tr>`;
    return;
  }

  mergeFiles.forEach((item, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:500;color:var(--text-main);">${escapeHtml(item.file.name)}</td>
      <td class="font-mono-tech">${item.pageCount} pages</td>
      <td class="font-mono-tech">${formatBytes(item.size)}</td>
      <td style="text-align:right;">
        <div class="flex-row gap-1 justify-end">
          <button type="button" class="px-btn font-mono-tech btn-m-up" style="padding:0.2rem 0.45rem;font-size:0.6875rem;" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="px-btn font-mono-tech btn-m-dn" style="padding:0.2rem 0.45rem;font-size:0.6875rem;" ${idx === mergeFiles.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="px-btn font-mono-tech px-btn-rose btn-m-rm" style="padding:0.2rem 0.45rem;font-size:0.6875rem;">✕</button>
        </div>
      </td>
    `;

    tr.querySelector('.btn-m-up').addEventListener('click', () => {
      if (idx > 0) {
        const tmp = mergeFiles[idx - 1];
        mergeFiles[idx - 1] = mergeFiles[idx];
        mergeFiles[idx] = tmp;
        renderMergeList();
      }
    });

    tr.querySelector('.btn-m-dn').addEventListener('click', () => {
      if (idx < mergeFiles.length - 1) {
        const tmp = mergeFiles[idx + 1];
        mergeFiles[idx + 1] = mergeFiles[idx];
        mergeFiles[idx] = tmp;
        renderMergeList();
      }
    });

    tr.querySelector('.btn-m-rm').addEventListener('click', () => {
      mergeFiles.splice(idx, 1);
      renderMergeList();
    });

    tbody.appendChild(tr);
  });
}

async function runMergePdfs() {
  if (mergeFiles.length < 2) return;
  const btn = $('#pdfMergeRunBtn');
  if (btn) btn.disabled = true;

  try {
    const { PDFDocument } = await ensurePdfLib();
    const mergedDoc = await PDFDocument.create();

    for (const item of mergeFiles) {
      const buf = await item.file.arrayBuffer();
      const doc = await PDFDocument.load(buf);
      const indices = doc.getPageIndices();
      const copied = await mergedDoc.copyPages(doc, indices);
      copied.forEach((p) => mergedDoc.addPage(p));
    }

    const bytes = await mergedDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), 'merged.pdf');
    showToast(`Merged ${mergeFiles.length} files successfully (${formatBytes(bytes.byteLength)})`, 'success');
  } catch (err) {
    showToast(`Merge failed: ${err.message}`, 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleSplitFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
    showToast('Please select a valid PDF file', 'warning');
    return;
  }
  splitFile = file;
  try {
    const { PDFDocument } = await ensurePdfLib();
    const buf = await file.arrayBuffer();
    splitDoc = await PDFDocument.load(buf);
    const count = splitDoc.getPageCount();

    $('#pdfSplitDropzone').classList.add('hidden');
    $('#pdfSplitWorkspace').classList.remove('hidden');

    const info = $('#pdfSplitInfo');
    if (info) info.textContent = `${file.name} · ${count} total pages · ${formatBytes(file.size)}`;

    const rangeInput = $('#pdfSplitRange');
    if (rangeInput && !rangeInput.value) rangeInput.value = `1 to ${Math.min(3, count)}`;

    logLine(`Loaded PDF into Splitter: ${file.name} (${count} pages)`);
  } catch (err) {
    if (isEncryptedPdfError(err)) {
      showToast('Encrypted or password protected PDF is not supported', 'warning');
    } else {
      showToast(`Failed to parse PDF: ${err.message}`, 'danger');
    }
  }
}

async function runSplitPdf() {
  if (!splitDoc) return;
  const total = splitDoc.getPageCount();
  const rangeStr = $('#pdfSplitRange').value.trim();
  const mode = $('#pdfSplitMode').value;

  const pageNums = parsePageRanges(rangeStr, total);
  if (pageNums.length === 0) {
    showToast('Please specify valid page numbers within document range', 'warning');
    return;
  }

  const { PDFDocument } = await ensurePdfLib();
  const origBase = splitFile ? baseName(splitFile.name) : 'document';

  if (mode === 'single') {
    const newDoc = await PDFDocument.create();
    const indices = pageNums.map((n) => n - 1);
    const copied = await newDoc.copyPages(splitDoc, indices);
    copied.forEach((p) => newDoc.addPage(p));
    const bytes = await newDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${origBase}_extracted.pdf`);
    showToast(`Extracted ${copied.length} pages into single PDF`, 'success');
  } else {
    // Individual PDFs in ZIP
    await ensureDependency('jszip', () => Boolean(window.JSZip));
    const zip = new window.JSZip();

    for (const n of pageNums) {
      const pageDoc = await PDFDocument.create();
      const [copied] = await pageDoc.copyPages(splitDoc, [n - 1]);
      pageDoc.addPage(copied);
      const bytes = await pageDoc.save();
      const pad = String(n).padStart(3, '0');
      zip.file(`page_${pad}.pdf`, bytes);
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(zipBlob, `${origBase}_pages_bundle.zip`);
    showToast(`Extracted ${pageNums.length} individual page PDFs into ZIP`, 'success');
  }
}

function parsePageRanges(str, max) {
  const normalized = str.replace(/\s+to\s+/gi, '-');
  const parts = normalized.split(/[,;\s]+/);
  const result = [];
  const set = new Set();

  parts.forEach((p) => {
    const match = p.match(/^(\d+)-(\d+)$/);
    if (match) {
      const s = parseInt(match[1], 10);
      const e = parseInt(match[2], 10);
      for (let i = Math.min(s, e); i <= Math.max(s, e); i++) {
        if (i >= 1 && i <= max && !set.has(i)) {
          set.add(i);
          result.push(i);
        }
      }
    } else {
      const singleMatch = p.match(/^(\d+)$/);
      if (singleMatch) {
        const n = parseInt(singleMatch[1], 10);
        if (!isNaN(n) && n >= 1 && n <= max && !set.has(n)) {
          set.add(n);
          result.push(n);
        }
      }
    }
  });

  return result.sort((a, b) => a - b);
}

async function handleScrubFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
    showToast('Please select a valid PDF file', 'warning');
    return;
  }
  scrubFile = file;
  try {
    const { PDFDocument } = await ensurePdfLib();
    const buf = await file.arrayBuffer();
    scrubDoc = await PDFDocument.load(buf);

    $('#pdfScrubDropzone').classList.add('hidden');
    $('#pdfScrubWorkspace').classList.remove('hidden');

    const fields = [
      { key: 'Title', val: scrubDoc.getTitle() || '' },
      { key: 'Author', val: scrubDoc.getAuthor() || '' },
      { key: 'Subject', val: scrubDoc.getSubject() || '' },
      { key: 'Keywords', val: scrubDoc.getKeywords() || '' },
      { key: 'Creator', val: scrubDoc.getCreator() || '' },
      { key: 'Producer', val: scrubDoc.getProducer() || '' },
      { key: 'Creation Date', val: scrubDoc.getCreationDate() ? scrubDoc.getCreationDate().toISOString() : '' },
      { key: 'Modification Date', val: scrubDoc.getModificationDate() ? scrubDoc.getModificationDate().toISOString() : '' },
    ];

    const tbody = $('#pdfScrubMetaTable');
    if (tbody) {
      tbody.innerHTML = '';
      fields.forEach(({ key, val }) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight:600;color:var(--text-main);width:10rem;">${key}</td>
          <td class="font-mono-tech" style="color:${val ? 'var(--accent-hi)' : 'var(--text-muted)'};">${escapeHtml(val || 'Empty / Not Set')}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    const readout = $('#pdfScrubReadout');
    if (readout) readout.classList.add('hidden');
  } catch (err) {
    if (isEncryptedPdfError(err)) {
      showToast('Encrypted or password protected PDF is not supported', 'warning');
    } else {
      showToast(`Failed to parse PDF: ${err.message}`, 'danger');
    }
  }
}

async function runScrubPdfMetadata() {
  if (!scrubDoc) return;
  try {
    const { PDFName } = await ensurePdfLib();

    // Clear standard /Info dictionary tags
    scrubDoc.setTitle('');
    scrubDoc.setAuthor('');
    scrubDoc.setSubject('');
    scrubDoc.setKeywords([]);
    scrubDoc.setCreator('');
    scrubDoc.setProducer('');

    // Remove XMP metadata stream from catalog if present
    try {
      if (scrubDoc.catalog && scrubDoc.catalog.delete) {
        scrubDoc.catalog.delete(PDFName.of('Metadata'));
      }
    } catch (_) {}

    const bytes = await scrubDoc.save();
    const origBase = scrubFile ? baseName(scrubFile.name) : 'document';
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${origBase}_sanitized.pdf`);

    const readout = $('#pdfScrubReadout');
    if (readout) {
      readout.classList.remove('hidden');
      readout.innerHTML = `
        <span class="badge badge-teal font-mono-tech">Sanitized</span>
        <p style="margin:0.25rem 0 0 0;font-size:0.75rem;color:var(--text-main);">
          All metadata fields cleared to blank. Zero tracking streams remaining.
        </p>
      `;
    }

    showToast('All PDF metadata tags stripped', 'success');
  } catch (err) {
    showToast(`Scrubbing failed: ${err.message}`, 'danger');
  }
}

function addImagesToPdf(files) {
  if (!files || !files.length) return;
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const url = URL.createObjectURL(f);
    imgPdfQueue.push({
      file: f,
      url,
      name: f.name,
      size: f.size,
    });
  }
  renderImagePdfQueue();
}

function renderImagePdfQueue() {
  const container = $('#imgPdfQueue');
  if (!container) return;
  container.innerHTML = '';

  const pill = $('#imgPdfSummary');
  if (pill) pill.textContent = `${imgPdfQueue.length} image(s) queued`;

  const runBtn = $('#imgPdfCompileBtn');
  if (runBtn) runBtn.disabled = imgPdfQueue.length === 0;

  if (imgPdfQueue.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; padding:2rem; text-align:center; color:var(--text-muted); border:2px dashed var(--border-px);">
        No images queued for PDF compile yet.
      </div>
    `;
    return;
  }

  let dragSrcIdx = null;

  imgPdfQueue.forEach((item, idx) => {
    const card = document.createElement('div');
    card.className = 'px-card stack-2';
    card.draggable = true;
    card.style.position = 'relative';
    card.style.cursor = 'grab';

    const padIdx = String(idx + 1).padStart(2, '0');

    card.innerHTML = `
      <div class="flex-row justify-between items-center" style="border-bottom:1px solid var(--border-px);padding-bottom:0.35rem;">
        <span class="badge badge-teal font-mono-tech" style="font-weight:700;">PAGE ${padIdx}</span>
        <button type="button" class="px-btn font-mono-tech px-btn-rose btn-img-del" style="padding:0.15rem 0.4rem;font-size:0.6875rem;">✕</button>
      </div>
      <div style="height:7rem;background:var(--bg-deep);display:flex;align-items:center;justify-content:center;overflow:hidden;border:1px solid var(--border-px);">
        <img src="${item.url}" alt="" style="max-height:100%;max-width:100%;object-fit:contain;" />
      </div>
      <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.6875rem;color:var(--text-main);" title="${escapeHtml(item.name)}">
        ${escapeHtml(item.name)}
      </div>
      <div class="flex-row justify-between items-center font-mono-tech" style="font-size:0.625rem;color:var(--text-muted);">
        <span>${formatBytes(item.size)}</span>
        <div class="flex-row gap-1">
          <button type="button" class="px-btn font-mono-tech btn-img-left" style="padding:0.15rem 0.35rem;" ${idx === 0 ? 'disabled' : ''}>←</button>
          <button type="button" class="px-btn font-mono-tech btn-img-right" style="padding:0.15rem 0.35rem;" ${idx === imgPdfQueue.length - 1 ? 'disabled' : ''}>→</button>
        </div>
      </div>
    `;

    card.addEventListener('dragstart', (e) => {
      dragSrcIdx = idx;
      e.dataTransfer.effectAllowed = 'move';
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragSrcIdx !== null && dragSrcIdx !== idx) {
        const moved = imgPdfQueue.splice(dragSrcIdx, 1)[0];
        imgPdfQueue.splice(idx, 0, moved);
        renderImagePdfQueue();
      }
    });

    card.querySelector('.btn-img-left').addEventListener('click', () => {
      if (idx > 0) {
        const tmp = imgPdfQueue[idx - 1];
        imgPdfQueue[idx - 1] = imgPdfQueue[idx];
        imgPdfQueue[idx] = tmp;
        renderImagePdfQueue();
      }
    });

    card.querySelector('.btn-img-right').addEventListener('click', () => {
      if (idx < imgPdfQueue.length - 1) {
        const tmp = imgPdfQueue[idx + 1];
        imgPdfQueue[idx + 1] = imgPdfQueue[idx];
        imgPdfQueue[idx] = tmp;
        renderImagePdfQueue();
      }
    });

    card.querySelector('.btn-img-del').addEventListener('click', () => {
      URL.revokeObjectURL(item.url);
      imgPdfQueue.splice(idx, 1);
      renderImagePdfQueue();
    });

    container.appendChild(card);
  });
}

function clearImagePdfQueue() {
  imgPdfQueue.forEach((it) => URL.revokeObjectURL(it.url));
  imgPdfQueue = [];
  renderImagePdfQueue();
}

async function imageToBytes(file) {
  if (!file || file.size === 0) return null;
  const type = file.type || '';
  if (type === 'image/jpeg' || type === 'image/jpg') {
    try {
      const buf = await file.arrayBuffer();
      if (buf.byteLength === 0) return null;
      return { kind: 'jpg', bytes: new Uint8Array(buf) };
    } catch (_) {
      return null;
    }
  }
  if (type === 'image/png') {
    try {
      const buf = await file.arrayBuffer();
      if (buf.byteLength === 0) return null;
      return { kind: 'png', bytes: new Uint8Array(buf) };
    } catch (_) {
      return null;
    }
  }
  // Convert WebP, BMP, AVIF to PNG via canvas
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    const loaded = await new Promise((res) => {
      img.onload = () => res(true);
      img.onerror = () => res(false);
      img.src = url;
    });
    if (!loaded || img.naturalWidth === 0 || img.naturalHeight === 0) return null;

    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    if (!blob || blob.size === 0) return null;
    const buf = await blob.arrayBuffer();
    return { kind: 'png', bytes: new Uint8Array(buf) };
  } catch (_) {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function runCompileImagesToPdf() {
  if (imgPdfQueue.length === 0) return;
  const btn = $('#imgPdfCompileBtn');
  if (btn) btn.disabled = true;

  try {
    const { PDFDocument } = await ensurePdfLib();
    const pdfDoc = await PDFDocument.create();
    const fitMode = $('#imgPdfPageFit').value;
    let compiledCount = 0;

    for (const item of imgPdfQueue) {
      const imgData = await imageToBytes(item.file);
      if (!imgData) {
        showToast(`Skipped unreadable image: ${item.file.name}`, 'warning');
        continue;
      }

      const { kind, bytes } = imgData;
      const embedded = kind === 'jpg'
        ? await pdfDoc.embedJpg(bytes)
        : await pdfDoc.embedPng(bytes);

      const { width, height } = embedded;

      if (fitMode === 'a4') {
        // A4 page: 595.28 x 841.89 points
        const pageW = 595.28;
        const pageH = 841.89;
        const page = pdfDoc.addPage([pageW, pageH]);
        const margin = 24;
        const maxW = pageW - margin * 2;
        const maxH = pageH - margin * 2;
        const scale = Math.min(maxW / width, maxH / height, 1.0);
        const drawW = width * scale;
        const drawH = height * scale;
        const x = margin + (maxW - drawW) / 2;
        const y = margin + (maxH - drawH) / 2;

        page.drawImage(embedded, {
          x,
          y,
          width: drawW,
          height: drawH,
        });
      } else {
        // Fit to image dimensions
        const page = pdfDoc.addPage([width, height]);
        page.drawImage(embedded, {
          x: 0,
          y: 0,
          width,
          height,
        });
      }
      compiledCount++;
    }

    if (compiledCount === 0) {
      showToast('No valid images available to compile', 'warning');
      return;
    }

    const pdfBytes = await pdfDoc.save();
    downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), 'images_bundle.pdf');
    showToast(`Compiled ${compiledCount} image(s) into PDF`, 'success');
  } catch (err) {
    showToast(`PDF compile failed: ${err.message}`, 'danger');
  } finally {
    if (btn) btn.disabled = false;
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

export function initPdfTools() {
  $$('.doc-sub-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchDocSub(btn.dataset.docSub));
  });

  wireDropzone('pdfEditorDropzone', 'pdfEditorInput', (files) => {
    if (files && files.length) handleEditorFile(files[0]);
  }, false);

  $('#pdfPageFilterBtn')?.addEventListener('click', applyQuickPageFilter);
  $('#pdfEditorExportBtn')?.addEventListener('click', exportEditedPdf);
  $('#pdfEditorResetBtn')?.addEventListener('click', () => {
    editorDoc = null;
    editorFile = null;
    editorPages = [];
    const edInp = $('#pdfEditorInput');
    if (edInp) edInp.value = '';
    const filterInp = $('#pdfPageFilterInput');
    if (filterInp) filterInp.value = '';
    $('#pdfEditorWorkspace')?.classList.add('hidden');
    $('#pdfEditorDropzone')?.classList.remove('hidden');
  });

  wireDropzone('pdfMergeDropzone', 'pdfMergeInput', addMergeFiles, true);
  $('#pdfMergeRunBtn')?.addEventListener('click', runMergePdfs);
  $('#pdfMergeClearBtn')?.addEventListener('click', () => {
    mergeFiles = [];
    const mgInp = $('#pdfMergeInput');
    if (mgInp) mgInp.value = '';
    renderMergeList();
  });

  wireDropzone('pdfSplitDropzone', 'pdfSplitInput', (files) => {
    if (files && files.length) handleSplitFile(files[0]);
  }, false);
  $('#pdfSplitRunBtn')?.addEventListener('click', runSplitPdf);
  $('#pdfSplitResetBtn')?.addEventListener('click', () => {
    splitDoc = null;
    splitFile = null;
    const spInp = $('#pdfSplitInput');
    if (spInp) spInp.value = '';
    const spRange = $('#pdfSplitRange');
    if (spRange) spRange.value = '';
    $('#pdfSplitWorkspace')?.classList.add('hidden');
    $('#pdfSplitDropzone')?.classList.remove('hidden');
  });

  wireDropzone('pdfScrubDropzone', 'pdfScrubInput', (files) => {
    if (files && files.length) handleScrubFile(files[0]);
  }, false);
  $('#pdfScrubRunBtn')?.addEventListener('click', runScrubPdfMetadata);
  $('#pdfScrubResetBtn')?.addEventListener('click', () => {
    scrubDoc = null;
    scrubFile = null;
    const scInp = $('#pdfScrubInput');
    if (scInp) scInp.value = '';
    $('#pdfScrubWorkspace')?.classList.add('hidden');
    $('#pdfScrubDropzone')?.classList.remove('hidden');
  });

  wireDropzone('imgPdfDropzone', 'imgPdfInput', addImagesToPdf, true);
  $('#imgPdfCompileBtn')?.addEventListener('click', runCompileImagesToPdf);
  $('#imgPdfClearBtn')?.addEventListener('click', () => {
    clearImagePdfQueue();
    const imgInp = $('#imgPdfInput');
    if (imgInp) imgInp.value = '';
  });

  $('#imgPdfSortAlphaBtn')?.addEventListener('click', () => {
    imgPdfQueue.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    renderImagePdfQueue();
    showToast('Queue sorted naturally from A to Z', 'info');
  });

  $('#imgPdfSortDateBtn')?.addEventListener('click', () => {
    imgPdfQueue.sort((a, b) => (a.file.lastModified || 0) - (b.file.lastModified || 0));
    renderImagePdfQueue();
    showToast('Queue sorted by modified date', 'info');
  });

  $('#imgPdfSortRevBtn')?.addEventListener('click', () => {
    imgPdfQueue.reverse();
    renderImagePdfQueue();
    showToast('Queue order reversed', 'info');
  });
}

import {
  $, $$, escapeHtml, logLine, showToast, formatBytes, baseName, extOf,
  wireDropzone, buildSegmentedTrack, setSegmentedProgress, SVG_PHOTO, SVG_BINARY, checkFileSizeGuardrail
} from './dom.js';

let extractedStrings = [];
let categorizedIocs = { urls: [], ips: [], emails: [], hashes: [] };
let activeIocFilter = 'all';
let lastStringsFile = null;

let diffFileA = null;
let diffFileB = null;

let tamperImage = null;
let tamperOriginalData = null;

export function switchForensicsSub(subId) {
  $$('.forensics-sub-btn').forEach((btn) => {
    const active = btn.dataset.forensicsSub === subId;
    btn.classList.toggle('px-btn-primary', active);
    if (!active) btn.style.color = 'var(--text-muted)';
    else btn.style.color = '';
  });
  $$('.forensics-sub-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `forensics-panel-${subId}`);
  });
}

async function handleStringsFile(file) {
  if (!file) return;
  if (!checkFileSizeGuardrail(file, false)) return;
  lastStringsFile = file;

  if (file.size === 0) {
    extractedStrings = [];
    categorizedIocs = { urls: [], ips: [], emails: [], hashes: [] };
    renderStringsResults();
    showToast('File is empty (0 B)', 'warning');
    return;
  }

  extractedStrings = [];
  const iocSets = { urls: new Set(), ips: new Set(), emails: new Set(), hashes: new Set() };
  categorizedIocs = { urls: [], ips: [], emails: [], hashes: [] };

  const minLen = Math.max(4, parseInt($('#stringsMinLen') ? $('#stringsMinLen').value : '6', 10) || 6);
  const progWrap = $('#stringsProgressWrap');
  if (progWrap) progWrap.classList.remove('hidden');
  buildSegmentedTrack('stringsSegTrack', 20);
  setSegmentedProgress('stringsSegTrack', 2, 'blue');

  const infoPill = $('#stringsFilePill');
  if (infoPill) infoPill.textContent = `${file.name} · ${formatBytes(file.size)}`;

  const chunkSize = 2 * 1024 * 1024;
  let offset = 0;
  const total = file.size;
  let carry = '';

  const urlRegex = /https?:\/\/[^\s"'<>\`]+/g;
  const ipRegex = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  const hashRegex = /\b(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\b/g;

  try {
    while (offset < total) {
      const slice = file.slice(offset, Math.min(total, offset + chunkSize));
      const buf = await slice.arrayBuffer();
      const bytes = new Uint8Array(buf);

      let cur = carry;
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b >= 32 && b <= 126) {
          cur += String.fromCharCode(b);
        } else {
          if (cur.length >= minLen) {
            extractedStrings.push(cur);
            checkIocs(cur, urlRegex, ipRegex, emailRegex, hashRegex, iocSets);
          }
          cur = '';
        }
      }
      carry = cur;
      offset += slice.size;

      const pct = Math.min(100, Math.round((offset / total) * 100));
      setSegmentedProgress('stringsSegTrack', pct, 'teal');
      if ($('#stringsPct')) $('#stringsPct').textContent = `${pct}%`;

      // Keep string array capped for memory safety if huge
      if (extractedStrings.length >= 50000) {
        logLine('Truncating strings view at 50,000 matches for browser performance');
        break;
      }
    }

    if (extractedStrings.length < 50000 && carry.length >= minLen) {
      extractedStrings.push(carry);
      checkIocs(carry, urlRegex, ipRegex, emailRegex, hashRegex, iocSets);
    }

    categorizedIocs = {
      urls: Array.from(iocSets.urls),
      ips: Array.from(iocSets.ips),
      emails: Array.from(iocSets.emails),
      hashes: Array.from(iocSets.hashes),
    };

    setSegmentedProgress('stringsSegTrack', 100, 'teal');
    if ($('#stringsPct')) $('#stringsPct').textContent = '100%';
    renderStringsResults();
    showToast(`Extracted ${extractedStrings.length} strings`, 'success');
  } catch (err) {
    showToast(`Strings extraction failed: ${err.message}`, 'danger');
  } finally {
    setTimeout(() => {
      if (progWrap) progWrap.classList.add('hidden');
    }, 1500);
  }
}

function checkIocs(str, urlRe, ipRe, emailRe, hashRe, iocSets) {
  const urls = str.match(urlRe);
  if (urls) urls.forEach((u) => iocSets.urls.add(u));

  const ips = str.match(ipRe);
  if (ips) ips.forEach((ip) => iocSets.ips.add(ip));

  const emails = str.match(emailRe);
  if (emails) emails.forEach((em) => iocSets.emails.add(em));

  const hashes = str.match(hashRe);
  if (hashes) hashes.forEach((h) => iocSets.hashes.add(h));
}

function renderStringsResults() {
  const container = $('#stringsResultList');
  if (!container) return;
  container.innerHTML = '';

  let list = extractedStrings;
  if (activeIocFilter === 'urls') list = categorizedIocs.urls;
  else if (activeIocFilter === 'ips') list = categorizedIocs.ips;
  else if (activeIocFilter === 'emails') list = categorizedIocs.emails;
  else if (activeIocFilter === 'hashes') list = categorizedIocs.hashes;

  const countPill = $('#stringsCountPill');
  if (countPill) countPill.textContent = `${list.length} item(s) found`;

  const exportTxtBtn = $('#stringsExportTxtBtn');
  const exportJsonBtn = $('#stringsExportJsonBtn');
  if (exportTxtBtn) exportTxtBtn.disabled = list.length === 0;
  if (exportJsonBtn) exportJsonBtn.disabled = list.length === 0;

  if (list.length === 0) {
    container.innerHTML = `<div style="padding:1.5rem;text-align:center;color:var(--text-muted);">No printable strings matching current filter.</div>`;
    return;
  }

  // Display top 1000 items in DOM for speed
  const displaySlice = list.slice(0, 1000);
  const frag = document.createDocumentFragment();

  displaySlice.forEach((item, idx) => {
    const row = document.createElement('div');
    row.style.padding = '0.25rem 0.5rem';
    row.style.borderBottom = '1px solid rgba(255,255,255,0.04)';
    row.style.display = 'flex';
    row.style.gap = '1rem';
    row.style.fontSize = '0.75rem';

    const num = String(idx + 1).padStart(4, '0');
    row.innerHTML = `
      <span style="color:var(--text-muted);width:3rem;flex-shrink:0;">${num}</span>
      <span style="color:var(--text-main);word-break:break-all;">${escapeHtml(item)}</span>
    `;
    frag.appendChild(row);
  });

  if (list.length > 1000) {
    const note = document.createElement('div');
    note.style.padding = '0.5rem';
    note.style.textAlign = 'center';
    note.style.color = 'var(--accent-hi)';
    note.textContent = `Showing first 1000 of ${list.length} items. Use Export to save the complete list.`;
    frag.appendChild(note);
  }

  container.appendChild(frag);
}

function exportStringsTxt() {
  let list = extractedStrings;
  if (activeIocFilter === 'urls') list = categorizedIocs.urls;
  else if (activeIocFilter === 'ips') list = categorizedIocs.ips;
  else if (activeIocFilter === 'emails') list = categorizedIocs.emails;
  else if (activeIocFilter === 'hashes') list = categorizedIocs.hashes;

  const text = list.join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  downloadBlob(blob, `extracted_${activeIocFilter}_strings.txt`);
  showToast('Exported strings text file', 'success');
}

function exportStringsJson() {
  const payload = {
    totalStrings: extractedStrings.length,
    iocs: categorizedIocs,
    sampleStrings: extractedStrings.slice(0, 10000),
  };
  const jsonStr = JSON.stringify(payload, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  downloadBlob(blob, 'extracted_iocs.json');
  showToast('Exported IOCs JSON file', 'success');
}

function setDiffFileA(file) {
  if (!file) return;
  if (!checkFileSizeGuardrail(file, false)) return;
  diffFileA = file;
  const pill = $('#diffFileAPill');
  if (pill) pill.textContent = `${file.name} (${formatBytes(file.size)})`;
  checkAndRunDiff();
}

function setDiffFileB(file) {
  if (!file) return;
  if (!checkFileSizeGuardrail(file, false)) return;
  diffFileB = file;
  const pill = $('#diffFileBPill');
  if (pill) pill.textContent = `${file.name} (${formatBytes(file.size)})`;
  checkAndRunDiff();
}

async function checkAndRunDiff() {
  if (!diffFileA || !diffFileB) return;
  const tbody = $('#diffTableBody');
  const summary = $('#diffSummaryPill');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:1.5rem;color:var(--text-muted);">Comparing binary bytes...</td></tr>`;

  try {
    const maxScan = 10 * 1024 * 1024;
    const scanLen = Math.min(diffFileA.size, diffFileB.size, maxScan);

    const bufA = await diffFileA.slice(0, scanLen).arrayBuffer();
    const bufB = await diffFileB.slice(0, scanLen).arrayBuffer();
    const bytesA = new Uint8Array(bufA);
    const bytesB = new Uint8Array(bufB);

    const diffs = [];
    let diffCount = 0;

    for (let i = 0; i < scanLen; i++) {
      if (bytesA[i] !== bytesB[i]) {
        diffCount++;
        if (diffs.length < 500) {
          diffs.push({
            offset: i,
            byteA: bytesA[i],
            byteB: bytesB[i],
          });
        }
      }
    }

    if (diffFileA.size !== diffFileB.size) {
      diffCount += Math.abs(diffFileA.size - diffFileB.size);
    }

    const matchPct = scanLen > 0 ? (((scanLen - diffCount) / scanLen) * 100).toFixed(2) : 100;
    if (summary) {
      if (diffCount === 0 && diffFileA.size === diffFileB.size) {
        summary.className = 'badge badge-teal font-mono-tech';
        summary.textContent = 'Files are 100% byte identical';
      } else {
        summary.className = 'badge badge-rose font-mono-tech';
        summary.textContent = `${diffCount} differing bytes found (${matchPct}% match)`;
      }
    }

    tbody.innerHTML = '';
    if (diffs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:1.5rem;color:var(--teal);">Zero differences detected within scanned range.</td></tr>`;
      return;
    }

    diffs.forEach(({ offset, byteA, byteB }) => {
      const tr = document.createElement('tr');
      const offHex = `0x${offset.toString(16).padStart(8, '0').toUpperCase()}`;
      const aHex = `0x${byteA.toString(16).padStart(2, '0').toUpperCase()}`;
      const bHex = `0x${byteB.toString(16).padStart(2, '0').toUpperCase()}`;
      const aAscii = (byteA >= 32 && byteA <= 126) ? String.fromCharCode(byteA) : '·';
      const bAscii = (byteB >= 32 && byteB <= 126) ? String.fromCharCode(byteB) : '·';

      tr.innerHTML = `
        <td class="font-mono-tech" style="color:var(--accent-hi);">${offHex}</td>
        <td class="font-mono-tech">${aHex} ('${escapeHtml(aAscii)}')</td>
        <td class="font-mono-tech" style="color:var(--rose);">${bHex} ('${escapeHtml(bAscii)}')</td>
        <td class="font-mono-tech" style="color:var(--text-muted);">${byteA ^ byteB}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    showToast(`Diff failed: ${err.message}`, 'danger');
  }
}

async function handleEntropyFile(file) {
  if (!file) return;
  if (!checkFileSizeGuardrail(file, false)) return;

  if (file.size === 0) {
    const entVal = $('#entropyValueText');
    if (entVal) entVal.textContent = '0.0000 bits per byte';
    const badge = $('#entropyVerdictBadge');
    if (badge) {
      badge.className = 'badge badge-blue font-mono-tech';
      badge.textContent = 'Empty File (0 B)';
    }
    drawEntropyHistogram(new Uint32Array(256), 0);
    showToast('File is empty (0 B)', 'warning');
    return;
  }

  const chunkSize = 2 * 1024 * 1024;
  let offset = 0;
  const total = file.size;
  const counts = new Uint32Array(256);

  try {
    while (offset < total) {
      const slice = file.slice(offset, Math.min(total, offset + chunkSize));
      const buf = await slice.arrayBuffer();
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
      offset += slice.size;
    }

    let entropy = 0;
    for (let i = 0; i < 256; i++) {
      if (counts[i] > 0) {
        const p = counts[i] / total;
        entropy -= p * (Math.log2 ? Math.log2(p) : Math.log(p) / Math.LN2);
      }
    }

    const entVal = $('#entropyValueText');
    if (entVal) entVal.textContent = `${entropy.toFixed(4)} bits per byte`;

    const badge = $('#entropyVerdictBadge');
    if (badge) {
      if (entropy < 5.0) {
        badge.className = 'badge badge-blue font-mono-tech';
        badge.textContent = 'Low / Plaintext or Repetitive (< 5.0)';
      } else if (entropy <= 7.5) {
        badge.className = 'badge badge-teal font-mono-tech';
        badge.textContent = 'Structured / Media or Executable (5.0 to 7.5)';
      } else {
        badge.className = 'badge badge-amber font-mono-tech';
        badge.textContent = 'High / Encrypted or Compressed (> 7.5)';
      }
    }

    drawEntropyHistogram(counts, total);
    showToast(`Entropy calculated: ${entropy.toFixed(4)} bits/byte`, 'info');
  } catch (err) {
    showToast(`Entropy calculation error: ${err.message}`, 'danger');
  }
}

function drawEntropyHistogram(counts, total) {
  const canvas = $('#entropyHistogramCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = '#070B14';
  ctx.fillRect(0, 0, 0 + w, h);

  let maxCount = 1;
  for (let i = 0; i < 256; i++) {
    if (counts[i] > maxCount) maxCount = counts[i];
  }

  const barW = w / 256;
  for (let i = 0; i < 256; i++) {
    const barH = (counts[i] / maxCount) * (h - 8);
    const x = i * barW;
    const y = h - barH;

    ctx.fillStyle = i < 32 ? '#60A5FA' : i > 126 ? '#F43F5E' : '#2DD4BF';
    ctx.fillRect(x, y, Math.max(1, barW), barH);
  }
}

async function handleTamperFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('Please select a valid image file', 'warning');
    return;
  }
  if (!checkFileSizeGuardrail(file, false)) return;

  const url = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    tamperImage = img;
    const canvas = $('#tamperCanvas');
    if (!canvas) return;

    const maxW = 800;
    const scale = Math.min(1.0, maxW / img.naturalWidth);
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    tamperOriginalData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    $('#tamperDropzone').classList.add('hidden');
    $('#tamperWorkspace').classList.remove('hidden');

    const pill = $('#tamperFilePill');
    if (pill) pill.textContent = `${file.name} · ${img.naturalWidth} x ${img.naturalHeight}`;

    URL.revokeObjectURL(url);
    logLine(`Loaded image into Tampering Lab: ${file.name}`);
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
    showToast('Failed to decode image', 'danger');
  };

  img.src = url;
}

function isolateLsbPlane(channel) {
  if (!tamperOriginalData) return;
  const canvas = $('#tamperCanvas');
  const ctx = canvas.getContext('2d');
  const orig = tamperOriginalData.data;
  const copy = ctx.createImageData(canvas.width, canvas.height);
  const d = copy.data;

  for (let i = 0; i < orig.length; i += 4) {
    if (channel === 'all') {
      d[i] = (orig[i] & 1) * 255;
      d[i + 1] = (orig[i + 1] & 1) * 255;
      d[i + 2] = (orig[i + 2] & 1) * 255;
      d[i + 3] = 255;
    } else {
      const chIdx = channel === 'r' ? 0 : channel === 'g' ? 1 : channel === 'b' ? 2 : 3;
      const bit = (orig[i + chIdx] & 1) * 255;
      d[i] = bit;
      d[i + 1] = bit;
      d[i + 2] = bit;
      d[i + 3] = 255;
    }
  }

  ctx.putImageData(copy, 0, 0);
  showToast(`Rendered LSB Bit Plane: ${channel.toUpperCase()}`, 'info');
}

async function runErrorLevelAnalysis() {
  if (!tamperOriginalData || !tamperImage) return;
  const canvas = $('#tamperCanvas');
  const ctx = canvas.getContext('2d');

  // Temporary canvas to re-compress as JPEG 90%
  const temp = document.createElement('canvas');
  temp.width = canvas.width;
  temp.height = canvas.height;
  const tctx = temp.getContext('2d');
  tctx.drawImage(tamperImage, 0, 0, canvas.width, canvas.height);

  const jpegDataUrl = temp.toDataURL('image/jpeg', 0.90);
  const recompressed = new Image();

  await new Promise((res) => {
    recompressed.onload = res;
    recompressed.src = jpegDataUrl;
  });

  tctx.drawImage(recompressed, 0, 0, canvas.width, canvas.height);
  const compData = tctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const origData = tamperOriginalData.data;

  const outData = ctx.createImageData(canvas.width, canvas.height);
  const d = outData.data;

  // 15x scale factor for ELA visibility
  for (let i = 0; i < origData.length; i += 4) {
    const diffR = Math.min(255, Math.abs(origData[i] - compData[i]) * 15);
    const diffG = Math.min(255, Math.abs(origData[i + 1] - compData[i + 1]) * 15);
    const diffB = Math.min(255, Math.abs(origData[i + 2] - compData[i + 2]) * 15);

    d[i] = diffR;
    d[i + 1] = diffG;
    d[i + 2] = diffB;
    d[i + 3] = 255;
  }

  ctx.putImageData(outData, 0, 0);
  showToast('Error Level Analysis (ELA) heatmap generated', 'success');
}

function resetTamperView() {
  if (!tamperOriginalData) return;
  const canvas = $('#tamperCanvas');
  const ctx = canvas.getContext('2d');
  ctx.putImageData(tamperOriginalData, 0, 0);
  showToast('Tamper view restored to original pixels', 'info');
}

function exportTamperCanvas() {
  const canvas = $('#tamperCanvas');
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, 'analyzed_tamper_render.png');
    showToast('Exported analyzed image', 'success');
  }, 'image/png');
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

export function initDeepForensics() {
  $$('.forensics-sub-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchForensicsSub(btn.dataset.forensicsSub));
  });

  wireDropzone('stringsDropzone', 'stringsInput', (files) => {
    if (files && files.length) handleStringsFile(files[0]);
  }, false);

  $('#stringsMinLen')?.addEventListener('change', () => {
    if (lastStringsFile) handleStringsFile(lastStringsFile);
  });

  $$('.ioc-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.ioc-filter-btn').forEach((b) => b.classList.remove('px-btn-primary'));
      btn.classList.add('px-btn-primary');
      activeIocFilter = btn.dataset.iocFilter;
      renderStringsResults();
    });
  });

  $('#stringsExportTxtBtn')?.addEventListener('click', exportStringsTxt);
  $('#stringsExportJsonBtn')?.addEventListener('click', exportStringsJson);

  wireDropzone('diffDropzoneA', 'diffInputA', (files) => {
    if (files && files.length) setDiffFileA(files[0]);
  }, false);
  wireDropzone('diffDropzoneB', 'diffInputB', (files) => {
    if (files && files.length) setDiffFileB(files[0]);
  }, false);

  wireDropzone('entropyDropzone', 'entropyInput', (files) => {
    if (files && files.length) handleEntropyFile(files[0]);
  }, false);

  wireDropzone('tamperDropzone', 'tamperInput', (files) => {
    if (files && files.length) handleTamperFile(files[0]);
  }, false);

  $('#lsbRBtn')?.addEventListener('click', () => isolateLsbPlane('r'));
  $('#lsbGBtn')?.addEventListener('click', () => isolateLsbPlane('g'));
  $('#lsbBBtn')?.addEventListener('click', () => isolateLsbPlane('b'));
  $('#lsbABtn')?.addEventListener('click', () => isolateLsbPlane('alpha'));
  $('#lsbAllBtn')?.addEventListener('click', () => isolateLsbPlane('all'));

  $('#runElaBtn')?.addEventListener('click', runErrorLevelAnalysis);
  $('#tamperResetBtn')?.addEventListener('click', resetTamperView);

  $('#tamperNewBtn')?.addEventListener('click', () => {
    tamperImage = null;
    tamperOriginalData = null;
    const inp = $('#tamperInput');
    if (inp) inp.value = '';
    $('#tamperWorkspace')?.classList.add('hidden');
    $('#tamperDropzone')?.classList.remove('hidden');
  });

  const tamperWs = $('#tamperWorkspace');
  if (tamperWs) {
    tamperWs.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    tamperWs.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        handleTamperFile(e.dataTransfer.files[0]);
      }
    });
  }

  $('#tamperExportBtn')?.addEventListener('click', exportTamperCanvas);
}

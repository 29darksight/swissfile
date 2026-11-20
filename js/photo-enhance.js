import {
  $, $$, escapeHtml, logLine, showToast, formatBytes, baseName, extOf,
  wireDropzone, buildSegmentedTrack, setSegmentedProgress, SVG_PHOTO
} from './dom.js';
import { ensureUpscaler } from './vendors.js';

let currentFile = null;
let sourceImage = null;
let sourceCanvas = null;
let processedCanvas = null;
let splitPercent = 50;
let isDraggingSplit = false;

const params = {
  exposure: 0,
  contrast: 0,
  vibrance: 0,
  warmth: 0,
  sharpen: 0,
  denoise: 0,
  upscale2x: false,
};

const MAX_CANVAS_DIM = 16384;
const MAX_CANVAS_MP = 100 * 1000000;

function clearCanvasMemory() {
  if (sourceCanvas) {
    sourceCanvas.width = 0;
    sourceCanvas.height = 0;
    sourceCanvas = null;
  }
  if (processedCanvas) {
    processedCanvas.width = 0;
    processedCanvas.height = 0;
    processedCanvas = null;
  }
}

function updateTelemetry() {
  const tel = $('#enhanceTelemetry');
  if (!tel) return;
  if (!sourceCanvas) {
    tel.textContent = 'No photo loaded';
    return;
  }
  const w = processedCanvas ? processedCanvas.width : sourceCanvas.width;
  const h = processedCanvas ? processedCanvas.height : sourceCanvas.height;
  const mp = ((w * h) / 1000000).toFixed(2);
  const sizeStr = currentFile ? formatBytes(currentFile.size) : '';
  const typeStr = currentFile ? (currentFile.type || extOf(currentFile.name).toUpperCase()) : '';
  tel.textContent = `${w} x ${h} (${mp} MP) · ${typeStr} · ${sizeStr}`;
}

function renderViewport() {
  const canvas = $('#enhanceCanvas');
  if (!canvas || !sourceCanvas) return;
  const ctx = canvas.getContext('2d');
  const target = processedCanvas || sourceCanvas;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const displayW = Math.max(300, Math.floor(rect.width || 800));
  const maxDisplayH = 520;
  const aspect = target.width / target.height;

  let dw = displayW;
  let dh = Math.round(displayW / aspect);
  if (dh > maxDisplayH) {
    dh = maxDisplayH;
    dw = Math.round(maxDisplayH * aspect);
  }

  canvas.width = Math.round(dw * dpr);
  canvas.height = Math.round(dh * dpr);
  canvas.style.width = `${dw}px`;
  canvas.style.height = `${dh}px`;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const splitX = Math.round((dw * splitPercent) / 100);

  ctx.drawImage(sourceCanvas, 0, 0, dw, dh);

  if (processedCanvas && splitX < dw) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, dw - splitX, dh);
    ctx.clip();
    ctx.drawImage(processedCanvas, 0, 0, dw, dh);
    ctx.restore();
  }

  ctx.strokeStyle = '#2DD4BF';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(splitX, 0);
  ctx.lineTo(splitX, dh);
  ctx.stroke();

  ctx.fillStyle = '#070B14';
  ctx.fillRect(splitX - 14, Math.round(dh / 2) - 14, 28, 28);
  ctx.strokeStyle = '#2DD4BF';
  ctx.lineWidth = 2;
  ctx.strokeRect(splitX - 14, Math.round(dh / 2) - 14, 28, 28);

  ctx.fillStyle = '#2DD4BF';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('◄►', splitX, Math.round(dh / 2));

  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(7, 11, 20, 0.75)';
  ctx.fillRect(10, 10, 68, 22);
  ctx.strokeStyle = 'rgba(96, 165, 250, 0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(10, 10, 68, 22);
  ctx.fillStyle = '#60A5FA';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Original', 18, 15);

  const enhW = 76;
  ctx.fillStyle = 'rgba(7, 11, 20, 0.75)';
  ctx.fillRect(dw - enhW - 10, 10, enhW, 22);
  ctx.strokeStyle = 'rgba(45, 212, 191, 0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(dw - enhW - 10, 10, enhW, 22);
  ctx.fillStyle = '#2DD4BF';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Enhanced', dw - enhW - 2, 15);

  ctx.restore();
  updateTelemetry();
}

export function processEnhancements() {
  if (!sourceCanvas) return;
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;

  let scale = 1;
  if (params.upscale2x) {
    if (srcW * 2 > MAX_CANVAS_DIM || srcH * 2 > MAX_CANVAS_DIM || (srcW * 2 * srcH * 2) > MAX_CANVAS_MP) {
      showToast('Image resolution is too large for 2x upscale. Maximum dimension is 16384 pixels.', 'warning');
      params.upscale2x = false;
      const upToggle = $('#enhance2xToggle');
      if (upToggle) upToggle.checked = false;
    } else {
      scale = 2;
    }
  }

  const outW = srcW * scale;
  const outH = srcH * scale;

  if (!processedCanvas) {
    processedCanvas = document.createElement('canvas');
  }
  processedCanvas.width = outW;
  processedCanvas.height = outH;

  const ctx = processedCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    showToast('Browser unable to allocate canvas memory', 'danger');
    return;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, outW, outH);

  const imgData = ctx.getImageData(0, 0, outW, outH);
  const data = imgData.data;
  const len = data.length;

  const expFactor = Math.pow(2, params.exposure / 100);
  const cVal = params.contrast;
  const contrastFactor = (259 * (cVal + 255)) / (255 * (259 - cVal));
  const warmth = params.warmth;
  const vib = params.vibrance / 100;

  for (let i = 0; i < len; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    if (params.exposure !== 0) {
      r *= expFactor;
      g *= expFactor;
      b *= expFactor;
    }

    if (cVal !== 0) {
      r = contrastFactor * (r - 128) + 128;
      g = contrastFactor * (g - 128) + 128;
      b = contrastFactor * (b - 128) + 128;
    }

    if (warmth !== 0) {
      r += warmth * 0.4;
      b -= warmth * 0.4;
    }

    if (vib !== 0) {
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
      const amt = (1 - sat) * vib * 0.8;
      const avg = (r + g + b) / 3;
      r += (r - avg) * amt;
      g += (g - avg) * amt;
      b += (b - avg) * amt;
    }

    data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }

  if (params.denoise > 0) {
    applyEdgeDenoise(imgData, outW, outH, params.denoise);
  }

  if (params.sharpen > 0) {
    applySmartSharpen(imgData, outW, outH, params.sharpen);
  }

  ctx.putImageData(imgData, 0, 0);
  renderViewport();
}

function applyEdgeDenoise(imgData, w, h, strength) {
  const src = new Uint8ClampedArray(imgData.data);
  const dst = imgData.data;
  const thresh = (strength / 100) * 45 + 5;
  const threshSq = thresh * thresh;

  for (let y = 1; y < h - 1; y++) {
    const rowIdx = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = (rowIdx + x) * 4;
      const cr = src[idx], cg = src[idx + 1], cb = src[idx + 2];

      let sumR = cr, sumG = cg, sumB = cb;
      let totalWeight = 1.0;

      const neighbors = [idx - 4, idx + 4, idx - w * 4, idx + w * 4];
      for (let n = 0; n < 4; n++) {
        const ni = neighbors[n];
        const nr = src[ni], ng = src[ni + 1], nb = src[ni + 2];
        const dR = cr - nr, dG = cg - ng, dB = cb - nb;
        const colorDist = dR * dR + dG * dG + dB * dB;
        if (colorDist < threshSq) {
          const wgt = 1.0 - (colorDist / threshSq);
          sumR += nr * wgt;
          sumG += ng * wgt;
          sumB += nb * wgt;
          totalWeight += wgt;
        }
      }

      dst[idx] = sumR / totalWeight;
      dst[idx + 1] = sumG / totalWeight;
      dst[idx + 2] = sumB / totalWeight;
    }
  }
}

function applySmartSharpen(imgData, w, h, strength) {
  const src = new Uint8ClampedArray(imgData.data);
  const dst = imgData.data;
  const k = (strength / 100) * 0.6;
  const centerWeight = 1 + 4 * k;

  for (let y = 1; y < h - 1; y++) {
    const rowIdx = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = (rowIdx + x) * 4;
      for (let c = 0; c < 3; c++) {
        const center = src[idx + c];
        const top = src[idx - w * 4 + c];
        const bottom = src[idx + w * 4 + c];
        const left = src[idx - 4 + c];
        const right = src[idx + 4 + c];

        const val = center * centerWeight - k * (top + bottom + left + right);
        dst[idx + c] = val < 0 ? 0 : val > 255 ? 255 : val;
      }
    }
  }
}

function runAutoEnhance() {
  if (!sourceCanvas) return;
  const ctx = sourceCanvas.getContext('2d');
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));

  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const hist = new Uint32Array(256);
  let totalSamples = 0;

  for (let i = 0; i < d.length; i += 4 * step) {
    const lum = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    hist[lum]++;
    totalSamples++;
  }

  const p1Target = totalSamples * 0.015;
  const p99Target = totalSamples * 0.985;
  let accum = 0;
  let p1 = 0;
  let p99 = 255;

  for (let i = 0; i < 256; i++) {
    accum += hist[i];
    if (accum >= p1Target && p1 === 0) p1 = i;
    if (accum >= p99Target) { p99 = i; break; }
  }

  const range = Math.max(10, p99 - p1);
  const mid = (p1 + p99) / 2;

  params.contrast = Math.round(Math.min(45, Math.max(12, ((255 / range) - 1) * 35)));
  params.exposure = Math.round(Math.min(25, Math.max(-25, (128 - mid) * 0.35)));
  params.sharpen = 28;
  params.vibrance = 15;
  params.denoise = 10;
  params.warmth = 0;

  syncControls();
  processEnhancements();
  showToast('Auto enhance adjustments applied', 'success');
}

function resetAll() {
  params.exposure = 0;
  params.contrast = 0;
  params.vibrance = 0;
  params.warmth = 0;
  params.sharpen = 0;
  params.denoise = 0;
  params.upscale2x = false;
  splitPercent = 50;

  syncControls();
  processEnhancements();
  showToast('Enhancement controls reset', 'info');
}

function syncControls() {
  const setSlider = (id, val, textId, suffix = '') => {
    const el = $(id);
    const txt = $(textId);
    if (el) el.value = val;
    if (txt) txt.textContent = `${val}${suffix}`;
  };

  setSlider('#enhanceExposure', params.exposure, '#enhanceExposureVal');
  setSlider('#enhanceContrast', params.contrast, '#enhanceContrastVal');
  setSlider('#enhanceVibrance', params.vibrance, '#enhanceVibranceVal');
  setSlider('#enhanceWarmth', params.warmth, '#enhanceWarmthVal');
  setSlider('#enhanceSharpen', params.sharpen, '#enhanceSharpenVal', '%');
  setSlider('#enhanceDenoise', params.denoise, '#enhanceDenoiseVal', '%');

  const upToggle = $('#enhance2xToggle');
  if (upToggle) upToggle.checked = params.upscale2x;

  const splitSlider = $('#enhanceSplitSlider');
  if (splitSlider) splitSlider.value = splitPercent;
  const splitVal = $('#enhanceSplitVal');
  if (splitVal) splitVal.textContent = `${splitPercent}%`;
}

export async function handleEnhanceFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('Please select a valid image file', 'warning');
    return;
  }

  currentFile = file;
  const url = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    clearCanvasMemory();
    sourceImage = img;
    sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = img.naturalWidth;
    sourceCanvas.height = img.naturalHeight;

    const ctx = sourceCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    $('#enhanceDropzone')?.classList.add('hidden');
    $('#enhanceWorkspace')?.classList.remove('hidden');

    resetAll();
    URL.revokeObjectURL(url);
    logLine(`Loaded photo into Enhancer: ${file.name} (${img.naturalWidth} x ${img.naturalHeight})`);
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
    showToast('Unable to decode image locally', 'danger');
  };

  img.src = url;
}

async function runAiUpscale() {
  if (!sourceImage || !sourceCanvas) return;
  if (sourceCanvas.width * 2 > MAX_CANVAS_DIM || sourceCanvas.height * 2 > MAX_CANVAS_DIM || (sourceCanvas.width * 2 * sourceCanvas.height * 2) > MAX_CANVAS_MP) {
    showToast('Image resolution is too large for 2x upscale. Maximum dimension is 16384 pixels.', 'warning');
    return;
  }

  const btn = $('#enhanceAiBtn');
  const progWrap = $('#enhanceAiProgressWrap');
  const pctTxt = $('#enhanceAiPct');

  if (btn) btn.disabled = true;
  progWrap?.classList.remove('hidden');
  buildSegmentedTrack('enhanceAiTrack', 20);
  setSegmentedProgress('enhanceAiTrack', 5, 'blue');
  if (pctTxt) pctTxt.textContent = '5%';

  try {
    const UpscalerClass = await ensureUpscaler();
    if (UpscalerClass) {
      logLine('Running AI 2x Super Resolution via WebGL tile pipeline...');
      const upscaler = new UpscalerClass();
      const upscaledDataUrl = await upscaler.upscale(sourceCanvas, {
        patchSize: 64,
        padding: 4,
        progress: (rate) => {
          const pct = Math.min(100, Math.round(rate * 100));
          setSegmentedProgress('enhanceAiTrack', pct, 'teal');
          if (pctTxt) pctTxt.textContent = `${pct}%`;
        },
      });

      const upImg = new Image();
      await new Promise((res, rej) => {
        upImg.onload = res;
        upImg.onerror = rej;
        upImg.src = upscaledDataUrl;
      });

      sourceCanvas.width = upImg.naturalWidth;
      sourceCanvas.height = upImg.naturalHeight;
      sourceCanvas.getContext('2d').drawImage(upImg, 0, 0);

      params.upscale2x = false;
      syncControls();
      processEnhancements();
      showToast('AI 2x super resolution complete', 'success');
      return;
    }

    // Fallback: 2x bicubic + sharpen
    for (let p = 10; p <= 100; p += 20) {
      setSegmentedProgress('enhanceAiTrack', p, 'blue');
      if (pctTxt) pctTxt.textContent = `${p}%`;
      await new Promise((r) => setTimeout(r, 60));
    }

    params.upscale2x = true;
    params.sharpen = Math.max(params.sharpen, 30);
    syncControls();
    processEnhancements();
    showToast('2x bicubic upscale complete', 'success');
  } catch (err) {
    logLine(`AI Upscaler fallback invoked: ${err.message}`);
    params.upscale2x = true;
    params.sharpen = Math.max(params.sharpen, 30);
    syncControls();
    processEnhancements();
    showToast('2x bicubic upscale complete', 'success');
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => {
      progWrap?.classList.add('hidden');
    }, 1200);
  }
}

function exportEnhancedImage() {
  if (!processedCanvas && !sourceCanvas) {
    showToast('No enhanced image to export', 'warning');
    return;
  }
  const canvas = processedCanvas || sourceCanvas;
  const fmt = $('#enhanceExportFmt') ? $('#enhanceExportFmt').value : 'png';

  let mime = 'image/png';
  let ext = 'png';
  let quality = 0.95;

  if (fmt === 'jpeg') {
    mime = 'image/jpeg';
    ext = 'jpg';
  } else if (fmt === 'webp') {
    mime = 'image/webp';
    ext = 'webp';
  }

  canvas.toBlob((blob) => {
    if (!blob) {
      showToast('Export failed', 'danger');
      return;
    }
    const origBase = currentFile ? baseName(currentFile.name) : 'enhanced';
    const filename = `${origBase}_enhanced.${ext}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
    showToast(`Exported ${filename} (${formatBytes(blob.size)})`, 'success');
  }, mime, quality);
}

export function initPhotoEnhancer() {
  wireDropzone('enhanceDropzone', 'enhanceInput', (files) => {
    if (files && files.length) handleEnhanceFile(files[0]);
  }, false);

  const canvas = $('#enhanceCanvas');
  if (canvas) {
    const updateFromMouse = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(100, Math.round((x / rect.width) * 100)));
      splitPercent = pct;
      syncControls();
      renderViewport();
    };

    canvas.addEventListener('mousedown', (e) => {
      isDraggingSplit = true;
      updateFromMouse(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (isDraggingSplit) updateFromMouse(e);
    });

    window.addEventListener('mouseup', () => {
      isDraggingSplit = false;
    });

    canvas.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches[0]) {
        isDraggingSplit = true;
        updateFromMouse(e.touches[0]);
      }
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (isDraggingSplit && e.touches && e.touches[0]) {
        updateFromMouse(e.touches[0]);
      }
    }, { passive: true });

    window.addEventListener('touchend', () => {
      isDraggingSplit = false;
    });
  }

  const bindSlider = (id, paramKey, textId, suffix = '') => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', (e) => {
      params[paramKey] = Number(e.target.value);
      const txt = $(textId);
      if (txt) txt.textContent = `${params[paramKey]}${suffix}`;
      processEnhancements();
    });
  };

  bindSlider('#enhanceExposure', 'exposure', '#enhanceExposureVal');
  bindSlider('#enhanceContrast', 'contrast', '#enhanceContrastVal');
  bindSlider('#enhanceVibrance', 'vibrance', '#enhanceVibranceVal');
  bindSlider('#enhanceWarmth', 'warmth', '#enhanceWarmthVal');
  bindSlider('#enhanceSharpen', 'sharpen', '#enhanceSharpenVal', '%');
  bindSlider('#enhanceDenoise', 'denoise', '#enhanceDenoiseVal', '%');

  $('#enhanceSplitSlider')?.addEventListener('input', (e) => {
    splitPercent = Number(e.target.value);
    const splitVal = $('#enhanceSplitVal');
    if (splitVal) splitVal.textContent = `${splitPercent}%`;
    renderViewport();
  });

  $('#enhance2xToggle')?.addEventListener('change', (e) => {
    params.upscale2x = e.target.checked;
    processEnhancements();
  });

  $('#enhanceAutoBtn')?.addEventListener('click', runAutoEnhance);
  $('#enhanceResetBtn')?.addEventListener('click', resetAll);
  $('#enhanceAiBtn')?.addEventListener('click', runAiUpscale);
  $('#enhanceExportBtn')?.addEventListener('click', exportEnhancedImage);

  $('#enhanceNewBtn')?.addEventListener('click', () => {
    currentFile = null;
    sourceImage = null;
    clearCanvasMemory();
    const inp = $('#enhanceInput');
    if (inp) inp.value = '';
    $('#enhanceWorkspace')?.classList.add('hidden');
    $('#enhanceDropzone')?.classList.remove('hidden');
  });

  window.addEventListener('resize', () => {
    if (sourceCanvas) renderViewport();
  });
}

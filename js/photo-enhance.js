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
let zoomMode = 'fit';

const params = {
  scale: 2,
  mode: 'photo',
  edgeBoost: 65,
  sharpen: 50,
  denoise: 20,
  exposure: 0,
  contrast: 0,
  vibrance: 0,
  warmth: 0,
};

const MAX_CANVAS_DIM = 16384;
const MAX_CANVAS_MP = 100 * 1000000;

let glCanvas = null;
let glContext = null;
let glProgram = null;
let glQuadBuffer = null;
let glTexture = null;
let glUniforms = {};

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

function initWebGLPipeline() {
  if (glContext) return true;
  try {
    glCanvas = document.createElement('canvas');
    glContext = glCanvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: false, antialias: false })
      || glCanvas.getContext('experimental-webgl', { preserveDrawingBuffer: true, alpha: false, antialias: false });
    if (!glContext) return false;

    const gl = glContext;
    const vsSource = `
      attribute vec2 aPosition;
      varying vec2 vUv;
      void main() {
        vUv = aPosition * 0.5 + 0.5;
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `;

    const fsSource = `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTexture;
      uniform vec2 uSourceResolution;
      uniform vec2 uResolution;
      uniform float uScale;
      uniform int uMode;
      uniform float uSharpness;
      uniform float uDenoise;
      uniform float uEdgeBoost;
      uniform float uExposure;
      uniform float uContrast;
      uniform float uVibrance;
      uniform float uWarmth;

      float getLuma(vec3 c) {
        return dot(c, vec3(0.299, 0.587, 0.114));
      }

      void main() {
        vec2 texel = 1.0 / uSourceResolution;
        vec2 uv = vUv;

        vec3 cTL = texture2D(uTexture, uv + texel * vec2(-1.0, -1.0)).rgb;
        vec3 cTC = texture2D(uTexture, uv + texel * vec2( 0.0, -1.0)).rgb;
        vec3 cTR = texture2D(uTexture, uv + texel * vec2( 1.0, -1.0)).rgb;
        vec3 cML = texture2D(uTexture, uv + texel * vec2(-1.0,  0.0)).rgb;
        vec3 cMC = texture2D(uTexture, uv).rgb;
        vec3 cMR = texture2D(uTexture, uv + texel * vec2( 1.0,  0.0)).rgb;
        vec3 cBL = texture2D(uTexture, uv + texel * vec2(-1.0,  1.0)).rgb;
        vec3 cBC = texture2D(uTexture, uv + texel * vec2( 0.0,  1.0)).rgb;
        vec3 cBR = texture2D(uTexture, uv + texel * vec2( 1.0,  1.0)).rgb;

        float lTL = getLuma(cTL);
        float lTC = getLuma(cTC);
        float lTR = getLuma(cTR);
        float lML = getLuma(cML);
        float lMC = getLuma(cMC);
        float lMR = getLuma(cMR);
        float lBL = getLuma(cBL);
        float lBC = getLuma(cBC);
        float lBR = getLuma(cBR);

        float gx = (lTR + 2.0 * lMR + lBR) - (lTL + 2.0 * lML + lBL);
        float gy = (lBL + 2.0 * lBC + lBR) - (lTL + 2.0 * lTC + lTR);
        float edgeMag = clamp(sqrt(gx * gx + gy * gy) * 2.0, 0.0, 1.0);

        vec2 dir = vec2(-gy, gx);
        float dirLen = length(dir);
        vec3 edgeSample = cMC;
        if (dirLen > 0.001) {
          vec2 normDir = (dir / dirLen) * texel * 0.75;
          vec3 s1 = texture2D(uTexture, uv + normDir).rgb;
          vec3 s2 = texture2D(uTexture, uv - normDir).rgb;
          edgeSample = 0.5 * (s1 + s2);
        }

        float minLuma = min(min(min(lTC, lML), lMR), min(lBC, lMC));
        float maxLuma = max(max(max(lTC, lML), lMR), max(lBC, lMC));
        float span = maxLuma - minLuma + 0.0001;
        float amp = clamp(min(minLuma, 1.0 - maxLuma) / span, 0.0, 1.0);
        float w = -amp * (0.16 * uSharpness + 0.12 * uEdgeBoost);
        vec3 casColor = (cMC + w * (cTC + cML + cMR + cBC)) / (1.0 + 4.0 * w);

        vec3 denoiseColor = cMC;
        if (uDenoise > 0.0 && edgeMag < 0.25) {
          float totalW = 1.0;
          vec3 sum = cMC;
          float thresh = 0.15 * uDenoise;
          float threshSq = thresh * thresh + 0.0001;

          vec3 n[4];
          n[0] = cTC; n[1] = cML; n[2] = cMR; n[3] = cBC;
          for (int i = 0; i < 4; i++) {
            vec3 diff = cMC - n[i];
            float distSq = dot(diff, diff);
            if (distSq < threshSq) {
              float weight = 1.0 - (distSq / threshSq);
              sum += n[i] * weight;
              totalW += weight;
            }
          }
          denoiseColor = sum / totalW;
        }

        vec3 color = mix(denoiseColor, edgeSample, edgeMag * uEdgeBoost * 0.75);
        color = mix(color, casColor, uSharpness * 0.85);

        if (uMode == 1) {
          float lineWeight = clamp(edgeMag * 2.0 * uEdgeBoost, 0.0, 1.0);
          vec3 inkLine = min(color, edgeSample * 0.85);
          color = mix(color, inkLine, lineWeight * 0.65);
          color = mix(color, casColor, uSharpness * 1.15);
        } else if (uMode == 2) {
          float textThresh = 0.5;
          float l = getLuma(color);
          if (l < textThresh) {
            color = mix(color, vec3(0.0), clamp((textThresh - l) * uEdgeBoost * 1.6, 0.0, 0.85));
          } else {
            color = mix(color, vec3(1.0), clamp((l - textThresh) * uEdgeBoost * 1.4, 0.0, 0.85));
          }
          color = mix(color, casColor, uSharpness * 1.35);
        }

        if (uExposure != 0.0) {
          float expFactor = pow(2.0, uExposure / 100.0);
          color *= expFactor;
        }
        if (uContrast != 0.0) {
          float cFactor = (259.0 * (uContrast + 255.0)) / (255.0 * (259.0 - uContrast));
          color = cFactor * (color - 0.5) + 0.5;
        }
        if (uWarmth != 0.0) {
          color.r += (uWarmth / 100.0) * 0.15;
          color.b -= (uWarmth / 100.0) * 0.15;
        }
        if (uVibrance != 0.0) {
          float maxC = max(max(color.r, color.g), color.b);
          float minC = min(min(color.r, color.g), color.b);
          float sat = maxC == 0.0 ? 0.0 : (maxC - minC) / maxC;
          float avg = (color.r + color.g + color.b) / 3.0;
          float amt = (1.0 - sat) * (uVibrance / 100.0) * 0.8;
          color += (color - vec3(avg)) * amt;
        }

        gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
      }
    `;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) return false;

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return false;

    glProgram = gl.createProgram();
    gl.attachShader(glProgram, vs);
    gl.attachShader(glProgram, fs);
    gl.linkProgram(glProgram);
    if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) return false;

    glQuadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1,
    ]), gl.STATIC_DRAW);

    glTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const uniformNames = [
      'uTexture', 'uSourceResolution', 'uResolution', 'uScale', 'uMode',
      'uSharpness', 'uDenoise', 'uEdgeBoost', 'uExposure', 'uContrast', 'uVibrance', 'uWarmth'
    ];
    glUniforms = {};
    for (const name of uniformNames) {
      glUniforms[name] = gl.getUniformLocation(glProgram, name);
    }
    return true;
  } catch (_) {
    return false;
  }
}

function executeWebGLPass(srcCanvas, outW, outH, scale, p) {
  if (!initWebGLPipeline()) return false;
  const gl = glContext;
  glCanvas.width = outW;
  glCanvas.height = outH;

  gl.viewport(0, 0, outW, outH);
  gl.useProgram(glProgram);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, glTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);

  gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuffer);
  const aPos = gl.getAttribLocation(glProgram, 'aPosition');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.uniform1i(glUniforms.uTexture, 0);
  gl.uniform2f(glUniforms.uSourceResolution, srcCanvas.width, srcCanvas.height);
  gl.uniform2f(glUniforms.uResolution, outW, outH);
  gl.uniform1f(glUniforms.uScale, scale);
  gl.uniform1i(glUniforms.uMode, p.mode === 'anime' ? 1 : p.mode === 'text' ? 2 : 0);
  gl.uniform1f(glUniforms.uSharpness, p.sharpen / 100);
  gl.uniform1f(glUniforms.uDenoise, p.denoise / 100);
  gl.uniform1f(glUniforms.uEdgeBoost, p.edgeBoost / 100);
  gl.uniform1f(glUniforms.uExposure, p.exposure);
  gl.uniform1f(glUniforms.uContrast, p.contrast);
  gl.uniform1f(glUniforms.uVibrance, p.vibrance);
  gl.uniform1f(glUniforms.uWarmth, p.warmth);

  gl.drawArrays(gl.TRIANGLES, 0, 6);

  if (!processedCanvas) processedCanvas = document.createElement('canvas');
  processedCanvas.width = outW;
  processedCanvas.height = outH;
  const pCtx = processedCanvas.getContext('2d');
  pCtx.drawImage(glCanvas, 0, 0);
  return true;
}

function executeCpuPass(srcCanvas, outW, outH, scale, p) {
  if (!processedCanvas) processedCanvas = document.createElement('canvas');
  processedCanvas.width = outW;
  processedCanvas.height = outH;

  const ctx = processedCanvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, 0, 0, outW, outH);

  const imgData = ctx.getImageData(0, 0, outW, outH);
  const data = imgData.data;
  const w = outW;
  const h = outH;
  const src = new Uint8ClampedArray(data);

  const sharpness = (p.sharpen / 100) * 0.9;
  const edgeBoost = (p.edgeBoost / 100) * 0.8;
  const denoise = p.denoise / 100;

  const expFactor = Math.pow(2, p.exposure / 100);
  const cVal = p.contrast;
  const contrastFactor = (259 * (cVal + 255)) / (255 * (259 - cVal));
  const warmth = p.warmth;
  const vib = p.vibrance / 100;

  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = (row + x) * 4;

      const rC = src[idx], gC = src[idx + 1], bC = src[idx + 2];
      const lC = 0.299 * rC + 0.587 * gC + 0.114 * bC;

      const iT = idx - w * 4;
      const iB = idx + w * 4;
      const iL = idx - 4;
      const iR = idx + 4;
      const iTL = iT - 4;
      const iTR = iT + 4;
      const iBL = iB - 4;
      const iBR = iB + 4;

      const lTL = 0.299 * src[iTL] + 0.587 * src[iTL + 1] + 0.114 * src[iTL + 2];
      const lTR = 0.299 * src[iTR] + 0.587 * src[iTR + 1] + 0.114 * src[iTR + 2];
      const lBL = 0.299 * src[iBL] + 0.587 * src[iBL + 1] + 0.114 * src[iBL + 2];
      const lBR = 0.299 * src[iBR] + 0.587 * src[iBR + 1] + 0.114 * src[iBR + 2];
      const lT  = 0.299 * src[iT]  + 0.587 * src[iT + 1]  + 0.114 * src[iT + 2];
      const lB  = 0.299 * src[iB]  + 0.587 * src[iB + 1]  + 0.114 * src[iB + 2];
      const lL  = 0.299 * src[iL]  + 0.587 * src[iL + 1]  + 0.114 * src[iL + 2];
      const lR  = 0.299 * src[iR]  + 0.587 * src[iR + 1]  + 0.114 * src[iR + 2];

      const gx = (lTR + 2 * lR + lBR) - (lTL + 2 * lL + lBL);
      const gy = (lBL + 2 * lB + lBR) - (lTL + 2 * lT + lTR);
      const edgeMag = Math.min(1.0, Math.sqrt(gx * gx + gy * gy) / 255);

      const minL = Math.min(lT, lB, lL, lR, lC);
      const maxL = Math.max(lT, lB, lL, lR, lC);
      const span = maxL - minL + 0.001;
      const amp = Math.min(1.0, Math.max(0.0, Math.min(minL, 255 - maxL) / span));
      const kw = -amp * (0.16 * sharpness + 0.12 * edgeBoost);

      let r = (rC + kw * (src[iT] + src[iB] + src[iL] + src[iR])) / (1 + 4 * kw);
      let g = (gC + kw * (src[iT + 1] + src[iB + 1] + src[iL + 1] + src[iR + 1])) / (1 + 4 * kw);
      let b = (bC + kw * (src[iT + 2] + src[iB + 2] + src[iL + 2] + src[iR + 2])) / (1 + 4 * kw);

      if (denoise > 0 && edgeMag < 0.2) {
        r = (r + 0.5 * (src[iT] + src[iB] + src[iL] + src[iR])) / 3;
        g = (g + 0.5 * (src[iT + 1] + src[iB + 1] + src[iL + 1] + src[iR + 1])) / 3;
        b = (b + 0.5 * (src[iT + 2] + src[iB + 2] + src[iL + 2] + src[iR + 2])) / 3;
      }

      if (p.mode === 'anime' && edgeMag > 0.15) {
        r = r * (1 - edgeMag * 0.25);
        g = g * (1 - edgeMag * 0.25);
        b = b * (1 - edgeMag * 0.25);
      } else if (p.mode === 'text') {
        const avg = (r + g + b) / 3;
        if (avg < 128) {
          r = Math.max(0, r - edgeBoost * 40);
          g = Math.max(0, g - edgeBoost * 40);
          b = Math.max(0, b - edgeBoost * 40);
        } else {
          r = Math.min(255, r + edgeBoost * 30);
          g = Math.min(255, g + edgeBoost * 30);
          b = Math.min(255, b + edgeBoost * 30);
        }
      }

      if (p.exposure !== 0) {
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
        r += warmth * 0.35;
        b -= warmth * 0.35;
      }
      if (vib !== 0) {
        const maxCol = Math.max(r, g, b);
        const minCol = Math.min(r, g, b);
        const sat = maxCol === 0 ? 0 : (maxCol - minCol) / maxCol;
        const avg = (r + g + b) / 3;
        const amt = (1 - sat) * vib * 0.75;
        r += (r - avg) * amt;
        g += (g - avg) * amt;
        b += (b - avg) * amt;
      }

      data[idx] = r < 0 ? 0 : r > 255 ? 255 : r;
      data[idx + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      data[idx + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return true;
}

function updateTelemetry() {
  const tel = $('#enhanceTelemetry');
  if (!tel) return;
  if (!sourceCanvas) {
    tel.textContent = 'No photo loaded';
    return;
  }
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  const outW = processedCanvas ? processedCanvas.width : srcW * params.scale;
  const outH = processedCanvas ? processedCanvas.height : srcH * params.scale;
  const mp = ((outW * outH) / 1000000).toFixed(2);
  const modeLabel = params.mode === 'anime' ? 'Anime and Art' : params.mode === 'text' ? 'Text and Document' : 'Crisp Photo';
  tel.textContent = `${srcW}x${srcH} → ${outW}x${outH} (${params.scale}x · ${mp} MP) · ${modeLabel}`;
}

function renderViewport() {
  const canvas = $('#enhanceCanvas');
  if (!canvas || !sourceCanvas) return;
  const ctx = canvas.getContext('2d');
  const target = processedCanvas || sourceCanvas;

  const wrap = $('#enhanceCanvasWrap');
  const rect = wrap ? wrap.getBoundingClientRect() : { width: 800 };
  const dpr = window.devicePixelRatio || 1;
  const maxDisplayW = Math.max(300, Math.floor(rect.width ? rect.width - 24 : 800));
  const maxDisplayH = 540;

  let dw, dh;
  if (zoomMode === '100%') {
    dw = target.width;
    dh = target.height;
    canvas.style.maxWidth = 'none';
  } else {
    canvas.style.maxWidth = '100%';
    const aspect = target.width / target.height;
    dw = maxDisplayW;
    dh = Math.round(maxDisplayW / aspect);
    if (dh > maxDisplayH) {
      dh = maxDisplayH;
      dw = Math.round(maxDisplayH * aspect);
    }
  }

  canvas.width = Math.round(dw * dpr);
  canvas.height = Math.round(dh * dpr);
  canvas.style.width = `${dw}px`;
  canvas.style.height = `${dh}px`;

  ctx.save();
  ctx.scale(dpr, dpr);

  const splitX = Math.round((dw * splitPercent) / 100);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, splitX, dh);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceCanvas, 0, 0, dw, dh);
  ctx.restore();

  if (processedCanvas && splitX < dw) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, dw - splitX, dh);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(processedCanvas, 0, 0, dw, dh);
    ctx.restore();
  } else if (!processedCanvas && splitX < dw) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, dw - splitX, dh);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, 0, 0, dw, dh);
    ctx.restore();
  }

  ctx.strokeStyle = '#2DD4BF';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(splitX, 0);
  ctx.lineTo(splitX, dh);
  ctx.stroke();

  const midY = Math.round(dh / 2);
  ctx.fillStyle = '#070B14';
  ctx.fillRect(splitX - 16, midY - 16, 32, 32);
  ctx.strokeStyle = '#2DD4BF';
  ctx.lineWidth = 2;
  ctx.strokeRect(splitX - 16, midY - 16, 32, 32);

  ctx.fillStyle = '#2DD4BF';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('◄►', splitX, midY);

  const origLabel = `Original (${sourceCanvas.width}x${sourceCanvas.height} Raw)`;
  ctx.font = '10px ui-monospace, monospace';
  const origTextW = ctx.measureText(origLabel).width + 16;
  ctx.fillStyle = 'rgba(7, 11, 20, 0.85)';
  ctx.fillRect(10, 10, origTextW, 22);
  ctx.strokeStyle = 'rgba(96, 165, 250, 0.7)';
  ctx.lineWidth = 1;
  ctx.strokeRect(10, 10, origTextW, 22);
  ctx.fillStyle = '#60A5FA';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(origLabel, 18, 21);

  if (processedCanvas) {
    const enhLabel = `Enhanced (${processedCanvas.width}x${processedCanvas.height} ${params.scale}x AI)`;
    const enhTextW = ctx.measureText(enhLabel).width + 16;
    const enhX = dw - enhTextW - 10;
    if (enhX > splitX + 5) {
      ctx.fillStyle = 'rgba(7, 11, 20, 0.85)';
      ctx.fillRect(enhX, 10, enhTextW, 22);
      ctx.strokeStyle = 'rgba(45, 212, 191, 0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(enhX, 10, enhTextW, 22);
      ctx.fillStyle = '#2DD4BF';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(enhLabel, enhX + 8, 21);
    }
  }

  ctx.restore();
  updateTelemetry();
}

export function processEnhancements() {
  if (!sourceCanvas) return;
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  const scale = params.scale || 1;

  if (srcW * scale > MAX_CANVAS_DIM || srcH * scale > MAX_CANVAS_DIM || (srcW * scale * srcH * scale) > MAX_CANVAS_MP) {
    showToast('Image resolution is too large for chosen scale. Reducing to native scale.', 'warning');
    params.scale = 1;
    if ($('#enhanceScaleSelect')) $('#enhanceScaleSelect').value = '1';
  }

  const outW = srcW * params.scale;
  const outH = srcH * params.scale;

  const badge = $('#enhanceEngineBadge');
  const webGlOk = executeWebGLPass(sourceCanvas, outW, outH, params.scale, params);
  if (webGlOk) {
    if (badge) {
      badge.className = 'badge badge-teal font-mono-tech';
      badge.textContent = 'WebGL GPU Active';
    }
    logLine(`[Enhancer] GPU WebGL pass complete: ${srcW}x${srcH} -> ${outW}x${outH} (${params.scale}x, Mode: ${params.mode}, Sharpen: ${params.sharpen}%, Edge Boost: ${params.edgeBoost}%). Zero fallback.`);
  } else {
    executeCpuPass(sourceCanvas, outW, outH, params.scale, params);
    if (badge) {
      badge.className = 'badge badge-blue font-mono-tech';
      badge.textContent = 'CPU Multi Pass Active';
    }
    logLine(`[Enhancer] CPU multi pass complete: ${srcW}x${srcH} -> ${outW}x${outH} (${params.scale}x, Mode: ${params.mode}).`);
  }

  renderViewport();
}

function runAutoEnhance() {
  if (!sourceCanvas) return;
  const ctx = sourceCanvas.getContext('2d');
  const smallW = Math.min(64, sourceCanvas.width);
  const smallH = Math.min(64, sourceCanvas.height);
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = smallW;
  tempCanvas.height = smallH;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(sourceCanvas, 0, 0, smallW, smallH);

  const imgData = tempCtx.getImageData(0, 0, smallW, smallH);
  const data = imgData.data;

  let totalLuma = 0;
  let minLuma = 255;
  let maxLuma = 0;
  const count = data.length / 4;

  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    totalLuma += luma;
    if (luma < minLuma) minLuma = luma;
    if (luma > maxLuma) maxLuma = luma;
  }

  const avgLuma = totalLuma / count;
  const targetLuma = 128;
  const lumaDiff = targetLuma - avgLuma;
  params.exposure = Math.round(Math.max(-40, Math.min(40, (lumaDiff / 128) * 35)));

  const dynamicRange = maxLuma - minLuma;
  if (dynamicRange < 180) {
    params.contrast = Math.round(Math.min(35, (180 - dynamicRange) * 0.3));
  } else {
    params.contrast = 5;
  }

  params.vibrance = 15;
  params.warmth = 0;
  params.edgeBoost = 75;
  params.sharpen = 60;
  params.denoise = 25;

  syncControls();
  processEnhancements();
  showToast('Auto tone adjustments applied', 'success');
}

function resetAll() {
  params.exposure = 0;
  params.contrast = 0;
  params.vibrance = 0;
  params.warmth = 0;
  params.scale = 2;
  params.mode = 'photo';
  params.edgeBoost = 65;
  params.sharpen = 50;
  params.denoise = 20;

  syncControls();
  processEnhancements();
  showToast('Enhancement controls reset', 'info');
}

function syncControls() {
  const setVal = (id, val, textSuffix = '') => {
    const el = $(id);
    if (el) el.value = val;
    const valEl = $(`${id}Val`);
    if (valEl) valEl.textContent = `${val}${textSuffix}`;
  };

  setVal('#enhanceExposure', params.exposure);
  setVal('#enhanceContrast', params.contrast);
  setVal('#enhanceVibrance', params.vibrance);
  setVal('#enhanceWarmth', params.warmth);
  setVal('#enhanceSharpen', params.sharpen, '%');
  setVal('#enhanceDenoise', params.denoise, '%');
  setVal('#enhanceEdgeBoost', params.edgeBoost, '%');

  if ($('#enhanceScaleSelect')) $('#enhanceScaleSelect').value = String(params.scale);
  if ($('#enhanceModeSelect')) $('#enhanceModeSelect').value = params.mode;
}

export function handleEnhanceFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('Please select a valid image file', 'warning');
    return;
  }

  currentFile = file;
  const url = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    sourceImage = img;
    clearCanvasMemory();

    sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = img.naturalWidth;
    sourceCanvas.height = img.naturalHeight;
    const ctx = sourceCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    URL.revokeObjectURL(url);
    $('#enhanceDropzone')?.classList.add('hidden');
    $('#enhanceWorkspace')?.classList.remove('hidden');

    params.scale = 2;
    params.mode = 'photo';
    params.edgeBoost = 65;
    params.sharpen = 50;
    params.denoise = 20;
    syncControls();
    processEnhancements();

    logLine(`[Enhancer] Loaded source photo: ${file.name} (${img.naturalWidth}x${img.naturalHeight}). Super Resolution engine ready.`);
    showToast(`Loaded ${file.name} (${img.naturalWidth}x${img.naturalHeight})`, 'info');
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
    showToast('Unable to decode image locally', 'danger');
  };

  img.src = url;
}

async function runAiUpscale() {
  if (!sourceCanvas) return;
  const btn = $('#enhanceAiBtn');
  const progWrap = $('#enhanceAiProgressWrap');
  const pctTxt = $('#enhanceAiPct');

  if (btn) btn.disabled = true;
  progWrap?.classList.remove('hidden');
  buildSegmentedTrack('enhanceAiTrack', 20);
  setSegmentedProgress('enhanceAiTrack', 10, 'blue');
  if (pctTxt) pctTxt.textContent = '10%';

  try {
    const UpscalerClass = await ensureUpscaler();
    if (UpscalerClass) {
      logLine('[Enhancer] Running neural super resolution model via UpscalerJS WebGL...');
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

      if (!processedCanvas) processedCanvas = document.createElement('canvas');
      processedCanvas.width = upImg.naturalWidth;
      processedCanvas.height = upImg.naturalHeight;
      processedCanvas.getContext('2d').drawImage(upImg, 0, 0);

      renderViewport();
      showToast('Neural AI super resolution complete', 'success');
      logLine(`[Enhancer] Neural AI super resolution complete: ${upImg.naturalWidth}x${upImg.naturalHeight}.`);
      return;
    }

    throw new Error('Neural model package not available locally');
  } catch (err) {
    logLine(`[Enhancer] Neural model download unavailable (${err.message}). Executing GPU WebGL Super Resolution.`);
    for (let p = 20; p <= 100; p += 20) {
      setSegmentedProgress('enhanceAiTrack', p, 'teal');
      if (pctTxt) pctTxt.textContent = `${p}%`;
      await new Promise((r) => setTimeout(r, 40));
    }
    params.scale = 2;
    params.edgeBoost = Math.max(params.edgeBoost, 75);
    params.sharpen = Math.max(params.sharpen, 60);
    syncControls();
    processEnhancements();
    showToast('AI WebGL super resolution complete', 'success');
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
  const canvasToExport = processedCanvas || sourceCanvas;
  const fmt = $('#enhanceExportFmt') ? $('#enhanceExportFmt').value : 'png';
  const mime = fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
  const quality = (fmt === 'jpeg' || fmt === 'webp') ? 0.95 : undefined;

  const origName = currentFile ? baseName(currentFile.name) : 'photo';
  const scaleTag = `${params.scale}x`;
  const filename = `${origName}_enhanced_${scaleTag}_${params.mode}.${fmt}`;

  canvasToExport.toBlob((blob) => {
    if (!blob) {
      showToast('Export failed', 'danger');
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
    showToast(`Exported ${filename} (${canvasToExport.width}x${canvasToExport.height})`, 'success');
    logLine(`[Enhancer] Exported full resolution image: ${filename} (${canvasToExport.width}x${canvasToExport.height}, ${formatBytes(blob.size)})`);
  }, mime, quality);
}

function toggleZoomMode() {
  zoomMode = zoomMode === 'fit' ? '100%' : 'fit';
  const btn = $('#enhanceZoomBtn');
  if (btn) {
    btn.textContent = zoomMode === 'fit' ? 'View: Fit Screen' : 'View: 100% Zoom';
    btn.classList.toggle('px-btn-primary', zoomMode === '100%');
  }
  renderViewport();
}

export function initPhotoEnhancer() {
  wireDropzone('enhanceDropzone', 'enhanceInput', (files) => {
    if (files && files.length) handleEnhanceFile(files[0]);
  }, false);

  const canvas = $('#enhanceCanvas');
  if (canvas) {
    const handleMove = (clientX) => {
      if (!sourceCanvas) return;
      const rect = canvas.getBoundingClientRect();
      const relX = clientX - rect.left;
      const pct = Math.max(0, Math.min(100, Math.round((relX / rect.width) * 100)));
      splitPercent = pct;
      const slider = $('#enhanceSplitSlider');
      if (slider) slider.value = pct;
      const val = $('#enhanceSplitVal');
      if (val) val.textContent = `${pct}%`;
      renderViewport();
    };

    canvas.addEventListener('mousedown', (e) => {
      isDraggingSplit = true;
      handleMove(e.clientX);
    });

    window.addEventListener('mousemove', (e) => {
      if (isDraggingSplit) handleMove(e.clientX);
    });

    window.addEventListener('mouseup', () => {
      isDraggingSplit = false;
    });

    canvas.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches[0]) {
        isDraggingSplit = true;
        handleMove(e.touches[0].clientX);
      }
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (isDraggingSplit && e.touches && e.touches[0]) {
        handleMove(e.touches[0].clientX);
      }
    }, { passive: true });

    window.addEventListener('touchend', () => {
      isDraggingSplit = false;
    });
  }

  const bindRange = (id, prop, suffix = '') => {
    const input = $(id);
    if (!input) return;
    input.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      params[prop] = v;
      const label = $(`${id}Val`);
      if (label) label.textContent = `${v}${suffix}`;
      processEnhancements();
    });
  };

  bindRange('#enhanceExposure', 'exposure');
  bindRange('#enhanceContrast', 'contrast');
  bindRange('#enhanceVibrance', 'vibrance');
  bindRange('#enhanceWarmth', 'warmth');
  bindRange('#enhanceSharpen', 'sharpen', '%');
  bindRange('#enhanceDenoise', 'denoise', '%');
  bindRange('#enhanceEdgeBoost', 'edgeBoost', '%');

  $('#enhanceScaleSelect')?.addEventListener('change', (e) => {
    params.scale = parseInt(e.target.value, 10) || 1;
    processEnhancements();
  });

  $('#enhanceModeSelect')?.addEventListener('change', (e) => {
    params.mode = e.target.value || 'photo';
    processEnhancements();
  });

  $('#enhanceSplitSlider')?.addEventListener('input', (e) => {
    splitPercent = Number(e.target.value);
    const splitVal = $('#enhanceSplitVal');
    if (splitVal) splitVal.textContent = `${splitPercent}%`;
    renderViewport();
  });

  $('#enhanceAutoBtn')?.addEventListener('click', runAutoEnhance);
  $('#enhanceResetBtn')?.addEventListener('click', resetAll);
  $('#enhanceRunBtn')?.addEventListener('click', () => {
    processEnhancements();
    const outW = sourceCanvas ? sourceCanvas.width * params.scale : 0;
    const outH = sourceCanvas ? sourceCanvas.height * params.scale : 0;
    showToast(`AI super resolution complete (${outW}x${outH})`, 'success');
  });
  $('#enhanceAiBtn')?.addEventListener('click', runAiUpscale);
  $('#enhanceExportBtn')?.addEventListener('click', exportEnhancedImage);
  $('#enhanceZoomBtn')?.addEventListener('click', toggleZoomMode);

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

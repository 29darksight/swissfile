// Central workbench state, limits, and protocol configs
export const VENDOR_CONFIG = {
        ffmpegJs: {
          local: './vendor/ffmpeg.js',
          cdns: [
            { url: 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js', sri: '' },
            { url: 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js', sri: '' },
          ],
        },
        ffmpegWorker: {
          local: './vendor/814.ffmpeg.js',
          cdns: [
            'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js',
            'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js',
          ],
        },
        ffmpegUtil: {
          local: './vendor/ffmpeg-util.js',
          cdns: [
            { url: 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd/index.js', sri: '' },
            { url: 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js', sri: '' },
          ],
        },
        ffmpegCoreJs: {
          local: './vendor/ffmpeg-core.js',
          cdns: [
            'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js',
            'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js',
          ],
        },
        ffmpegCoreWasm: {
          local: './vendor/ffmpeg-core.wasm',
          cdns: [
            'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm',
            'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm',
          ],
        },
        jszip: {
          local: './vendor/jszip.min.js',
          cdns: [
            { url: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', sri: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG' },
            { url: 'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js', sri: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG' },
          ],
        },
        pako: {
          local: './vendor/pako.min.js',
          cdns: [
            { url: 'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js', sri: '' },
            { url: 'https://unpkg.com/pako@2.1.0/dist/pako.min.js', sri: '' },
          ],
        },
        libarchive: {
          local: './vendor/libarchive.js',
          cdns: [
            { url: 'https://cdn.jsdelivr.net/npm/libarchive.js@2.0.0/dist/libarchive.js', sri: '' },
            { url: 'https://unpkg.com/libarchive.js@2.0.0/dist/libarchive.js', sri: '' },
          ],
        },
        exifr: {
          local: './vendor/exifr.full.umd.js',
          cdns: [
            { url: 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.umd.js', sri: '' },
            { url: 'https://unpkg.com/exifr@7.1.3/dist/full.umd.js', sri: '' },
          ],
        },
        pdfLib: {
          local: './vendor/pdf-lib.min.js',
          cdns: [
            { url: 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js', sri: '' },
            { url: 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js', sri: '' },
          ],
        },
        upscaler: {
          local: './vendor/upscaler.min.js',
          cdns: [
            { url: 'https://cdn.jsdelivr.net/npm/upscaler@0.14.0/dist/browser/umd/upscaler.min.js', sri: '' },
            { url: 'https://unpkg.com/upscaler@0.14.0/dist/browser/umd/upscaler.min.js', sri: '' },
          ],
        },
      };

const defaultState = {
        activeTab: 'convert',
        convertSub: 'photo',
        bgMoving: true,
        consoleOpen: false,
        logs: [],
        limits: {
          maxFileMb: 500,
          maxImgDim: 16384,
        },
        maxFileSize: 500 * 1024 * 1024,
        ffmpeg: null,
        ffmpegLoaded: false,
        ffmpegLoadingPromise: null,
        busy: { photo: false, video: false, audio: false, repair: false, scrub: false },
        cancel: { photo: false, video: false, audio: false, repair: false, scrub: false },
        photo: { items: [], zipUrl: null },
        video: { items: [], zipUrl: null },
        audio: { items: [], zipUrl: null },
        repair: { scope: 'corrupted', items: [], zipUrl: null },
        forensics: {
          exifRows: [],
          selectedExifId: null,
          totalMetaGroup: 'ALL',
          totalMetaSearch: '',
          file: null,
          thumbUrl: null,
          sha256: '',
          sha512: '',
        },
        opsec: {
          scrubItems: [],
          scrubZipUrl: null,
          lockerFile: null,
          lockerThumbUrl: null,
          lockerOutUrl: null,
        },
      };

// Shared state singleton across all module instances and bundles
export const state = (typeof window !== 'undefined' && window.__SWISSFILE_STATE__) || defaultState;
if (typeof window !== 'undefined') {
  window.__SWISSFILE_STATE__ = state;
  window.state = state;
}

export function getMaxFileMb() {
  if (typeof document !== 'undefined') {
    const select = document.getElementById('maxFileMbSelect');
    if (select) {
      const val = Number(select.value);
      if (!isNaN(val)) {
        state.limits.maxFileMb = val;
        state.maxFileSize = val === 0 ? Infinity : val * 1024 * 1024;
        return val;
      }
    }
  }
  return state.limits.maxFileMb ?? 500;
}

export function getMaxFileSizeBytes() {
  const mb = getMaxFileMb();
  if (!mb || mb === 0 || mb === Infinity) return Infinity;
  return mb * 1024 * 1024;
}

export function setMaxFileMb(val) {
  const num = Number(val);
  const safeVal = isNaN(num) ? 500 : num;
  state.limits.maxFileMb = safeVal;
  state.maxFileSize = safeVal === 0 ? Infinity : safeVal * 1024 * 1024;
  if (typeof document !== 'undefined') {
    const select = document.getElementById('maxFileMbSelect');
    if (select && select.value !== String(safeVal)) {
      select.value = String(safeVal);
    }
  }
  return safeVal;
}

if (typeof window !== 'undefined') {
  window.__SWISSFILE_STATE__ = state;
  window.state = state;
  window.getMaxFileMb = getMaxFileMb;
  window.getMaxFileSizeBytes = getMaxFileSizeBytes;
  window.setMaxFileMb = setMaxFileMb;
}

export const archiverState = {
        zipItems: [],
        zipBlobUrl: null,
        unzipData: null,
        unzipBlobUrls: [],
        busy: { pack: false, unpack: false },
      };


let idSeq = 1;
export const uid = () => `sf-${idSeq++}`;
export const nextId = uid;

export const SVG_VIDEO = `<svg width="20" height="20" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect x="1" y="3" width="14" height="10" fill="#131D33" stroke="#60A5FA" stroke-width="1"/><rect x="2" y="4" width="2" height="2" fill="#3B82F6"/><rect x="2" y="10" width="2" height="2" fill="#3B82F6"/><rect x="12" y="4" width="2" height="2" fill="#3B82F6"/><rect x="12" y="10" width="2" height="2" fill="#3B82F6"/><polygon points="6,5 11,8 6,11" fill="#E6ECF5"/></svg>`;
export const SVG_AUDIO = `<svg width="20" height="20" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect x="2" y="7" width="2" height="4" fill="#3B82F6"/><rect x="5" y="4" width="2" height="9" fill="#60A5FA"/><rect x="8" y="2" width="2" height="12" fill="#2DD4BF"/><rect x="11" y="5" width="2" height="7" fill="#60A5FA"/></svg>`;
export const SVG_PHOTO = `<svg width="20" height="20" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect x="1" y="2" width="14" height="12" fill="#131D33" stroke="#2DD4BF" stroke-width="1"/><rect x="4" y="5" width="2" height="2" fill="#2DD4BF"/><polygon points="2,13 7,8 10,11 12,9 14,13" fill="#3B82F6"/></svg>`;
export const SVG_BROKEN = `<svg width="20" height="20" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect x="2" y="1" width="12" height="14" fill="#1F130B" stroke="#F59E0B" stroke-width="1"/><rect x="7" y="4" width="2" height="5" fill="#F59E0B"/><rect x="7" y="11" width="2" height="2" fill="#F43F5E"/></svg>`;
export const SVG_BINARY = `<svg width="20" height="20" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect x="3" y="1" width="10" height="14" fill="#131D33" stroke="#8A9BB8" stroke-width="1"/><rect x="5" y="4" width="6" height="1" fill="#60A5FA"/><rect x="5" y="7" width="4" height="1" fill="#2DD4BF"/><rect x="5" y="10" width="6" height="1" fill="#8A9BB8"/></svg>`;
export const SVG_LOCK = `<svg width="20" height="20" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect x="4" y="7" width="8" height="7" fill="#131D33" stroke="#2DD4BF" stroke-width="1"/><rect x="6" y="3" width="4" height="4" fill="none" stroke="#60A5FA" stroke-width="1"/><rect x="7" y="9" width="2" height="3" fill="#2DD4BF"/></svg>`;
export const SVG_DOC = `<svg width="20" height="20" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect x="3" y="1" width="10" height="14" fill="#131D33" stroke="#F43F5E" stroke-width="1"/><polygon points="9,1 13,5 9,5" fill="#F43F5E"/><rect x="5" y="7" width="6" height="1" fill="#E6ECF5"/><rect x="5" y="10" width="6" height="1" fill="#E6ECF5"/><rect x="5" y="12" width="4" height="1" fill="#E6ECF5"/></svg>`;

export const VIDEO_MIMES = {
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
        mkv: 'video/x-matroska',
        avi: 'video/x-msvideo',
        gif: 'image/gif',
      };

export const AUDIO_MIMES = {
        flac: 'audio/flac',
        alac: 'audio/mp4',
        wav: 'audio/wav',
        aiff: 'audio/aiff',
        mp3: 'audio/mpeg',
        aac: 'audio/mp4',
        opus: 'audio/opus',
        ogg: 'audio/ogg',
      };

export const SUPPORTED_REPAIR_EXTS = new Set([
        'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp',
        'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v',
        'mp3', 'flac', 'wav', 'm4a', 'ogg', 'opus', 'aiff', 'aif',
      ]);

export const LEGAL_DOCS = {
        privacy: {
          title: 'Privacy Policy | swissfile.dev',
          body: `
            <p><strong style="color:var(--text-main);">1. 100% Local Processing</strong></p>
            <p>All file conversion, repair, metadata inspection, archiving, hashing, and AES 256 GCM encryption operations run entirely inside your browser. Your files, passphrases, and personal data never leave your device and are never uploaded to any server.</p>

            <p><strong style="color:var(--text-main);">2. Zero Ad Networks & Zero Trackers</strong></p>
            <p>swissfile.dev is 100% free of advertising networks, analytics trackers, telemetry beacons, and third party tracking scripts. Zero ad cookies are set, and zero behavioral telemetry is recorded.</p>

            <p><strong style="color:var(--text-main);">3. External Open Source Libraries</strong></p>
            <p>When libraries are not bundled locally under <code style="color:var(--accent-soft);">./vendor/</code>, your browser retrieves pinned open source packages from <code style="color:var(--accent-soft);">unpkg.com</code> or <code style="color:var(--accent-soft);">cdn.jsdelivr.net</code>. No user files or personal details are included in these requests.</p>

            <p><strong style="color:var(--text-main);">4. Optional Map Links</strong></p>
            <p>GPS coordinates found in photo metadata are never transmitted automatically. Choosing an external map link opens openstreetmap.org with those coordinates in the URL.</p>

            <p><strong style="color:var(--text-main);">5. Cookies and Telemetry</strong></p>
            <p>swissfile.dev does not store tracking cookies, third party cookies, or run tracking analytics. The workbench is completely tracker free.</p>

            <p><strong style="color:var(--text-main);">6. Contact and Inquiries</strong></p>
            <p>For support, questions, or bug reports, email our official contact address at <a href="mailto:contact@swissfile.dev" style="color:var(--accent-soft);">contact@swissfile.dev</a>.</p>
          `,
        },
        terms: {
          title: 'Terms of Use | swissfile.dev',
          body: `
            <p><strong style="color:var(--text-main);">1. Acceptance</strong></p>
            <p>By using swissfile.dev you agree to these terms. If you do not agree, please discontinue use of this site.</p>

            <p><strong style="color:var(--text-main);">2. Service Description</strong></p>
            <p>swissfile.dev is a browser based utility that performs all media and file operations locally on your machine. Files never touch a remote server.</p>

            <p><strong style="color:var(--text-main);">3. Disclaimer of Warranties</strong></p>
            <p>This service is provided "as is" and "as available" without warranty of any kind, whether express or implied, including warranties of merchantability, fitness for a particular purpose, or noninfringement. We do not guarantee that every repair, conversion, or archive operation will succeed.</p>

            <p><strong style="color:var(--text-main);">4. Limitation of Liability</strong></p>
            <p>In no event shall the authors or contributors be liable for any direct, indirect, incidental, or consequential damages arising from the use of this tool. Always keep backups of original files before converting, repairing, stripping metadata, or encrypting.</p>

            <p><strong style="color:var(--text-main);">5. Revisions</strong></p>
            <p>These terms may be updated without prior announcement. Continued use constitutes acceptance of all modified terms.</p>

            <p><strong style="color:var(--text-main);">6. Official Contact</strong></p>
            <p>Inquiries regarding these terms may be sent directly to <a href="mailto:contact@swissfile.dev" style="color:var(--accent-soft);">contact@swissfile.dev</a>.</p>
          `,
        },
        licenses: {
          title: 'Open Source Licenses and Pinned Versions',
          body: `
            <p><strong style="color:var(--text-main);">FFmpeg:</strong> LGPL v2.1+ / GPL v2+ (ffmpeg.org).</p>
            <p><strong style="color:var(--text-main);">ffmpeg.wasm (@ffmpeg/ffmpeg@0.12.10, @ffmpeg/core@0.12.6):</strong> MIT / GPL 2.0 or later WebAssembly build of FFmpeg.</p>
            <p><strong style="color:var(--text-main);">JSZip (jszip@3.10.1):</strong> MIT License, browser based ZIP archiving.</p>
            <p><strong style="color:var(--text-main);">exifr (exifr@7.1.3):</strong> MIT License, EXIF, GPS, XMP and IPTC parser.</p>
          `,
        },
      };

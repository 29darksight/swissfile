import { state, archiverState, LEGAL_DOCS } from './state.js';
import { $, $$, logLine, buildSegmentedTrack, wireDropzone, isImageFile, copyToClipboard } from './dom.js';
import { initBackgroundCanvas } from './grid-bg.js';
import {
  switchConvertSub, routeConvertFiles,
  addPhotoFiles, removePhotoItem, clearPhotoQueue, runPhotoBatch, downloadPhotoZip,
  addVideoFiles, removeVideoItem, clearVideoQueue, runVideoBatch, downloadVideoZip, refreshVideoCliPreview,
  addAudioFiles, removeAudioItem, clearAudioQueue, runAudioBatch, downloadAudioZip, refreshAudioCliPreview
} from './photo-video-audio.js';
import {
  setRepairScope, addRepairFiles, removeRepairItem, clearRepairQueue, runRepairBatch,
  runRepairDeepScan, downloadRepairZip
} from './repair.js';
import {
  addExifFiles, handleForensicsFile, clearExifInspector, exportExifJson, exportExifCsv,
  updateHashVerification, renderTotalMetadataDrawer, renderExifTable, deepProbeSelectedMediaWithFFmpeg
} from './forensics.js';
import {
  addScrubFiles, removeScrubItem, clearScrubQueue, runBulkScrub, downloadScrubZip,
  handleLockerFile, encryptLockerFile, decryptLockerFile, updatePassphraseMeter
} from './opsec.js';
import {
  addZipFiles, removeZipItem, clearZipQueue, runZipCompress, handleUnzipFile,
  clearUnzipQueue, extractSingleFile, extractAllFiles
} from './archiver.js';
import { initBugReporting } from './feedback.js';
import { initPhotoEnhancer, handleEnhanceFile } from './photo-enhance.js';
import { initPdfTools, switchDocSub } from './pdf-tools.js';
import { initDeepForensics, switchForensicsSub } from './deep-forensics.js';
import { initFileUtils, switchArchiverSub, switchOpsecSub } from './file-utils.js';
import { ensurePdfLib } from './vendors.js';

export function switchTab(tabId) {
        state.activeTab = tabId;
        if (tabId === 'documents') {
          ensurePdfLib().catch(() => {});
        }
        document.querySelectorAll('.wb-tab').forEach((btn) => {
          const active = btn.dataset.tab === tabId;
          btn.classList.toggle('px-btn-primary', active);
          if (!active) btn.style.color = 'var(--text-muted)';
          else btn.style.color = '';
        });
        document.querySelectorAll('.wb-panel').forEach((panel) => {
          panel.classList.toggle('hidden', panel.id !== `panel-${tabId}`);
        });
      }

window.addEventListener('paste', (e) => {
        const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
        const pasted = [];
        for (const item of items) {
          if (item.kind === 'file') {
            const blob = item.getAsFile();
            if (blob) {
              const ext = (blob.type.split('/')[1] || 'bin').replace('jpeg', 'jpg');
              const name = blob.name && blob.name !== 'image.png' ? blob.name : `clipboard-${Date.now()}.${ext}`;
              pasted.push(new File([blob], name, { type: blob.type }));
            }
          }
        }
        if (pasted.length === 0) return;

        if (state.activeTab === 'enhancer') {
          const img = pasted.find(isImageFile);
          if (img) handleEnhanceFile(img);
        } else if (state.activeTab === 'repair') {
          addRepairFiles(pasted);
        } else if (state.activeTab === 'forensics') {
          addExifFiles(pasted);
          handleForensicsFile(pasted[0]);
        } else if (state.activeTab === 'archiver') {
          addZipFiles(pasted);
        } else if (state.activeTab === 'opsec') {
          const imgs = pasted.filter(isImageFile);
          if (imgs.length > 0) addScrubFiles(imgs);
          else handleLockerFile(pasted[0]);
        } else {
          routeConvertFiles(pasted, state.convertSub);
        }
      });

function openLegalModal(key) {
        const doc = LEGAL_DOCS[key];
        if (!doc) return;
        document.getElementById('legalModalTitle').textContent = doc.title;
        document.getElementById('legalModalBody').innerHTML = doc.body;
        document.getElementById('legalModal').classList.remove('hidden');
      }

      function closeLegalModal() {
        document.getElementById('legalModal').classList.add('hidden');
      }

function bindEvents() {
        document.querySelectorAll('.wb-tab').forEach((btn) => {
          btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });

        document.querySelectorAll('.conv-sub-btn').forEach((btn) => {
          btn.addEventListener('click', () => switchConvertSub(btn.dataset.convertSub));
        });

        document.getElementById('maxFileMbSelect').addEventListener('change', (e) => {
          state.limits.maxFileMb = Number(e.target.value) || 500;
          logLine(`Updated max file size guardrail: ${state.limits.maxFileMb} MB`);
        });

        document.getElementById('bgToggleBtn').addEventListener('click', (e) => {
          state.bgMoving = !state.bgMoving;
          e.currentTarget.textContent = state.bgMoving ? 'BG: MOVING' : 'BG: PAUSED';
        });

        document.getElementById('consoleToggleBtn').addEventListener('click', () => {
          state.consoleOpen = !state.consoleOpen;
          document.getElementById('consoleSection').classList.toggle('hidden', !state.consoleOpen);
        });
        document.getElementById('consoleCopyBtn').addEventListener('click', () => copyToClipboard(state.logs.join('\n'), 'Console logs'));
        document.getElementById('consoleClearBtn').addEventListener('click', () => {
          state.logs = [];
          document.getElementById('consoleOutput').textContent = '';
        });

        // Tab 1A: Photo
        wireDropzone('photoDropzone', 'photoInput', (files) => routeConvertFiles(files, 'photo'), true);
        document.getElementById('photoQuality').addEventListener('input', (e) => {
          document.getElementById('photoQualityVal').textContent = `${e.target.value}%`;
        });
        document.getElementById('photoRunBtn').addEventListener('click', runPhotoBatch);
        document.getElementById('photoCancelBtn').addEventListener('click', () => { state.cancel.photo = true; });
        document.getElementById('photoZipBtn').addEventListener('click', downloadPhotoZip);
        document.getElementById('photoClearBtn').addEventListener('click', clearPhotoQueue);
        document.getElementById('photoQueueList').addEventListener('click', (e) => {
          const btn = e.target.closest('[data-remove-photo]');
          if (btn && !state.busy.photo) removePhotoItem(btn.dataset.removePhoto);
        });

        // Tab 1B: Video
        wireDropzone('videoDropzone', 'videoInput', (files) => routeConvertFiles(files, 'video'), true);
        ['videoFormat', 'videoRes', 'videoQuality', 'videoMute'].forEach((id) => {
          document.getElementById(id).addEventListener('change', refreshVideoCliPreview);
        });
        document.getElementById('videoCopyCliBtn').addEventListener('click', () => {
          copyToClipboard(document.getElementById('videoCliPreview').textContent, 'Video FFmpeg CLI');
        });
        document.getElementById('videoRunBtn').addEventListener('click', runVideoBatch);
        document.getElementById('videoCancelBtn').addEventListener('click', () => { state.cancel.video = true; });
        document.getElementById('videoZipBtn').addEventListener('click', downloadVideoZip);
        document.getElementById('videoClearBtn').addEventListener('click', clearVideoQueue);
        document.getElementById('videoQueueList').addEventListener('click', (e) => {
          const btn = e.target.closest('[data-remove-video]');
          if (btn && !state.busy.video) removeVideoItem(btn.dataset.removeVideo);
        });

        // Tab 1C: Audio
        wireDropzone('audioDropzone', 'audioInput', (files) => routeConvertFiles(files, 'audio'), true);
        ['audioFormat', 'audioQuality', 'audioSampleRate', 'audioBitDepth', 'audioPreserveMeta'].forEach((id) => {
          document.getElementById(id).addEventListener('change', refreshAudioCliPreview);
        });
        document.getElementById('audioCopyCliBtn').addEventListener('click', () => {
          copyToClipboard(document.getElementById('audioCliPreview').textContent, 'Audio FFmpeg CLI');
        });
        document.getElementById('audioRunBtn').addEventListener('click', runAudioBatch);
        document.getElementById('audioCancelBtn').addEventListener('click', () => { state.cancel.audio = true; });
        document.getElementById('audioZipBtn').addEventListener('click', downloadAudioZip);
        document.getElementById('audioClearBtn').addEventListener('click', clearAudioQueue);
        document.getElementById('audioQueueList').addEventListener('click', (e) => {
          const btn = e.target.closest('[data-remove-audio]');
          if (btn && !state.busy.audio) removeAudioItem(btn.dataset.removeAudio);
        });

        // Tab 2: Repair
        wireDropzone('repairDropzone', 'repairInput', addRepairFiles, true);
        document.getElementById('repairScopeCorruptBtn').addEventListener('click', () => setRepairScope('corrupted'));
        document.getElementById('repairScopeAllBtn').addEventListener('click', () => setRepairScope('all'));
        document.getElementById('repairRunBtn').addEventListener('click', runRepairBatch);
        document.getElementById('repairCancelBtn').addEventListener('click', () => { state.cancel.repair = true; });
        document.getElementById('repairDeepScanBtn').addEventListener('click', runRepairDeepScan);
        document.getElementById('repairZipBtn').addEventListener('click', downloadRepairZip);
        document.getElementById('repairClearBtn').addEventListener('click', clearRepairQueue);
        document.getElementById('repairQueueList').addEventListener('click', (e) => {
          const btn = e.target.closest('[data-remove-repair]');
          if (btn && !state.busy.repair) removeRepairItem(btn.dataset.removeRepair);
        });

        // Tab 3: Forensics
        wireDropzone('exifDropzone', 'exifInput', addExifFiles, true);
        document.getElementById('exifTableBody').addEventListener('click', (e) => {
          const tr = e.target.closest('[data-select-exif]');
          if (tr) {
            state.forensics.selectedExifId = tr.dataset.selectExif;
            state.forensics.totalMetaGroup = 'ALL';
            renderExifTable();
            renderTotalMetadataDrawer();
          }
        });
        document.getElementById('deepProbeStreamsBtn').addEventListener('click', deepProbeSelectedMediaWithFFmpeg);
        document.getElementById('totalMetaGroupPills').addEventListener('click', (e) => {
          const btn = e.target.closest('[data-meta-group]');
          if (btn) {
            state.forensics.totalMetaGroup = btn.dataset.metaGroup;
            renderTotalMetadataDrawer();
          }
        });
        document.getElementById('totalMetaSearch').addEventListener('input', (e) => {
          state.forensics.totalMetaSearch = e.target.value;
          renderTotalMetadataDrawer();
        });
        document.getElementById('copyAllTagsJsonBtn').addEventListener('click', () => {
          const sel = state.forensics.exifRows.find((r) => r.id === state.forensics.selectedExifId);
          if (!sel) return;
          const grouped = {};
          for (const t of sel.flatTags) {
            if (!grouped[t.group]) grouped[t.group] = {};
            grouped[t.group][t.key] = t.value;
          }
          copyToClipboard(JSON.stringify({ filename: sel.filename, extractedFields: sel.totalTags, metadata: grouped }, null, 2), 'Metadata JSON');
        });
        document.getElementById('exifExportJsonBtn').addEventListener('click', exportExifJson);
        document.getElementById('exifExportCsvBtn').addEventListener('click', exportExifCsv);
        document.getElementById('exifClearBtn').addEventListener('click', clearExifInspector);

        wireDropzone('forensicsDropzone', 'forensicsInput', (files) => handleForensicsFile(files[0]), false);
        document.getElementById('copySha256Btn').addEventListener('click', () => copyToClipboard(state.forensics.sha256, 'SHA-256'));
        document.getElementById('copySha512Btn').addEventListener('click', () => copyToClipboard(state.forensics.sha512, 'SHA-512'));
        document.getElementById('expectedHashInput').addEventListener('input', updateHashVerification);

        // Tab 4: OpSec
        wireDropzone('scrubDropzone', 'scrubInput', addScrubFiles, true);
        document.getElementById('scrubRunBtn').addEventListener('click', runBulkScrub);
        document.getElementById('scrubCancelBtn').addEventListener('click', () => { state.cancel.scrub = true; });
        document.getElementById('scrubZipBtn').addEventListener('click', downloadScrubZip);
        document.getElementById('scrubClearBtn').addEventListener('click', clearScrubQueue);
        document.getElementById('scrubQueueList').addEventListener('click', (e) => {
          const btn = e.target.closest('[data-remove-scrub]');
          if (btn && !state.busy.scrub) removeScrubItem(btn.dataset.removeScrub);
        });

        wireDropzone('lockerDropzone', 'lockerInput', (files) => handleLockerFile(files[0]), false);
        document.getElementById('lockerPassword').addEventListener('input', updatePassphraseMeter);
        document.getElementById('lockerClearPassBtn').addEventListener('click', () => {
          document.getElementById('lockerPassword').value = '';
          updatePassphraseMeter();
        });
        document.getElementById('lockerTogglePassBtn').addEventListener('click', (e) => {
          const input = document.getElementById('lockerPassword');
          const show = input.type === 'password';
          input.type = show ? 'text' : 'password';
          e.currentTarget.textContent = show ? 'Hide' : 'Show';
        });
        document.getElementById('lockerEncryptBtn').addEventListener('click', encryptLockerFile);
        document.getElementById('lockerDecryptBtn').addEventListener('click', decryptLockerFile);

        // Tab 5: Archiver
        wireDropzone('zipDropzone', 'zipInput', (files) => addZipFiles(files), true);
        document.getElementById('zipRunBtn').addEventListener('click', runZipCompress);
        document.getElementById('zipClearBtn').addEventListener('click', clearZipQueue);
        document.getElementById('zipQueueList').addEventListener('click', (e) => {
          const btn = e.target.closest('[data-remove-zip]');
          if (btn) removeZipItem(btn.dataset.removeZip);
        });
        wireDropzone('unzipDropzone', 'unzipInput', (files) => handleUnzipFile(files[0]), false);
        document.getElementById('unzipExtractAllBtn').addEventListener('click', extractAllFiles);
        document.getElementById('unzipClearBtn').addEventListener('click', clearUnzipQueue);
        document.getElementById('unzipFileList').addEventListener('click', (e) => {
          const btn = e.target.closest('[data-extract-single]');
          if (btn) extractSingleFile(Number(btn.dataset.extractSingle));
        });

        // Legal modals
        document.querySelectorAll('[data-legal]').forEach((btn) => {
          btn.addEventListener('click', () => openLegalModal(btn.dataset.legal));
        });
        document.getElementById('legalCloseBtn').addEventListener('click', closeLegalModal);
        document.getElementById('legalModal').addEventListener('click', (e) => {
          if (e.target.id === 'legalModal') closeLegalModal();
        });
        window.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') closeLegalModal();
        });
      }

// Workbench boot sequence
['photoSegTrack', 'videoSegTrack', 'audioSegTrack', 'repairSegTrack', 'hashSegTrack', 'scrubSegTrack', 'lockerSegTrack', 'zipSegTrack', 'unzipSegTrack'].forEach((id) => buildSegmentedTrack(id));
bindEvents();
initBugReporting();
initPhotoEnhancer();
initPdfTools();
initDeepForensics();
initFileUtils();
switchTab('convert');
switchConvertSub('photo');
switchDocSub('editor');
switchForensicsSub('meta');
switchArchiverSub('archive');
switchOpsecSub('scrublock');
setRepairScope('corrupted');
refreshVideoCliPreview();
refreshAudioCliPreview();
initBackgroundCanvas();
logLine('swissfile.dev v1.7 initialized (Enhancer, Documents, Deep Forensics & File Utilities active).');


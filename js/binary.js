import { formatBytes, extOf } from './dom.js';

export function bytesToHex(bytes) {
        return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      }

      export function bytesToAscii(bytes) {
        return Array.from(bytes).map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
      }

      export function detectMagicSignature(bytes) {
        if (!bytes || bytes.length === 0) return { id: 'empty', label: 'Empty (0 bytes)', exts: [], kind: 'unsupported' };
        if (bytes.every((b) => b === 0)) return { id: 'null', label: 'Zero filled header (00 00...)', exts: [], kind: 'corrupt' };

        const hex = (n) => Array.from(bytes.slice(0, n)).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        const asc = (s, e) => Array.from(bytes.slice(s, e)).map((b) => String.fromCharCode(b)).join('');

        if (bytes.length >= 3 && hex(3) === 'FF D8 FF') return { id: 'jpeg', label: 'JPEG Image (FF D8 FF)', exts: ['jpg', 'jpeg', 'jfif'], kind: 'photo' };
        if (bytes.length >= 8 && hex(8) === '89 50 4E 47 0D 0A 1A 0A') return { id: 'png', label: 'PNG Image (89 50 4E 47)', exts: ['png'], kind: 'photo' };
        if (bytes.length >= 6 && (asc(0, 6) === 'GIF87a' || asc(0, 6) === 'GIF89a')) return { id: 'gif', label: 'GIF Image (GIF87a/89a)', exts: ['gif'], kind: 'photo' };
        if (bytes.length >= 12 && asc(0, 4) === 'RIFF' && asc(8, 12) === 'WEBP') return { id: 'webp', label: 'WebP Image (RIFF WEBP)', exts: ['webp'], kind: 'photo' };
        if (bytes.length >= 4 && (hex(4) === '49 49 2A 00' || hex(4) === '4D 4D 00 2A')) return { id: 'tiff', label: 'TIFF Image (Browser Canvas Unsupported)', exts: ['tif', 'tiff'], kind: 'unsupported' };
        if (bytes.length >= 12 && asc(0, 4) === 'RIFF' && asc(8, 12) === 'WAVE') return { id: 'wav', label: 'WAV Audio (RIFF WAVE)', exts: ['wav'], kind: 'audio' };
        if (bytes.length >= 12 && asc(0, 4) === 'RIFF' && asc(8, 12) === 'AVI ') return { id: 'avi', label: 'AVI Video (RIFF AVI)', exts: ['avi'], kind: 'video' };
        if (bytes.length >= 4 && asc(0, 4) === 'FORM') return { id: 'aiff', label: 'AIFF Audio (IFF FORM)', exts: ['aiff', 'aif'], kind: 'audio' };
        if (bytes.length >= 2 && asc(0, 2) === 'BM') return { id: 'bmp', label: 'BMP Bitmap (BM)', exts: ['bmp'], kind: 'photo' };
        if (bytes.length >= 4 && hex(4) === '25 50 44 46') return { id: 'pdf', label: 'PDF Document (%PDF)', exts: ['pdf'], kind: 'unsupported' };
        if (bytes.length >= 4 && (hex(4) === '50 4B 03 04' || hex(4) === '50 4B 05 06')) return { id: 'zip', label: 'ZIP / Office / APK Archive (PK..)', exts: ['zip', 'docx', 'xlsx', 'pptx', 'apk', 'jar', 'epub'], kind: 'unsupported' };
        if (bytes.length >= 2 && hex(2) === '1F 8B') return { id: 'gzip', label: 'GZIP Archive (1F 8B)', exts: ['gz', 'tgz'], kind: 'unsupported' };
        if (bytes.length >= 4 && hex(4) === '1A 45 DF A3') return { id: 'ebml', label: 'Matroska / WebM (EBML)', exts: ['mkv', 'webm', 'mka'], kind: 'video' };
        if (bytes.length >= 4 && asc(0, 4) === 'fLaC') return { id: 'flac', label: 'FLAC Lossless Audio (fLaC)', exts: ['flac'], kind: 'audio' };
        if (bytes.length >= 4 && asc(0, 4) === 'OggS') return { id: 'ogg', label: 'Ogg / Opus Container (OggS)', exts: ['ogg', 'opus', 'oga', 'ogv'], kind: 'audio' };
        if (bytes.length >= 12 && asc(4, 8) === 'ftyp') {
          const brand = asc(8, 12).toLowerCase();
          if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) {
            return { id: 'heic', label: `HEIC/HEIF Image (ftyp${brand})`, exts: ['heic', 'heif'], kind: 'unsupported' };
          }
          if (brand === 'avif' || brand === 'avis') {
            return { id: 'avif', label: `AVIF Image (ftyp${brand})`, exts: ['avif'], kind: 'photo' };
          }
          if (brand.startsWith('m4a') || brand.startsWith('m4b')) {
            return { id: 'isobmff-audio', label: `M4A Audio Container (ftyp${brand})`, exts: ['m4a', 'alac', 'aac'], kind: 'audio' };
          }
          return { id: 'isobmff', label: `ISO Base Media (ftyp${brand})`, exts: ['mp4', 'mov', 'm4a', 'alac', 'aac', 'm4v', '3gp'], kind: 'video' };
        }
        if (bytes.length >= 3 && (asc(0, 3) === 'ID3' || (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0))) return { id: 'mp3', label: 'MP3 Audio Stream', exts: ['mp3'], kind: 'audio' };
        if (bytes.length >= 2 && asc(0, 2) === 'MZ') return { id: 'pe', label: 'Windows Executable (PE / MZ)', exts: ['exe', 'dll', 'sys'], kind: 'unsupported' };
        if (bytes.length >= 4 && hex(4) === '7F 45 4C 46') return { id: 'elf', label: 'Linux ELF Binary', exts: ['elf', 'so', 'bin'], kind: 'unsupported' };
        if (bytes.length >= 4 && ['CF FA ED FE', 'CE FA ED FE', 'FE ED FA CF', 'CA FE BA BE'].includes(hex(4))) return { id: 'macho', label: 'macOS Mach-O Binary', exts: ['dylib', 'o', 'bin'], kind: 'unsupported' };
        if (bytes.length >= 8 && ['SWISSLK3', 'SWLK02\0\0', 'SWLK01\0\0'].includes(asc(0, 8))) return { id: 'swisslock', label: 'swissfile AES-256 Locker', exts: ['swisslock'], kind: 'unsupported' };
        if (bytes.length >= 5 && (asc(0, 5).toLowerCase() === '<!doc' || asc(0, 5).toLowerCase() === '<html' || asc(0, 5) === '<?xml')) return { id: 'html', label: 'HTML / XML Document', exts: ['html', 'htm', 'xml', 'svg'], kind: 'unsupported' };

        return { id: 'unknown', label: 'Unrecognized Binary / Plain Text', exts: null, kind: 'unsupported' };
      }

      // Detect animated GIFs by checking NETSCAPE2.0 loop block or multiple image descriptors
      export async function detectAnimatedGif(file) {
        if (extOf(file.name) !== 'gif' && file.type !== 'image/gif') return false;
        const slice = new Uint8Array(await file.slice(0, Math.min(file.size, 262144)).arrayBuffer());
        const ascii = bytesToAscii(slice);
        if (ascii.includes('NETSCAPE2.0') || ascii.includes('ANIMEXTS1.0')) return true;
        let descriptors = 0;
        for (let i = 6; i < slice.length - 1; i++) {
          if (slice[i] === 0x2C) {
            descriptors++;
            if (descriptors >= 2) return true;
          }
        }
        return false;
      }

      // Format-aware JPEG/PNG/WebP binary metadata segment scanner
      export async function inspectImageBinaryMetadataSegments(blobOrFile) {
        const bytes = new Uint8Array(await blobOrFile.arrayBuffer());
        const sig = detectMagicSignature(bytes.slice(0, 16));
        const segments = [];

        if (sig.id === 'jpeg') {
          let i = 2;
          while (i + 4 <= bytes.length) {
            if (bytes[i] !== 0xFF) break;
            while (i < bytes.length && bytes[i] === 0xFF) i++;
            if (i >= bytes.length) break;
            const marker = bytes[i++];
            if (marker === 0xD9 || marker === 0xDA) break;
            if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
            if (i + 2 > bytes.length) break;
            const segLen = (bytes[i] << 8) | bytes[i + 1];
            if (segLen < 2 || i + segLen > bytes.length) break;

            const payload = bytes.slice(i + 2, i + segLen);
            const hdr = bytesToAscii(payload.slice(0, 28));

            if (marker === 0xE1) {
              const label = hdr.startsWith('Exif') ? 'APP1 (EXIF / GPS / Thumbnail)' : hdr.includes('ns.adobe.com/xap') ? 'APP1 (XMP Metadata)' : 'APP1 (Application Metadata)';
              segments.push({ marker, label, offset: i - 2, totalBytes: segLen + 2 });
            } else if (marker === 0xE2) {
              segments.push({ marker, label: hdr.startsWith('ICC_PROFILE') ? 'APP2 (ICC Color Profile)' : 'APP2 (Extended Metadata)', offset: i - 2, totalBytes: segLen + 2 });
            } else if (marker === 0xED) {
              segments.push({ marker, label: 'APP13 (IPTC / Photoshop IRB)', offset: i - 2, totalBytes: segLen + 2 });
            } else if (marker === 0xFE) {
              segments.push({ marker, label: 'COM (JPEG Comment)', offset: i - 2, totalBytes: segLen + 2 });
            } else if (marker >= 0xE3 && marker <= 0xEF) {
              segments.push({ marker, label: `APP${marker - 0xE0} (Vendor Application Data)`, offset: i - 2, totalBytes: segLen + 2 });
            }
            i += segLen;
          }
          return { format: 'jpeg', segments };
        }

        if (sig.id === 'png') {
          const META_CHUNKS = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'iCCP', 'tIME']);
          let i = 8;
          while (i + 12 <= bytes.length) {
            const len = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
            const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
            const totalChunk = 12 + len;
            if (i + totalChunk > bytes.length) break;
            if (META_CHUNKS.has(type)) {
              segments.push({ type, label: `PNG Chunk: ${type} (${len} B)`, offset: i, totalBytes: totalChunk });
            }
            i += totalChunk;
            if (type === 'IEND') break;
          }
          return { format: 'png', segments };
        }

        if (sig.id === 'webp') {
          let i = 12;
          while (i + 8 <= bytes.length) {
            const fourcc = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
            const chunkSize = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
            const padded = chunkSize + (chunkSize % 2);
            if (['EXIF', 'XMP ', 'ICCP'].includes(fourcc)) {
              segments.push({ type: fourcc, label: `WebP Chunk: ${fourcc.trim()} (${chunkSize} B)`, offset: i, totalBytes: 8 + padded });
            }
            i += 8 + padded;
          }
          return { format: 'webp', segments };
        }

        return { format: sig.id, segments };
      }

      // Lossless binary segment stripper for JPEG and PNG (zero pixel re-encoding)
      export async function stripMetadataLosslessBinary(file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const sig = detectMagicSignature(bytes.slice(0, 16));

        if (sig.id === 'jpeg') {
          const STRIP_MARKERS = new Set([0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xED, 0xEE, 0xEF, 0xFE]);
          const outParts = [bytes.slice(0, 2)];
          let i = 2;
          let strippedCount = 0;

          while (i + 2 <= bytes.length) {
            if (bytes[i] !== 0xFF) {
              outParts.push(bytes.slice(i));
              break;
            }
            const markerStart = i;
            while (i < bytes.length && bytes[i] === 0xFF) i++;
            if (i >= bytes.length) break;
            const marker = bytes[i++];

            if (marker === 0xDA || marker === 0xD9) {
              outParts.push(bytes.slice(markerStart));
              break;
            }
            if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
              outParts.push(bytes.slice(markerStart, i));
              continue;
            }
            if (i + 2 > bytes.length) break;
            const segLen = (bytes[i] << 8) | bytes[i + 1];
            const segEnd = i + segLen;
            if (segLen < 2 || segEnd > bytes.length) {
              throw new Error('Malformed JPEG segment length during lossless strip');
            }

            if (STRIP_MARKERS.has(marker)) {
              strippedCount++;
            } else {
              outParts.push(bytes.slice(markerStart, segEnd));
            }
            i = segEnd;
          }

          return {
            blob: new Blob(outParts, { type: 'image/jpeg' }),
            ext: 'jpg',
            strippedCount,
            method: 'Lossless JPEG Binary Strip',
          };
        }

        if (sig.id === 'png') {
          const STRIP_CHUNKS = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'iCCP', 'tIME']);
          const outParts = [bytes.slice(0, 8)];
          let i = 8;
          let strippedCount = 0;

          while (i + 12 <= bytes.length) {
            const len = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
            const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
            const totalChunk = 12 + len;
            if (i + totalChunk > bytes.length) {
              throw new Error('Truncated PNG chunk during lossless strip');
            }
            if (STRIP_CHUNKS.has(type)) {
              strippedCount++;
            } else {
              outParts.push(bytes.slice(i, i + totalChunk));
            }
            i += totalChunk;
            if (type === 'IEND') break;
          }

          return {
            blob: new Blob(outParts, { type: 'image/png' }),
            ext: 'png',
            strippedCount,
            method: 'Lossless PNG Chunk Strip',
          };
        }

        return null;
      }

      // Binary ISO-BMFF (MP4/MOV/M4A) container atom parser for Forensics
      export async function parseIsoBmffHeader(file) {
        const slice = new Uint8Array(await file.slice(0, Math.min(file.size, 262144)).arrayBuffer());
        const view = new DataView(slice.buffer);
        const atoms = [];
        const brands = [];
        const codecs = new Set();
        let timescale = 0;
        let durationUnits = 0;

        function walk(offset, end, depth) {
          if (depth > 6) return;
          let pos = offset;
          while (pos + 8 <= end) {
            let size = view.getUint32(pos, false);
            const type = String.fromCharCode(slice[pos + 4], slice[pos + 5], slice[pos + 6], slice[pos + 7]);
            let hdrSize = 8;
            if (size === 1 && pos + 16 <= end) {
              size = Number(view.getBigUint64(pos + 8, false));
              hdrSize = 16;
            }
            if (size < hdrSize || pos + size > end) break;
            if (depth <= 2) atoms.push(`${type} (${formatBytes(size)})`);

            if (type === 'ftyp' && size >= 16) {
              const major = String.fromCharCode(slice[pos + 8], slice[pos + 9], slice[pos + 10], slice[pos + 11]).trim();
              brands.push(`Major: ${major}`);
              for (let b = pos + 16; b + 4 <= pos + size; b += 4) {
                const compat = String.fromCharCode(slice[b], slice[b + 1], slice[b + 2], slice[b + 3]).trim();
                if (compat) brands.push(compat);
              }
            } else if (type === 'mvhd' && size >= 28) {
              const ver = slice[pos + 8];
              if (ver === 0) {
                timescale = view.getUint32(pos + 20, false);
                durationUnits = view.getUint32(pos + 24, false);
              } else if (ver === 1 && size >= 40) {
                timescale = view.getUint32(pos + 28, false);
                durationUnits = Number(view.getBigUint64(pos + 32, false));
              }
            } else if (type === 'stsd' && size >= 24) {
              const entryFourCC = String.fromCharCode(slice[pos + 20], slice[pos + 21], slice[pos + 22], slice[pos + 23]).trim();
              if (/^[a-zA-Z0-9._-]{3,4}$/.test(entryFourCC)) codecs.add(entryFourCC);
            }

            if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta'].includes(type)) {
              const childStart = type === 'meta' ? pos + 12 : pos + hdrSize;
              walk(childStart, pos + size, depth + 1);
            }
            pos += size;
          }
        }

        walk(0, slice.length, 0);
        return {
          atoms: atoms.join(', '),
          brands: brands.join(', '),
          codecs: Array.from(codecs).join(', '),
          durationSec: timescale > 0 ? (durationUnits / timescale).toFixed(3) : '',
        };
      }



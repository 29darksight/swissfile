# SwissFile (swissfile.dev)

A 100% private, client-side file workbench built with modern web standards (ES modules, WebAssembly, WebGL, Web Crypto API, HTML5 Canvas). All file operations occur entirely inside your browser memory; zero user files, media streams, metadata, or passphrases ever touch an external server.

---

## Key Features

- **Media Conversion**: Photo, video, and audio batch conversion with customizable codecs, resolution downscaling, and ZIP bundling via `ffmpeg.wasm` and Canvas.
- **Photo Enhancer & AI Upscaler**: Single-image photo enhancement with split-view comparison, adaptive histogram equalization, smart sharpening, denoise filters, and WebGL tile-based 2x neural super-resolution (`UpscalerJS` fallback to bicubic sharpen).
- **PDF Document Lab**: Client-side PDF page editor (reorder, rotate, delete), multi-document merger, page splitter/extractor, metadata scrubber, and multi-image compiler using `pdf-lib`.
- **Media Repair**: Container re-wrapping, header validation, keyframe salvage, and decoder verification for corrupted MP4, MOV, WebM, MP3, and WAV files.
- **Forensics & Deep Analysis**:
  - Container atom inspector and EXIF/GPS/XMP/IPTC/ICC metadata viewer (`exifr`).
  - Magic bytes header detector for 25+ binary file types.
  - Streaming chunked SHA-256 and SHA-512 cryptographic checksums.
  - Streaming ASCII strings and IOC extractor (URLs, IPv4, emails, crypto hashes).
  - Byte-by-byte binary diff and hex comparison.
  - Streaming Shannon entropy meter with byte frequency distribution.
  - Tampering Lab with LSB bit-plane isolator and Error Level Analysis (ELA).
- **OpSec & Cryptography**:
  - Lossless JPEG/PNG metadata stripping or full canvas pixel redraw.
  - Chunked AES-256-GCM client-side encryption and decryption (`.swisslock` container format).
  - Base64, Data URI, and spaced hex encoder/decoder.
- **Archiver & Utilities**:
  - ZIP, TAR, TAR.GZ, GZ, 7Z, and RAR unpacking via `JSZip` and local parsers.
  - Pure client-side zero-copy file splitter and joiner.
  - Batch smart renamer with live collision resolution.

---

## Zero-Upload Architecture & Privacy Model

SwissFile operates under a strict client-side isolation model:
1. **Local Memory Only**: Files are read into WebAssembly heap, ArrayBuffers, or Canvas contexts on the local device.
2. **Network Isolation**: No remote API endpoints or file upload servers exist.
3. **Open-Source CDN Fallbacks**: External vendor libraries (`pdf-lib`, `jszip`, `ffmpeg.wasm`, `upscaler`) are pinned to immutable CDN distributions and loaded lazily on demand.
4. **Content Security Policy**: Hardened CSP header enforcing strict script, worker, and connect boundaries.

---

## Supported Formats

| Category | Supported Formats |
| :--- | :--- |
| **Photos & Images** | PNG, JPEG, WebP, BMP, GIF (static/frame 1), AVIF, TIFF |
| **Video** | MP4 (H.264), WebM (VP8/VP9), MOV, MKV, AVI |
| **Audio** | MP3, WAV, FLAC, AAC, M4A, OGG, OPUS, AIFF |
| **Documents** | PDF (standard, unencrypted) |
| **Archives** | ZIP, TAR, TAR.GZ, TGZ, GZ, 7Z, RAR |
| **Containers** | SWISSLK3 (`.swisslock` AES-256-GCM) |

---

## Local Development & Static Hosting

SwissFile requires no backend or build step. Any static HTTP server can host it:

```bash
# Clone the repository
git clone https://github.com/swissfile/swissfile.dev.git
cd swissfile.dev

# Start local preview server (Python 3)
python3 -m http.server 8000

# Open in browser
open http://localhost:8000
```

### GitHub Pages Deployment
Push the repository to the `main` branch and enable **GitHub Pages** under repository settings (Deploy from branch: `/root`).

---

## License

Open-source MIT License. See [LICENSE](LICENSE) for details.

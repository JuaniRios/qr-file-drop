# QR File Drop

Move a file from a computer to a phone with an animated QR code. One static
page, no backend, no install, no upload. After the first visit it works with
Wi‑Fi and mobile data off (installable PWA).

**Site:** https://juanirios.github.io/qr-file-drop/

## How to use

1. Open the site on the computer and on the phone.
2. Computer: **Send a file**, drop or choose the file. A moving code appears.
3. Phone: **Receive a file** → **Start camera** → point it at the code.
4. Wait for the bar to fill, then tap **Save file**.

## How it works

- `docs/js/protocol.js` — wire format and fountain code. The file plus its
  name, MIME type and SHA-256 form a "container", split into K blocks
  (600 bytes by default). Frames 0..K-1 carry one block each (systematic);
  every later frame carries the XOR of a pseudo-random half of the blocks,
  seeded by (transfer ID, frame index). The receiver does online Gaussian
  elimination over GF(2), so any ~K+2 distinct frames, in any order, rebuild
  the file. The SHA-256 is checked before **Save** appears.
- Frame header (17 bytes): `"QF"`, version, block size, transfer ID,
  container length, frame index; then the payload. QR byte mode.
- Sender: `qrcode` (vendored, ES module) builds each code; drawn on a canvas.
- Receiver: rear camera → centre square crop (≤1080 px) → 1–2 Web Workers
  running the vendored `zxing-wasm` reader. (The native `BarcodeDetector` is
  not used: it returns text, which corrupts binary byte-mode payloads, and iOS
  does not have it.)
- `docs/sw.js` precaches every file; the page shows "Ready to work offline"
  once the cache is complete.

## Develop

```sh
npm ci
npm run build      # vendors libraries into docs/vendor, draws icons, writes docs/sw.js
npm test           # protocol + render/decode tests (+ browser test if Chromium is found)
CHROME=/path/to/chromium npm test
npm run serve      # http://127.0.0.1:8080/
```

GitHub Pages serves the `docs/` folder of `main`.

## Vendored libraries (exact versions)

- qrcode 1.5.4 (MIT) and its dependency dijkstrajs 1.0.3 (MIT)
- zxing-wasm 3.1.6 (MIT), with zxing-cpp compiled in (Apache-2.0)

License texts: `docs/vendor/LICENSES.txt`.

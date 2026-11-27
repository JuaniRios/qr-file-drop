// Classic worker: decodes one camera frame at a time with the vendored
// zxing-wasm reader. Returns the raw QR bytes (byte mode) or null.
/* global ZXingWASM */
importScripts("../vendor/zxing-reader.js");

const base = new URL("../vendor/", self.location.href).href;
ZXingWASM.prepareZXingModule({
  overrides: { locateFile: (path) => base + path },
  fireImmediately: true,
}).then(() => self.postMessage({ type: "ready" }), (e) => self.postMessage({ type: "fatal", message: String(e) }));

const OPTS = {
  formats: ["QRCode"],
  tryHarder: true,
  tryRotate: false,
  tryInvert: false,
  tryDownscale: true,
  maxNumberOfSymbols: 1,
};

self.onmessage = async (e) => {
  const { id, width, height, buffer } = e.data;
  let bytes = null;
  try {
    const img = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const res = await ZXingWASM.readBarcodes(img, OPTS);
    if (res.length && res[0].isValid && res[0].bytes && res[0].bytes.length) bytes = new Uint8Array(res[0].bytes);
  } catch (err) {
    self.postMessage({ type: "result", id, bytes: null, error: String(err) });
    return;
  }
  self.postMessage({ type: "result", id, bytes, buffer }, bytes ? [bytes.buffer, buffer] : [buffer]);
};

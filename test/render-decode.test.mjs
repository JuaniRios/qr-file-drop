// Renders real frames with the vendored QR generator and decodes them with the
// vendored zxing-wasm reader (the same files the site ships).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { create } from "../docs/vendor/qrcode.mjs";
import { buildContainer, openContainer, Encoder, Decoder, parseFrame } from "../docs/js/protocol.js";
import { PRESETS, renderToRgba } from "../docs/js/qrframe.js";

const dir = new URL("../docs/vendor/", import.meta.url);
const ctx = { console, URL, WebAssembly, setTimeout, clearTimeout, TextDecoder, TextEncoder, fetch: undefined, performance };
ctx.self = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("zxing-reader.js", dir), "utf8"), ctx);
const ZX = ctx.ZXingWASM;
const wasm = readFileSync(new URL("zxing_reader.wasm", dir));
ZX.prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) }, fireImmediately: true });

const OPTS = { formats: ["QRCode"], tryHarder: true, tryRotate: false, tryInvert: false, maxNumberOfSymbols: 1 };

for (const [key, p] of Object.entries(PRESETS)) {
  test(`preset ${key}: 40 KB file through real QR render + zxing decode`, async () => {
    const file = new Uint8Array(randomBytes(40 * 1024));
    const c = await buildContainer(file, "photo.jpg", "image/jpeg");
    const encd = new Encoder(c, p.blockSize, 0xabcdef);
    let dec = null, n = 0, version = 0;
    const t0 = performance.now();
    for (let i = 0; !dec?.done; i++) {
      if (i % 4 === 3) continue; // drop 25% of frames
      const qr = create([{ data: encd.frame(i), mode: "byte" }], { errorCorrectionLevel: p.ecc });
      version = qr.version;
      const img = renderToRgba(qr.modules, 4);
      const res = await ZX.readBarcodes({ data: img.data, width: img.width, height: img.height, colorSpace: "srgb" }, OPTS);
      assert.equal(res.length, 1, `frame ${i} not decoded`);
      const f = parseFrame(new Uint8Array(res[0].bytes));
      assert.ok(f, `frame ${i} bytes did not parse (byte mode corrupted?)`);
      dec ??= new Decoder(f.transferId, f.totalLength, f.blockSize);
      dec.add(f); n++;
    }
    const ms = (performance.now() - t0) / n;
    const out = await openContainer(await dec.result());
    assert.deepEqual(Buffer.from(out.file), Buffer.from(file));
    assert.equal(out.name, "photo.jpg");
    console.log(`  ${key}: block ${p.blockSize} B, ECC ${p.ecc}, QR version ${version}, ${n} frames for K=${encd.K}, ${ms.toFixed(1)} ms per render+decode`);
  });
}

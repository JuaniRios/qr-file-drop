// Vendors the runtime libraries into docs/vendor, draws the app icons, and
// writes docs/sw.js with a precache list and a content-hash cache version.
// Run: npm run build
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PNG } from "pngjs";

const root = new URL("..", import.meta.url).pathname;
const site = join(root, "docs");
const vendor = join(site, "vendor");
const nm = join(root, "node_modules");
mkdirSync(vendor, { recursive: true });
mkdirSync(join(site, "icons"), { recursive: true });

const pkg = (name) => JSON.parse(readFileSync(join(nm, name, "package.json"), "utf8"));
const qrVer = pkg("qrcode").version, zxVer = pkg("zxing-wasm").version;

// 1. qrcode (generator core only) as one ES module.
await build({
  stdin: { contents: `export { create } from "qrcode/lib/core/qrcode.js";`, resolveDir: root },
  bundle: true, format: "esm", minify: true, outfile: join(vendor, "qrcode.mjs"),
  banner: { js: `/*! qrcode ${qrVer} (MIT) + dijkstrajs ${pkg("dijkstrajs").version} (MIT); see vendor/LICENSES.txt */` },
  logLevel: "warning",
});

// 2. zxing-wasm reader (IIFE for a classic worker) + its wasm.
copyFileSync(join(nm, "zxing-wasm/dist/iife/reader/index.js"), join(vendor, "zxing-reader.js"));
copyFileSync(join(nm, "zxing-wasm/dist/reader/zxing_reader.wasm"), join(vendor, "zxing_reader.wasm"));

// 3. Licenses.
const lic = [
  `Third-party software bundled in this site\n=========================================\n`,
  `qrcode ${qrVer} — https://github.com/soldair/node-qrcode — MIT\n\n${readFileSync(join(nm, "qrcode/license"), "utf8")}`,
  `dijkstrajs ${pkg("dijkstrajs").version} — https://github.com/tcort/dijkstrajs — MIT\n\n${readFileSync(join(nm, "dijkstrajs/LICENSE.md"), "utf8")}`,
  `zxing-wasm ${zxVer} — https://github.com/Sec-ant/zxing-wasm — MIT\n\n${readFileSync(join(nm, "zxing-wasm/LICENSE"), "utf8")}`,
  `zxing-cpp (compiled into zxing_reader.wasm, commit 2c3dcfeffa7878950a58c1703c86774a428b0c91) — https://github.com/zxing-cpp/zxing-cpp — Apache License 2.0\n\n${readFileSync(join(root, "licenses/Apache-2.0.txt"), "utf8")}`,
];
writeFileSync(join(vendor, "LICENSES.txt"), lic.join("\n\n------------------------------------------------------------\n\n"));

// 4. Icons: a QR-like mark on a blue rounded square.
const { create } = await import(join(vendor, "qrcode.mjs"));
const mark = create("QR FILE DROP", { errorCorrectionLevel: "L", version: 1 }).modules;
function icon(size, file, { maskable = false } = {}) {
  const png = new PNG({ width: size, height: size });
  const bg = [0x1f, 0x4f, 0xd8], fg = [255, 255, 255];
  const radius = maskable ? 0 : size * 0.2;
  const pad = size * (maskable ? 0.26 : 0.18);
  const cell = (size - 2 * pad) / mark.size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    // rounded-corner alpha
    const cx = Math.max(radius - x, 0, x - (size - 1 - radius)), cy = Math.max(radius - y, 0, y - (size - 1 - radius));
    const inside = radius === 0 || cx * cx + cy * cy <= radius * radius;
    const mx = Math.floor((x - pad) / cell), my = Math.floor((y - pad) / cell);
    const on = mx >= 0 && my >= 0 && mx < mark.size && my < mark.size && mark.get(my, mx);
    const c = on ? fg : bg;
    png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = inside ? 255 : 0;
  }
  writeFileSync(join(site, "icons", file), PNG.sync.write(png));
}
icon(192, "icon-192.png"); icon(512, "icon-512.png"); icon(512, "maskable-512.png", { maskable: true });
icon(180, "apple-touch-icon.png", { maskable: true }); icon(32, "favicon-32.png");

// 5. Service worker with the full precache list.
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(site).map((p) => relative(site, p)).filter((p) => p !== "sw.js" && !p.startsWith(".") && p !== "CNAME" && p !== "precache.json").sort();
const h = createHash("sha256");
for (const f of files) h.update(f).update(readFileSync(join(site, f)));
const version = h.digest("hex").slice(0, 12);
const assets = ["./", ...files.map((f) => "./" + f)];
const tpl = readFileSync(join(root, "scripts/sw.template.js"), "utf8");
writeFileSync(join(site, "sw.js"), tpl.replace("__VERSION__", version).replace("__ASSETS__", JSON.stringify(assets, null, 2)));
console.log(`built: ${files.length} files, cache version ${version}`);

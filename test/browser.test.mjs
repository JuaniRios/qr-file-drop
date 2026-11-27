// Headless Chromium end-to-end test:
//  1. Sender page (other origins blocked): pick a file, capture the real QR frames.
//  2. Turn those frames into a fake camera video (Y4M).
//  3. Receiver browser: load once online, wait for "Ready to work offline",
//     go offline, reload, start the (fake) camera, receive, save, compare bytes.
// Needs Chromium: set CHROME=/path/to/chrome (default: nix chromium in PATH).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { randomBytes } from "node:crypto";
import { writeFileSync, openSync, writeSync, closeSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { serve } from "../scripts/serve.mjs";

const CHROME = process.env.CHROME || execSync("command -v chromium || command -v google-chrome || true").toString().trim();
const work = mkdtempSync(join(process.env.TEST_TMP || tmpdir(), "qfd-"));
let server, base, origin;
const FILE = new Uint8Array(randomBytes(24 * 1024));

before(async () => { server = await serve(0); origin = `http://127.0.0.1:${server.address().port}`; base = origin + "/"; });
after(() => server.close());

function guard(ctx) {
  const foreign = [], errors = [];
  ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== origin && u.protocol !== "data:" && u.protocol !== "blob:") { foreign.push(u.href); return route.abort(); }
    return route.continue();
  });
  const watch = (page) => {
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
  };
  return { foreign, errors, watch };
}

let frames = []; // PNG buffers

test("sender: shows QR frames, no other origins, no console errors", { skip: !CHROME && "no chromium" }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const g = guard(ctx);
  const page = await ctx.newPage(); g.watch(page);
  await page.goto(base);
  await page.waitForSelector("#offlineBadge:not([hidden])", { timeout: 20000 });
  await page.click("#goSend");
  await page.setInputFiles("#fileInput", { name: "holiday photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from(FILE) });
  await page.waitForFunction(() => document.getElementById("qr").width > 100);
  assert.match(await page.textContent("#sendName"), /holiday photo\.jpg/);
  const K = await page.evaluate(() => { window.__qfd.stopSending(); return window.__qfd.sender.enc.K; });
  for (let i = 0; i < K + 30; i++) {
    const url = await page.evaluate(() => { window.__qfd.renderFrame(); return document.getElementById("qr").toDataURL("image/png"); });
    frames.push(Buffer.from(url.split(",")[1], "base64"));
  }
  // Fullscreen button does not throw
  await page.click("#fsBtn"); await page.waitForTimeout(300);
  await page.click("#exitFs");
  console.log(`  K=${K}, captured ${frames.length} frames`);
  assert.deepEqual(g.foreign, [], "requests to other origins");
  assert.deepEqual(g.errors, [], "console errors");
  await browser.close();
});

function writeY4m(path, pngs, size = 720, repeat = 3, dropEvery = 4) {
  const fd = openSync(path, "w");
  writeSync(fd, `YUV4MPEG2 W${size} H${size} F30:1 Ip A1:1 C420jpeg\n`);
  const chroma = Buffer.alloc((size / 2) * (size / 2) * 2, 128);
  let n = 0;
  pngs.forEach((buf, idx) => {
    if (idx % dropEvery === dropEvery - 1) return; // simulate missed codes
    const png = PNG.sync.read(buf);
    const y = Buffer.alloc(size * size, 200); // light grey surroundings
    const target = Math.floor(size * 0.8), off = Math.floor((size - target) / 2);
    for (let ty = 0; ty < target; ty++) for (let tx = 0; tx < target; tx++) {
      const sx = Math.floor((tx * png.width) / target), sy = Math.floor((ty * png.height) / target);
      const v = png.data[(sy * png.width + sx) * 4];
      y[(ty + off) * size + tx + off] = v < 128 ? 30 : 235;
    }
    for (let r = 0; r < repeat; r++) { writeSync(fd, "FRAME\n"); writeSync(fd, y); writeSync(fd, chroma); n++; }
  });
  closeSync(fd);
  return n;
}

test("receiver: offline reload, fake camera, verified save", { skip: !CHROME && "no chromium" }, async () => {
  assert.ok(frames.length > 0, "sender test must run first");
  const y4m = join(work, "camera.y4m");
  const n = writeY4m(y4m, frames);
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${y4m}`],
  });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ["camera"], acceptDownloads: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Mobile Safari/537.36" });
  const g = guard(ctx);
  let page = await ctx.newPage(); g.watch(page);
  await page.goto(base);
  await page.waitForSelector("#offlineBadge:not([hidden])", { timeout: 20000 });
  // phone layout: Receive comes first
  const order = await page.evaluate(() => { const r = document.getElementById("goReceive").getBoundingClientRect(), s = document.getElementById("goSend").getBoundingClientRect(); return r.top < s.top; });
  assert.ok(order, "Receive button should be first on a phone");

  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector("#goReceive");
  await page.waitForSelector("#offlineBadge:not([hidden])", { timeout: 10000 });
  const t0 = Date.now();
  await page.click("#goReceive");
  await page.click("#startCam");
  await page.waitForSelector("#rxDone:not([hidden])", { timeout: 60000 });
  const secs = (Date.now() - t0) / 1000;
  assert.match(await page.textContent("#doneName"), /holiday photo\.jpg/);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#saveBtn")]);
  const saved = join(work, "saved.bin");
  await dl.saveAs(saved);
  const { readFileSync } = await import("node:fs");
  assert.deepEqual(readFileSync(saved), Buffer.from(FILE));
  assert.equal(dl.suggestedFilename(), "holiday photo.jpg");
  console.log(`  fake camera: ${n} video frames; received + verified ${FILE.length} B offline in ${secs.toFixed(1)} s`);
  assert.deepEqual(g.foreign, [], "requests to other origins");
  assert.deepEqual(g.errors, [], "console errors");
  await browser.close();
});

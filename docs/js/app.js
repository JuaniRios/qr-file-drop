import { create as createQR } from "../vendor/qrcode.mjs";
import { buildContainer, openContainer, Encoder, Decoder, parseFrame, randomTransferId } from "./protocol.js";
import { PRESETS, DEFAULT_PRESET, drawToCanvas } from "./qrframe.js";

const $ = (id) => document.getElementById(id);
const MAX_FILE = 5 * 1024 * 1024;

const ua = navigator.userAgent;
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(ua);
const isPhone = isIOS || isAndroid || matchMedia("(pointer: coarse) and (max-width: 900px)").matches;

function fmtSize(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtTime(s) {
  s = Math.max(1, Math.round(s));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------- navigation
const views = ["home", "send", "receive"];
function show(view, push = true) {
  for (const v of views) $(v).hidden = v !== view;
  $("homeLink").hidden = view === "home";
  if (view !== "send") stopSending();
  if (view !== "receive") stopCamera();
  if (push && location.hash !== "#" + view) history.pushState(null, "", view === "home" ? location.pathname : "#" + view);
  window.scrollTo(0, 0);
}
window.addEventListener("popstate", () => show((location.hash || "#home").slice(1).replace(/^$/, "home"), false));
$("goSend").onclick = () => show("send");
$("goReceive").onclick = () => show("receive");
$("homeLink").onclick = () => show("home");

if (isPhone) {
  $("choices").classList.add("phone");
  $("goReceive").classList.add("preferred");
} else {
  $("goSend").classList.add("preferred");
}

// ---------------------------------------------------------------- errors
let retryFn = null;
function showError(title, html, retry) {
  $("errTitle").textContent = title;
  $("errBody").innerHTML = html;
  retryFn = retry || null;
  $("errRetry").hidden = !retry;
  $("error").hidden = false;
}
function hideError() { $("error").hidden = true; }
$("errClose").onclick = hideError;
$("errRetry").onclick = () => { hideError(); retryFn && retryFn(); };

// ---------------------------------------------------------------- wake lock
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not important */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (sender.running || camera.running)) keepAwake(true);
});

// ================================================================= SENDER
const sender = { file: null, container: null, enc: null, index: 0, running: false, paused: false, timer: 0, settings: null, version: 0 };

function loadSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem("qfd-send") || "null"); } catch { /* private mode */ }
  const p = PRESETS[(s && s.preset) || DEFAULT_PRESET] || PRESETS[DEFAULT_PRESET];
  return {
    preset: (s && s.preset) || DEFAULT_PRESET,
    blockSize: (s && s.blockSize) || p.blockSize,
    fps: (s && s.fps) || p.fps,
    ecc: (s && s.ecc) || p.ecc,
  };
}
function saveSettings() { try { localStorage.setItem("qfd-send", JSON.stringify(sender.settings)); } catch { /* ignore */ } }
sender.settings = loadSettings();

const presetSel = $("preset");
for (const [k, p] of Object.entries(PRESETS)) presetSel.add(new Option(p.label, k));
presetSel.add(new Option("Custom", "custom"));
function syncAdvanced() {
  const s = sender.settings;
  presetSel.value = s.preset;
  $("advBlock").value = s.blockSize; $("advFps").value = s.fps; $("advEcc").value = s.ecc;
}
syncAdvanced();
presetSel.onchange = () => {
  const p = PRESETS[presetSel.value];
  if (p) sender.settings = { preset: presetSel.value, blockSize: p.blockSize, fps: p.fps, ecc: p.ecc };
  else sender.settings.preset = "custom";
  saveSettings(); syncAdvanced(); applySettings();
};
for (const id of ["advBlock", "advFps", "advEcc"]) {
  $(id).onchange = () => {
    const bs = Math.round(Math.min(1600, Math.max(64, Number($("advBlock").value) || 600)) / 4) * 4;
    const fps = Math.min(30, Math.max(1, Number($("advFps").value) || 10));
    sender.settings = { preset: "custom", blockSize: bs, fps, ecc: $("advEcc").value };
    saveSettings(); syncAdvanced(); applySettings();
  };
}
function applySettings() {
  if (!sender.container) return;
  const s = sender.settings;
  if (!sender.enc || sender.enc.blockSize !== s.blockSize || sender.ecc !== s.ecc) startEncoding();
  else restartTimer();
}

// File picking
const drop = $("drop");
$("fileInput").onchange = (e) => { const f = e.target.files[0]; if (f) pickFile(f); e.target.value = ""; };
for (const ev of ["dragenter", "dragover"]) {
  document.addEventListener(ev, (e) => { e.preventDefault(); if (!$("send").hidden) drop.classList.add("over"); });
}
document.addEventListener("dragleave", (e) => { if (e.target === drop || !e.relatedTarget) drop.classList.remove("over"); });
document.addEventListener("drop", (e) => {
  e.preventDefault(); drop.classList.remove("over");
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  if ($("send").hidden) show("send");
  pickFile(f);
});

async function pickFile(file) {
  hideError();
  if (file.size > MAX_FILE) {
    showError("This file is too big", `<p><b>${escapeHtml(file.name)}</b> is ${fmtSize(file.size)}. This tool can send files up to ${fmtSize(MAX_FILE)}, because the camera is slow.</p><p>Try a smaller file, or make the photo or video smaller first.</p>`);
    return;
  }
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch {
    showError("Could not open this file", "<p>The file could not be read. If it is in iCloud or a cloud folder, download it to your computer first, then try again.</p>");
    return;
  }
  sender.file = file;
  sender.container = await buildContainer(bytes, file.name, file.type);
  $("sendName").textContent = file.name;
  $("sendSize").textContent = `(${fmtSize(file.size)})`;
  $("pick").hidden = true; $("showing").hidden = false;
  startEncoding();
}

function startEncoding() {
  const s = sender.settings;
  sender.enc = new Encoder(sender.container, s.blockSize, randomTransferId());
  sender.ecc = s.ecc;
  sender.index = 0;
  sender.version = 0;
  sender.paused = false; $("pauseBtn").textContent = "Pause";
  sender.running = true;
  keepAwake(true);
  renderFrame();
  restartTimer();
}
function restartTimer() {
  clearInterval(sender.timer);
  if (!sender.running || sender.paused) return;
  sender.timer = setInterval(renderFrame, 1000 / sender.settings.fps);
  const s = sender.settings, K = sender.enc.K;
  // Rough guess: a phone catches ~75% of codes.
  const secs = (K + 2) / (s.fps * 0.75);
  $("sendStats").textContent = `Expected time: about ${fmtTime(secs)} once the phone sees the code.`;
}
function qrMaxPx() {
  const wrap = $("qrwrap");
  const dpr = window.devicePixelRatio || 1;
  if (isFullscreen()) return Math.floor(Math.min(window.innerWidth, window.innerHeight) * dpr);
  const w = wrap.clientWidth - 24;
  const h = window.innerHeight - 260;
  return Math.floor(Math.max(240, Math.min(w, h, 900)) * dpr);
}
function renderFrame() {
  if (!sender.enc) return;
  const frame = sender.enc.frame(sender.index++);
  const qr = createQR([{ data: frame, mode: "byte" }], { errorCorrectionLevel: sender.ecc });
  sender.version = qr.version;
  const canvas = $("qr");
  drawToCanvas(canvas, qr.modules, qrMaxPx());
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = canvas.width / dpr + "px";
}
function stopSending() {
  clearInterval(sender.timer);
  sender.running = false;
  if (!camera.running) keepAwake(false);
}
$("pauseBtn").onclick = () => {
  sender.paused = !sender.paused;
  $("pauseBtn").textContent = sender.paused ? "Resume" : "Pause";
  restartTimer();
};
$("anotherBtn").onclick = () => {
  stopSending();
  sender.enc = null; sender.container = null;
  $("pick").hidden = false; $("showing").hidden = true;
};

// Full screen (falls back to a fixed overlay where the API is missing, e.g. iPhone)
function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement || $("qrwrap").classList.contains("fs")); }
$("fsBtn").onclick = async () => {
  const el = $("qrwrap");
  try {
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else throw new Error("no fullscreen");
  } catch { el.classList.add("fs"); }
  $("exitFs").hidden = false;
  setTimeout(renderFrame, 150);
};
$("exitFs").onclick = async () => {
  $("qrwrap").classList.remove("fs");
  try { if (document.fullscreenElement) await document.exitFullscreen(); else if (document.webkitFullscreenElement) document.webkitExitFullscreen(); } catch { /* ignore */ }
  $("exitFs").hidden = true;
  setTimeout(renderFrame, 150);
};
const onFsChange = () => { if (!document.fullscreenElement && !document.webkitFullscreenElement && !$("qrwrap").classList.contains("fs")) $("exitFs").hidden = true; setTimeout(renderFrame, 150); };
document.addEventListener("fullscreenchange", onFsChange);
document.addEventListener("webkitfullscreenchange", onFsChange);
window.addEventListener("resize", () => { if (sender.running) renderFrame(); });

// ================================================================= RECEIVER
const camera = { running: false, stream: null, workers: [], busy: 0, seq: 0, lastHit: 0, startedAt: 0, rvfc: false };
const rx = { decoder: null, transferId: 0, history: [], done: false, result: null };
const grab = document.createElement("canvas");
const grabCtx = grab.getContext("2d", { willReadFrequently: true });

function cameraHelpHtml(kind) {
  const ios = `<p><b>iPhone / iPad (Safari):</b></p><ol><li>Tap <b>aA</b> (or the page icon) at the left of the address bar.</li><li>Tap <b>Website Settings</b>, set <b>Camera</b> to <b>Allow</b>.</li><li>Or open the <b>Settings</b> app → <b>Apps</b> → <b>Safari</b> → <b>Camera</b> → <b>Allow</b>.</li><li>Come back and tap <b>Try again</b>.</li></ol>`;
  const android = `<p><b>Android (Chrome):</b></p><ol><li>Tap the icon at the left of the address bar (🔒 or ⚙︎).</li><li>Tap <b>Permissions</b> (or <b>Site settings</b>) → <b>Camera</b> → <b>Allow</b>.</li><li>If it still fails: phone <b>Settings</b> → <b>Apps</b> → <b>Chrome</b> → <b>Permissions</b> → <b>Camera</b> → <b>Allow</b>.</li><li>Come back and tap <b>Try again</b>.</li></ol>`;
  if (kind === "denied") return `<p>The page needs the camera to read the code, but permission was blocked.</p>${isAndroid ? android : isIOS ? ios : ios + android}`;
  return "";
}

$("startCam").onclick = startCamera;
$("stopCam").onclick = () => { stopCamera(); $("camLive").hidden = true; $("camStart").hidden = false; };

async function startCamera() {
  hideError();
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError("The camera is not available here",
      `<p>This browser does not let the page use the camera.</p><ul><li>On iPhone, open this page in <b>Safari</b>.</li><li>On Android, open it in <b>Chrome</b>.</li><li>If you opened the link inside another app (for example WhatsApp or Instagram), choose <b>Open in browser</b> first.</li></ul>`,
      startCamera);
    return;
  }
  const tries = [
    { video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false },
    { video: { facingMode: { ideal: "environment" } }, audio: false },
    { video: true, audio: false },
  ];
  let stream = null, lastErr = null;
  for (const c of tries) {
    try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) {
      lastErr = e;
      if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) break;
    }
  }
  if (!stream) { cameraError(lastErr); return; }
  camera.stream = stream;
  const video = $("video");
  video.srcObject = stream;
  try { await video.play(); } catch { /* autoplay with muted+playsinline normally works */ }
  // Try continuous focus where supported (Android Chrome).
  try {
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes("continuous")) await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
  } catch { /* optional */ }
  camera.running = true;
  camera.startedAt = performance.now();
  camera.lastHit = 0;
  $("camStart").hidden = true; $("camLive").hidden = false; $("rxDone").hidden = true;
  if (!rx.decoder) setStatus("Point the camera at the code on the computer.");
  keepAwake(true);
  startWorkers();
  camera.rvfc = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
  scheduleGrab();
}

function cameraError(e) {
  const name = e && e.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    showError("Please allow the camera", cameraHelpHtml("denied"), startCamera);
  } else if (name === "NotFoundError" || name === "OverconstrainedError") {
    showError("No camera found", "<p>This device has no camera the page can use. Open this page on your phone instead.</p>", startCamera);
  } else if (name === "NotReadableError" || name === "AbortError") {
    showError("The camera is busy", "<p>Another app is using the camera (for example a video call or the Camera app). Close it, then tap <b>Try again</b>.</p>", startCamera);
  } else {
    showError("The camera did not start", `<p>Something went wrong starting the camera. Close other apps that use the camera, then tap <b>Try again</b>. If it still fails, restart the browser.</p><p class="tiny">${escapeHtml(String((e && e.message) || e || ""))}</p>`, startCamera);
  }
}

function stopCamera() {
  camera.running = false;
  if (camera.stream) { for (const t of camera.stream.getTracks()) t.stop(); camera.stream = null; }
  $("video").srcObject = null;
  for (const w of camera.workers) w.terminate();
  camera.workers = []; camera.busy = 0;
  if (!sender.running) keepAwake(false);
}

function startWorkers() {
  if (camera.workers.length) return;
  const n = (navigator.hardwareConcurrency || 2) >= 4 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const w = new Worker("js/decode-worker.js");
    w.idle = false; // becomes idle on "ready"
    w.onmessage = (e) => onWorkerMessage(w, e.data);
    w.onerror = (e) => { console.warn("decoder worker error", e.message); };
    camera.workers.push(w);
  }
}

function onWorkerMessage(w, msg) {
  if (msg.type === "ready") { w.idle = true; return; }
  if (msg.type === "fatal") {
    showError("The code reader could not start", "<p>Please reload the page and try again. If you are offline, open the page once while online first.</p>", () => location.reload());
    return;
  }
  if (msg.type === "result") {
    w.idle = true;
    if (msg.bytes) onFrameBytes(new Uint8Array(msg.bytes));
  }
}

function scheduleGrab() {
  if (!camera.running) return;
  const video = $("video");
  if (camera.rvfc) video.requestVideoFrameCallback(grabFrame);
  else requestAnimationFrame(grabFrame);
}

function grabFrame() {
  if (!camera.running) return;
  const video = $("video");
  const w = camera.workers.find((x) => x.idle);
  if (w && video.videoWidth) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const side = Math.min(vw, vh);
    const out = Math.min(side, 1080);
    if (grab.width !== out) { grab.width = out; grab.height = out; }
    grabCtx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, out, out);
    const img = grabCtx.getImageData(0, 0, out, out);
    w.idle = false;
    w.postMessage({ id: ++camera.seq, width: out, height: out, buffer: img.data.buffer }, [img.data.buffer]);
  }
  updateHints();
  scheduleGrab();
}

function updateHints() {
  const now = performance.now();
  if (rx.done) return;
  const since = camera.lastHit ? now - camera.lastHit : now - camera.startedAt;
  if (since > 6000) {
    setStatus(camera.lastHit
      ? "Lost the code. Point the camera back at the screen."
      : "Can't see the code yet. Fit the whole code inside the white frame and hold still.");
  }
}

function setStatus(t) { const el = $("rxStatus"); if (el.textContent !== t) el.textContent = t; }

function onFrameBytes(bytes) {
  const f = parseFrame(bytes);
  if (!f) return; // some other QR code
  camera.lastHit = performance.now();
  if (rx.done && f.transferId === rx.transferId) return;
  if (!rx.decoder || f.transferId !== rx.transferId) {
    const isNew = !!rx.decoder;
    rx.decoder = new Decoder(f.transferId, f.totalLength, f.blockSize);
    rx.transferId = f.transferId; rx.history = []; rx.done = false;
    $("rxDone").hidden = true; $("camLive").hidden = false;
    $("rxFile").textContent = `Receiving about ${fmtSize(f.totalLength)}${isNew ? " (a new file was started on the computer)" : ""}`;
  }
  const d = rx.decoder;
  const before = d.rank;
  d.add(f);
  const now = performance.now();
  if (d.rank > before) rx.history.push(now);
  while (rx.history.length && now - rx.history[0] > 8000) rx.history.shift();
  const pct = Math.floor((d.rank / d.K) * 100);
  $("rxBar").style.width = pct + "%";
  $("rxPct").textContent = pct + "%";
  const rate = rx.history.length >= 3 ? (rx.history.length - 1) / ((now - rx.history[0]) / 1000) : 0;
  $("rxEta").textContent = rate > 0 ? `about ${fmtTime((d.K - d.rank) / rate)} left` : "";
  setStatus("Reading… hold still.");
  if (d.done) finishReceive();
}

async function finishReceive() {
  rx.done = true;
  setStatus("Checking the file…");
  $("rxEta").textContent = "";
  let out;
  try {
    out = await openContainer(await rx.decoder.result());
  } catch (e) {
    console.warn("verify failed", e);
    rx.decoder = null; rx.done = false;
    setStatus("The file did not check out. Starting over — keep pointing at the code.");
    return;
  }
  stopCamera();
  rx.result = out;
  $("camLive").hidden = true; $("camStart").hidden = true; $("rxDone").hidden = false;
  $("doneName").textContent = out.name;
  $("doneSize").textContent = `(${fmtSize(out.file.length)})`;
  const canShareFile = canShare(out);
  $("saveHint").textContent = isIOS && canShareFile
    ? "Then choose “Save to Files” (or “Save Image” for photos)."
    : "It goes to your Downloads folder.";
  $("altSave").hidden = !(canShareFile);
  if (navigator.vibrate) navigator.vibrate(200);
}

function makeFile(out) {
  const type = out.mime || "application/octet-stream";
  try { return new File([out.file], out.name || "file", { type }); } catch { return null; }
}
function canShare(out) {
  const f = makeFile(out);
  try { return !!(f && navigator.canShare && navigator.share && navigator.canShare({ files: [f] })); } catch { return false; }
}
function download(out) {
  const blob = new Blob([out.file], { type: out.mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = out.name || "file";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function share(out) {
  try { await navigator.share({ files: [makeFile(out)], title: out.name }); return true; } catch (e) {
    if (e && e.name === "AbortError") return true; // user closed the sheet
    return false;
  }
}
$("saveBtn").onclick = async () => {
  const out = rx.result; if (!out) return;
  if (isIOS && canShare(out)) { if (await share(out)) return; }
  download(out);
};
$("altSave").onclick = async (e) => {
  e.preventDefault();
  const out = rx.result; if (!out) return;
  if (isIOS) download(out); else if (!(await share(out))) download(out);
};
$("againBtn").onclick = () => {
  rx.decoder = null; rx.done = false; rx.result = null;
  $("rxBar").style.width = "0%"; $("rxPct").textContent = "0%"; $("rxEta").textContent = ""; $("rxFile").textContent = "";
  $("rxDone").hidden = true; $("camStart").hidden = false;
  startCamera();
};

function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

// ================================================================= OFFLINE
async function setupOffline() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("sw.js");
    const reg = await navigator.serviceWorker.ready;
    const ask = () => reg.active && reg.active.postMessage("cache-status");
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "cache-status") {
        $("offlineBadge").hidden = !e.data.complete;
        if (!e.data.complete) setTimeout(ask, 1500);
      }
    });
    navigator.serviceWorker.addEventListener("controllerchange", ask);
    ask();
  } catch (e) { console.warn("offline setup failed", e); }
}
setupOffline();

// Start on the right screen.
show((location.hash || "#home").slice(1) || "home", false);
if (!views.includes((location.hash || "#home").slice(1))) show("home", false);

// Test hook (used by the automated browser test only).
window.__qfd = { sender, rx, onFrameBytes, renderFrame, stopSending };

// QR sizing presets and drawing helpers shared by the page and the tests.

// blockSize must be a multiple of 4. The 17-byte frame header is added on top.
export const PRESETS = {
  steady: { label: "Slower, very reliable", blockSize: 380, ecc: "M", fps: 6 },
  normal: { label: "Normal (recommended)", blockSize: 600, ecc: "L", fps: 10 },
  fast:   { label: "Faster, needs a good camera", blockSize: 920, ecc: "L", fps: 14 },
};
export const DEFAULT_PRESET = "normal";
export const QUIET = 4; // quiet-zone modules around the code

// Black-on-white RGBA buffer with `scale` pixels per module.
export function renderToRgba(modules, scale) {
  const n = modules.size, side = (n + 2 * QUIET) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!modules.get(y, x)) continue;
    for (let dy = 0; dy < scale; dy++) {
      let i = (((y + QUIET) * scale + dy) * side + (x + QUIET) * scale) * 4;
      for (let dx = 0; dx < scale; dx++, i += 4) { data[i] = data[i + 1] = data[i + 2] = 0; }
    }
  }
  return { data, width: side, height: side };
}

// Draws onto a canvas whose pixel size is a whole multiple of the module count.
export function drawToCanvas(canvas, modules, maxPx) {
  const n = modules.size + 2 * QUIET;
  const scale = Math.max(1, Math.floor(maxPx / n));
  const side = n * scale;
  if (canvas.width !== side) { canvas.width = side; canvas.height = side; }
  const g = canvas.getContext("2d", { alpha: false });
  g.fillStyle = "#fff"; g.fillRect(0, 0, side, side);
  g.fillStyle = "#000";
  const m = modules.size;
  for (let y = 0; y < m; y++) {
    let run = -1;
    for (let x = 0; x <= m; x++) {
      const on = x < m && modules.get(y, x);
      if (on && run < 0) run = x;
      if (!on && run >= 0) { g.fillRect((run + QUIET) * scale, (y + QUIET) * scale, (x - run) * scale, scale); run = -1; }
    }
  }
  return side;
}

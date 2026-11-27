import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { buildContainer, openContainer, Encoder, Decoder, parseFrame } from "../docs/js/protocol.js";

const BLOCK = 600;
const SIZES = [0, 1, 1024, 100 * 1024, 1024 * 1024];

function shuffle(a, seed = 12345) {
  let s = seed;
  const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

async function run(size, { start = 0, drop = 0.3, seed = 1 } = {}) {
  const file = new Uint8Array(randomBytes(size));
  const container = await buildContainer(file, `test-${size}.bin`, "application/octet-stream");
  const tid = 0x1234567 + size + seed;
  const encd = new Encoder(container, BLOCK, tid);
  const K = encd.K;
  // emit 3K+20 frames, drop `drop` of them, shuffle the rest
  const idx = [];
  let s = seed * 7919;
  for (let i = start; i < start + 3 * K + 20; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    if (s / 4294967296 >= drop) idx.push(i);
  }
  shuffle(idx, seed);
  let decoder = null, used = 0;
  for (const i of idx) {
    const f = parseFrame(encd.frame(i));
    assert.ok(f);
    decoder ??= new Decoder(f.transferId, f.totalLength, f.blockSize);
    decoder.add(f); used++;
    if (decoder.done) break;
  }
  assert.ok(decoder.done, `size ${size}: not decoded with ${used} frames, K=${K}`);
  const out = await openContainer(await decoder.result(0));
  assert.equal(out.name, `test-${size}.bin`);
  assert.deepEqual(Buffer.from(out.file), Buffer.from(file));
  assert.equal(Buffer.from(out.hash).toString("hex"), createHash("sha256").update(file).digest("hex"));
  return { K, used, overhead: used / K - 1, extra: used - K };
}

for (const size of SIZES) {
  test(`roundtrip ${size} B, 30% dropped + shuffled`, async () => {
    const rows = [];
    for (let seed = 1; seed <= 5; seed++) rows.push(await run(size, { seed }));
    const avg = rows.reduce((a, r) => a + r.overhead, 0) / rows.length;
    const max = Math.max(...rows.map(r => r.overhead));
    const avgExtra = rows.reduce((a, r) => a + r.extra, 0) / rows.length;
    console.log(`  size=${size} K=${rows[0].K}: frames needed = K + ${avgExtra.toFixed(1)} avg (overhead avg ${(avg * 100).toFixed(2)}%, max ${(max * 100).toFixed(2)}%)`);
  });
}

test("late join (pure fountain frames only), 100 KB and 1 MB", async () => {
  for (const [seed, sz] of [[1, 102400], [2, 102400], [3, 1048576]]) {
    const r = await run(sz, { start: 100000, seed });
    console.log(`  late-join K=${r.K} overhead=${(r.overhead * 100).toFixed(1)}% (+${r.extra} frames)`);
  }
});

test("corrupted payload is rejected by SHA-256", async () => {
  const file = new Uint8Array(randomBytes(5000));
  const c = await buildContainer(file, "x", "text/plain");
  c[c.length - 1] ^= 1;
  await assert.rejects(openContainer(c), /checksum/);
});

test("new transfer id is distinguishable", async () => {
  const c = await buildContainer(new Uint8Array(10), "a", "");
  const a = parseFrame(new Encoder(c, BLOCK, 1).frame(0));
  const b = parseFrame(new Encoder(c, BLOCK, 2).frame(0));
  assert.notEqual(a.transferId, b.transferId);
  assert.equal(parseFrame(new Uint8Array([1, 2, 3])), null);
});

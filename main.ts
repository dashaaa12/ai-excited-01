// "The Leap Beyond the Rings" — a colossal golden koi bursting upward through
// glowing concentric rings above a tiny vermilion torii gate.
// Everything is drawn procedurally with the Node standard library only.
// Deterministic: a fixed-seed PRNG drives every scatter; no clock, no network.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x5eedc01);

// ---------------------------------------------------------------------------
// Frame buffer (supersampled 2x, downscaled before encoding)
// ---------------------------------------------------------------------------
const SS = 2048; // render size
const OUT = 1024; // final size
const buf = new Float32Array(SS * SS * 3);

type RGB = [number, number, number];

function blendPx(x: number, y: number, c: RGB, a: number): void {
  if (x < 0 || y < 0 || x >= SS || y >= SS || a <= 0) return;
  const i = (y * SS + x) * 3;
  const ia = 1 - a;
  buf[i] = buf[i] * ia + c[0] * a;
  buf[i + 1] = buf[i + 1] * ia + c[1] * a;
  buf[i + 2] = buf[i + 2] * ia + c[2] * a;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function lerpC(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------

/** Filled disc with an optional feathered rim (feather = fraction of radius). */
function disc(cx: number, cy: number, r: number, c: RGB, a: number, feather = 0): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(SS - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(SS - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      let alpha = a;
      if (feather > 0) {
        const t = clamp((r - d) / (r * feather), 0, 1);
        alpha = a * t * t * (3 - 2 * t);
      }
      blendPx(x, y, c, alpha);
    }
  }
}

/** Radial glow: bright core fading to nothing at radius r. */
function glow(cx: number, cy: number, r: number, c: RGB, peak: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(SS - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(SS - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d >= 1) continue;
      const f = 1 - d;
      blendPx(x, y, c, peak * f * f);
    }
  }
}

/** Filled ellipse, optionally rotated (radians). */
function ellipse(
  cx: number, cy: number, rx: number, ry: number, rot: number,
  c: RGB, a: number, feather = 0.08,
): void {
  const R = Math.max(rx, ry);
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const x0 = Math.max(0, Math.floor(cx - R));
  const x1 = Math.min(SS - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R));
  const y1 = Math.min(SS - 1, Math.ceil(cy + R));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      const q = (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry);
      if (q > 1) continue;
      let alpha = a;
      if (feather > 0) alpha = a * clamp((1 - q) / feather, 0, 1);
      blendPx(x, y, c, alpha);
    }
  }
}

type Pt = { x: number; y: number };

/** Filled polygon; colour may be a per-pixel callback for gradients. */
function fillPoly(pts: Pt[], c: RGB | ((x: number, y: number) => RGB), a: number): void {
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(SS - 1, Math.ceil(maxY));
  const n = pts.length;
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      if ((p.y <= y && q.y > y) || (q.y <= y && p.y > y)) {
        xs.push(p.x + ((y - p.y) / (q.y - p.y)) * (q.x - p.x));
      }
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(SS - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) {
        blendPx(x, y, typeof c === "function" ? c(x, y) : c, a);
      }
    }
  }
}

/** Thick polyline with round joints/caps, stamped discs along each segment. */
function strokePath(pts: Pt[], width: number, c: RGB, a: number, feather = 0.25): void {
  const r = width / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const steps = Math.max(1, Math.ceil(len / (r * 0.45)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      disc(lerp(p.x, q.x, t), lerp(p.y, q.y, t), r, c, a, feather);
    }
  }
}

/** Glowing ring: solid core with an exponential halo. */
function ring(cx: number, cy: number, r: number, core: number, c: RGB, peak: number, halo: number): void {
  const R = r + core + halo * 4;
  const x0 = Math.max(0, Math.floor(cx - R));
  const x1 = Math.min(SS - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R));
  const y1 = Math.min(SS - 1, Math.ceil(cy + R));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.abs(Math.hypot(x - cx, y - cy) - r);
      let a: number;
      if (d <= core) a = peak;
      else {
        const t = (d - core) / halo;
        a = peak * Math.exp(-t * t);
      }
      if (a > 0.004) blendPx(x, y, c, a);
    }
  }
}

function quad(p0: Pt, p1: Pt, p2: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}
function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const INDIGO_TOP: RGB = [16, 20, 58];
const INDIGO_MID: RGB = [10, 13, 42];
const INDIGO_BOT: RGB = [5, 7, 24];
const GOLD_HI: RGB = [255, 216, 106];
const GOLD: RGB = [247, 168, 35];
const GOLD_DEEP: RGB = [219, 110, 24];
const GOLD_SHADOW: RGB = [176, 74, 18];
const CREAM: RGB = [255, 240, 205];
const CYAN: RGB = [120, 225, 255];
const CYAN_PALE: RGB = [205, 245, 255];
const VERMILION: RGB = [216, 60, 42];
const VERMILION_DARK: RGB = [150, 34, 24];

// ---------------------------------------------------------------------------
// Background: deep indigo night with a soft nebula and faint stars
// ---------------------------------------------------------------------------
for (let y = 0; y < SS; y++) {
  const t = y / SS;
  const c = t < 0.55
    ? lerpC(INDIGO_TOP, INDIGO_MID, t / 0.55)
    : lerpC(INDIGO_MID, INDIGO_BOT, (t - 0.55) / 0.45);
  for (let x = 0; x < SS; x++) {
    const i = (y * SS + x) * 3;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
  }
}
// Nebula washes (very low alpha, indigo/violet family only)
glow(420, 360, 700, [38, 44, 110], 0.16);
glow(1750, 1500, 800, [30, 36, 96], 0.14);
glow(1150, 760, 900, [24, 60, 110], 0.18);

// Stars
for (let i = 0; i < 170; i++) {
  const x = rand() * SS, y = rand() * SS;
  const r = 1 + rand() * 2.6;
  const a = 0.10 + rand() * 0.30;
  disc(x, y, r, [200, 215, 255], a, 0.6);
}

// ---------------------------------------------------------------------------
// The rings — concentric, centred where the koi bursts through
// ---------------------------------------------------------------------------
const RC = { x: 1150, y: 740 };
const RING_RADII = [238, 368, 498];
glow(RC.x, RC.y, 760, CYAN, 0.10);
ring(RC.x, RC.y, RING_RADII[2], 13, CYAN, 0.55, 26);
ring(RC.x, RC.y, RING_RADII[1], 16, CYAN_PALE, 0.75, 30);
ring(RC.x, RC.y, RING_RADII[0], 13, CYAN, 0.6, 24);

// ---------------------------------------------------------------------------
// The koi — spine is a cubic bezier sweeping lower-left to upper-right
// ---------------------------------------------------------------------------
const SP0 = { x: 300, y: 1700 };
const SP1 = { x: 430, y: 1080 };
const SP2 = { x: 1120, y: 860 };
const SP3 = { x: 1580, y: 400 };
const SEG = 72;
const spine: Pt[] = [];
for (let i = 0; i <= SEG; i++) spine.push(cubic(SP0, SP1, SP2, SP3, i / SEG));

function spineAt(t: number): Pt {
  return cubic(SP0, SP1, SP2, SP3, t);
}
function tangentAt(t: number): Pt {
  const e = 0.004;
  const a = spineAt(Math.max(0, t - e));
  const b = spineAt(Math.min(1, t + e));
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  return { x: dx / l, y: dy / l };
}
/** Unit normal pointing to the belly side (downward on screen). */
function bellyNormal(t: number): Pt {
  const tg = tangentAt(t);
  let nx = -tg.y, ny = tg.x;
  if (ny < 0) { nx = -nx; ny = -ny; }
  return { x: nx, y: ny };
}
/** Half-width of the body at spine parameter t (keyframed, smoothstepped):
 *  slim tail base, deep mid-body, and a blunt rounded head — never a point. */
const WIDTH_KEYS: [number, number][] = [
  [0, 34], [0.15, 80], [0.4, 150], [0.62, 174], [0.8, 150], [0.92, 108], [1, 58],
];
function halfW(t: number): number {
  for (let i = 0; i + 1 < WIDTH_KEYS.length; i++) {
    const [t0, w0] = WIDTH_KEYS[i];
    const [t1, w1] = WIDTH_KEYS[i + 1];
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0);
      return lerp(w0, w1, u * u * (3 - 2 * u));
    }
  }
  return WIDTH_KEYS[WIDTH_KEYS.length - 1][1];
}

// Faint golden aura hugging the body path
{
  const aura: Pt[] = [];
  for (let i = 0; i <= SEG; i += 2) aura.push(spine[i]);
  strokePath(aura, 430, GOLD, 0.05, 0.9);
}

// --- Tail fin: a flowing fan trailing behind the tail base -----------------
{
  const base = spineAt(0.015);
  const tg = tangentAt(0.015);
  const back = { x: -tg.x, y: -tg.y };
  const bn = bellyNormal(0.015);
  const tipC = { x: base.x + back.x * 330 - bn.x * 40, y: base.y + back.y * 330 - bn.y * 40 };
  const tipU = { x: tipC.x + bn.x * 210, y: tipC.y + bn.y * 210 };
  const tipD = { x: tipC.x - bn.x * 230, y: tipC.y - bn.y * 230 };
  const fin: Pt[] = [
    { x: base.x + bn.x * 30, y: base.y + bn.y * 30 },
    quad(base, { x: base.x + back.x * 190 + bn.x * 130, y: base.y + back.y * 190 + bn.y * 130 }, tipU, 0.5),
    tipU, tipC, tipD,
    quad(tipD, { x: base.x + back.x * 200 - bn.x * 140, y: base.y + back.y * 200 - bn.y * 140 }, base, 0.5),
    { x: base.x - bn.x * 30, y: base.y - bn.y * 30 },
  ];
  fillPoly(fin, GOLD, 0.42);
  fillPoly(fin, GOLD_DEEP, 0.22);
  // fin rays
  for (const s of [-0.75, -0.38, 0, 0.38, 0.75]) {
    const tip = { x: tipC.x + bn.x * s * 215, y: tipC.y + bn.y * s * 215 };
    strokePath([base, quad(base, { x: base.x + back.x * 200 + bn.x * s * 120, y: base.y + back.y * 200 + bn.y * s * 120 }, tip, 0.5), tip], 7, GOLD_HI, 0.28, 0.5);
  }
}

// --- Dorsal fin + far-side pectoral, drawn UNDER the body so their bases
// tuck beneath the silhouette and only the flowing parts show. -------------
{
  const pts: Pt[] = [];
  const back: Pt[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = 0.30 + (i / 24) * 0.42;
    const p = spineAt(t);
    const bn = bellyNormal(t);
    const w = halfW(t);
    pts.push({ x: p.x - bn.x * w * 0.8, y: p.y - bn.y * w * 0.8 });
    const lift = (52 + 20 * Math.sin(i * 0.55 + 1.2)) * Math.sin(Math.PI * (i / 24));
    back.push({ x: p.x - bn.x * (w + lift), y: p.y - bn.y * (w + lift) });
  }
  fillPoly([...pts, ...back.reverse()], GOLD_DEEP, 0.5);
}
{
  // far-side pectoral peeking out behind the back line near the head:
  // a small rounded fan, only its tip clears the silhouette
  const t = 0.84;
  const p = spineAt(t);
  const bn = bellyNormal(t);
  const tg = tangentAt(t);
  const w = halfW(t);
  const rootF = { x: p.x - bn.x * w * 0.35 + tg.x * 26, y: p.y - bn.y * w * 0.35 + tg.y * 26 };
  const rootB = { x: rootF.x - tg.x * 62, y: rootF.y - tg.y * 62 };
  const tip = {
    x: rootF.x - bn.x * (w + 74) - tg.x * 78,
    y: rootF.y - bn.y * (w + 74) - tg.y * 78,
  };
  const fan: Pt[] = [];
  for (let i = 0; i <= 8; i++) {
    fan.push(quad(rootF, { x: rootF.x - bn.x * (w + 66) + tg.x * 30, y: rootF.y - bn.y * (w + 66) + tg.y * 30 }, tip, i / 8));
  }
  for (let i = 1; i <= 8; i++) {
    fan.push(quad(tip, { x: rootB.x - bn.x * (w + 30) - tg.x * 16, y: rootB.y - bn.y * (w + 30) - tg.y * 16 }, rootB, i / 8));
  }
  fillPoly(fan, GOLD_DEEP, 0.45);
}

// --- Body ------------------------------------------------------------------
const outlineTop: Pt[] = [];
const outlineBot: Pt[] = [];
for (let i = 0; i <= SEG; i++) {
  const t = i / SEG;
  const p = spine[i];
  const bn = bellyNormal(t);
  const w = halfW(t);
  outlineTop.push({ x: p.x - bn.x * w, y: p.y - bn.y * w });
  outlineBot.push({ x: p.x + bn.x * w, y: p.y + bn.y * w });
}
const bodyPoly: Pt[] = [...outlineTop, ...outlineBot.reverse()];

// Diagonal light: bright gold toward the head/top, deep amber toward tail.
function bodyColor(x: number, y: number): RGB {
  const t = clamp((x - y * 0.55) / 1500, 0, 1);
  return lerpC(GOLD_DEEP, GOLD_HI, Math.pow(t, 1.2));
}
fillPoly(bodyPoly, bodyColor, 1);

// Dorsal shading (top side) and belly light, following the spine
{
  // Dorsal shade, belly light and spine sheen, stroked segment by segment
  // with widths proportional to the local body width so they taper naturally
  // toward the tail and head instead of running as uniform stripes.
  for (let i = 0; i + 2 <= SEG; i += 2) {
    const tA = i / SEG, tB = (i + 2) / SEG;
    const pA = spine[i], pB = spine[i + 2];
    const bnA = bellyNormal(tA), bnB = bellyNormal(tB);
    const wA = halfW(tA), wB = halfW(tB);
    const wMid = (wA + wB) / 2;
    strokePath(
      [
        { x: pA.x - bnA.x * wA * 0.55, y: pA.y - bnA.y * wA * 0.55 },
        { x: pB.x - bnB.x * wB * 0.55, y: pB.y - bnB.y * wB * 0.55 },
      ],
      wMid * 0.66, GOLD_SHADOW, 0.30, 0.85,
    );
    strokePath(
      [
        { x: pA.x + bnA.x * wA * 0.45, y: pA.y + bnA.y * wA * 0.45 },
        { x: pB.x + bnB.x * wB * 0.45, y: pB.y + bnB.y * wB * 0.45 },
      ],
      wMid * 0.58, CREAM, 0.30, 0.85,
    );
    strokePath(
      [
        { x: pA.x - bnA.x * wA * 0.12, y: pA.y - bnA.y * wA * 0.12 },
        { x: pB.x - bnB.x * wB * 0.12, y: pB.y - bnB.y * wB * 0.12 },
      ],
      wMid * 0.36, [255, 226, 150], 0.32, 0.9,
    );
  }
}

// Scale rows: soft bowed strokes that stop short of the silhouette edges
for (let i = 7; i < SEG - 4; i += 3) {
  const t = i / SEG;
  const p = spine[i];
  const bn = bellyNormal(t);
  const tg = tangentAt(t);
  const w = halfW(t) * 0.8;
  const bow = 36;
  const ra = { x: p.x - bn.x * w, y: p.y - bn.y * w };
  const rm = { x: p.x - tg.x * bow, y: p.y - tg.y * bow };
  const rb = { x: p.x + bn.x * w, y: p.y + bn.y * w };
  const row: Pt[] = [];
  for (let s = 0; s <= 8; s++) row.push(quad(ra, rm, rb, s / 8));
  strokePath(row, 5, GOLD_SHADOW, 0.11, 0.4);
  const rowHi: Pt[] = row.map((q) => ({ x: q.x + tg.x * 7, y: q.y + tg.y * 7 }));
  strokePath(rowHi, 3.5, GOLD_HI, 0.08, 0.4);
}

// Clean dark-amber outline
for (let i = 0; i + 1 < bodyPoly.length; i++) {
  strokePath([bodyPoly[i], bodyPoly[i + 1]], 7, [150, 62, 14], 0.55, 0.35);
}
strokePath([bodyPoly[bodyPoly.length - 1], bodyPoly[0]], 7, [150, 62, 14], 0.55, 0.35);

// --- Near-side pectoral fin: a rounded fan swept back toward the tail ------
function pectoral(t: number): void {
  const p = spineAt(t);
  const bn = bellyNormal(t);
  const tg = tangentAt(t);
  const w = halfW(t);
  const rootF = { x: p.x + bn.x * w * 0.38 + tg.x * 34, y: p.y + bn.y * w * 0.38 + tg.y * 34 };
  const rootB = { x: rootF.x - tg.x * 84, y: rootF.y - tg.y * 84 };
  const tip = {
    x: rootF.x + bn.x * 178 - tg.x * 196,
    y: rootF.y + bn.y * 178 - tg.y * 196,
  };
  const fan: Pt[] = [];
  for (let i = 0; i <= 9; i++) {
    fan.push(quad(rootF, { x: rootF.x + bn.x * 158 + tg.x * 26, y: rootF.y + bn.y * 158 + tg.y * 26 }, tip, i / 9));
  }
  for (let i = 1; i <= 9; i++) {
    fan.push(quad(tip, { x: rootB.x + bn.x * 92 - tg.x * 30, y: rootB.y + bn.y * 92 - tg.y * 30 }, rootB, i / 9));
  }
  fillPoly(fan, GOLD, 0.5);
  fillPoly(fan, GOLD_DEEP, 0.16);
  // two soft rays following the fan
  const rayTip = {
    x: rootF.x + bn.x * 140 - tg.x * 158,
    y: rootF.y + bn.y * 140 - tg.y * 158,
  };
  strokePath([rootF, rayTip], 4.5, GOLD_HI, 0.3, 0.4);
}
pectoral(0.80);

// --- Head details: eye, mouth, barbel --------------------------------------
{
  const hp = spineAt(0.945);
  const bn = bellyNormal(0.945);
  const eye = { x: hp.x - bn.x * 52, y: hp.y - bn.y * 52 };
  disc(eye.x, eye.y, 21, [24, 14, 6], 0.95, 0.25);
  disc(eye.x + 6, eye.y - 7, 7, [255, 250, 235], 0.95, 0.3);
  disc(eye.x, eye.y, 27, GOLD_HI, 0.25, 0.8);
  // mouth: small dark arc at the very tip
  const tip = spineAt(1);
  const tg = tangentAt(1);
  const m0 = { x: tip.x - tg.x * 6 - bn.x * 26, y: tip.y - tg.y * 6 - bn.y * 26 };
  const m1 = { x: tip.x + tg.x * 10, y: tip.y + tg.y * 10 };
  const m2 = { x: tip.x - tg.x * 6 + bn.x * 26, y: tip.y - tg.y * 6 + bn.y * 26 };
  strokePath([m0, m1, m2], 8, [120, 48, 10], 0.7, 0.4);
  // barbel whisker curling from the mouth corner
  const b0 = { x: tip.x - tg.x * 16 + bn.x * 20, y: tip.y - tg.y * 16 + bn.y * 20 };
  const b1 = { x: b0.x + tg.x * 60 + bn.x * 66, y: b0.y + tg.y * 60 + bn.y * 66 };
  const b2 = { x: b1.x + tg.x * 78 - bn.x * 8, y: b1.y + tg.y * 78 - bn.y * 8 };
  const whisker: Pt[] = [];
  for (let i = 0; i <= 12; i++) whisker.push(quad(b0, b1, b2, i / 12));
  strokePath(whisker, 7, CREAM, 0.75, 0.4);
}

// ---------------------------------------------------------------------------
// Burst glows where the body pierces each ring
// ---------------------------------------------------------------------------
{
  // Pierce points live on the SILHOUETTE (where a ring line meets the body
  // outline), not on the spine — so the glow sits on the fish's edge and the
  // sparks shear off along the ring's tangent.
  const crossings: { p: Pt; tangent: Pt }[] = [];
  for (const line of [outlineTop, outlineBot]) {
    for (let i = 1; i < line.length; i++) {
      const dPrev = Math.hypot(line[i - 1].x - RC.x, line[i - 1].y - RC.y);
      const dNow = Math.hypot(line[i].x - RC.x, line[i].y - RC.y);
      for (const r of RING_RADII) {
        if ((dPrev - r) * (dNow - r) < 0) {
          const u = (r - dPrev) / (dNow - dPrev);
          const p = {
            x: lerp(line[i - 1].x, line[i].x, u),
            y: lerp(line[i - 1].y, line[i].y, u),
          };
          const rx = p.x - RC.x, ry = p.y - RC.y;
          const rl = Math.hypot(rx, ry) || 1;
          crossings.push({ p, tangent: { x: -ry / rl, y: rx / rl } });
        }
      }
    }
  }
  for (const c of crossings) {
    glow(c.p.x, c.p.y, 118, CYAN_PALE, 0.45);
    glow(c.p.x, c.p.y, 46, [255, 255, 255], 0.55);
    // short sparks that shear off OUTSIDE the silhouette, along the ring
    const outX = (c.p.x - RC.x) / (Math.hypot(c.p.x - RC.x, c.p.y - RC.y) || 1);
    const outY = (c.p.y - RC.y) / (Math.hypot(c.p.x - RC.x, c.p.y - RC.y) || 1);
    for (let k = 0; k < 3; k++) {
      const sgn = rand() < 0.5 ? -1 : 1;
      const len = 20 + rand() * 30;
      const sx = c.p.x + outX * 16 + c.tangent.x * (rand() - 0.5) * 14;
      const sy = c.p.y + outY * 16 + c.tangent.y * (rand() - 0.5) * 14;
      strokePath(
        [{ x: sx, y: sy }, { x: sx + c.tangent.x * len * sgn, y: sy + c.tangent.y * len * sgn }],
        4, CYAN_PALE, 0.35, 0.5,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Spray at the tail + droplets & sparks flying outward toward the viewer
// ---------------------------------------------------------------------------
{
  const tail = spineAt(0.02);
  for (let i = 0; i < 46; i++) {
    const ang = -Math.PI * (0.15 + rand() * 0.75);
    const dist = rand() * 260;
    const x = tail.x + Math.cos(ang) * dist - 40;
    const y = tail.y + Math.sin(ang) * dist * 0.7 + 60;
    disc(x, y, 4 + rand() * 15, CYAN_PALE, 0.25 + rand() * 0.4, 0.5);
  }
  // Foam pool where the tail leaves the water
  for (let i = 0; i < 30; i++) {
    const x = tail.x - 130 + rand() * 300;
    const y = 1870 + rand() * 110;
    disc(x, y, 8 + rand() * 26, [225, 245, 255], 0.16 + rand() * 0.25, 0.6);
  }
}
// Droplets radiating from the burst centre — bigger near the edges (perspective)
for (let i = 0; i < 110; i++) {
  const ang = rand() * Math.PI * 2;
  const dist = 190 + Math.pow(rand(), 0.8) * 980;
  const x = RC.x + Math.cos(ang) * dist;
  const y = RC.y + Math.sin(ang) * dist;
  if (x < 12 || y < 12 || x > SS - 12 || y > SS - 12) continue;
  const r = 3 + (dist / 1170) * 17 + rand() * 5;
  ellipse(x, y, r * 1.25, r, ang, CYAN_PALE, 0.42, 0.35);
  disc(x - r * 0.3, y - r * 0.3, r * 0.34, [255, 255, 255], 0.85, 0.4);
}
// Gold sparks
for (let i = 0; i < 80; i++) {
  const ang = rand() * Math.PI * 2;
  const dist = 120 + Math.pow(rand(), 1.3) * 900;
  const x = RC.x + Math.cos(ang) * dist;
  const y = RC.y + Math.sin(ang) * dist;
  if (x < 10 || y < 10 || x > SS - 10 || y > SS - 10) continue;
  const len = 6 + rand() * 20;
  strokePath(
    [{ x: x - Math.cos(ang) * len, y: y - Math.sin(ang) * len }, { x: x + Math.cos(ang) * len, y: y + Math.sin(ang) * len }],
    4.5, GOLD_HI, 0.55, 0.5,
  );
}
// A few crisp four-point star sparkles near the rings
function sparkle(x: number, y: number, r: number): void {
  const pts: Pt[] = [];
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const rad = i % 2 === 0 ? r : r * 0.18;
    pts.push({ x: x + Math.cos(ang) * rad, y: y + Math.sin(ang) * rad });
  }
  fillPoly(pts, [255, 252, 240], 0.9);
  glow(x, y, r * 1.5, CYAN_PALE, 0.3);
}
sparkle(760, 330, 34);
sparkle(1560, 1010, 26);
sparkle(520, 900, 22);
sparkle(1700, 300, 20);

// ---------------------------------------------------------------------------
// Water line at the bottom + the tiny torii gate (scale joke)
// ---------------------------------------------------------------------------
for (let i = 0; i < 26; i++) {
  const y = 1900 + rand() * 120;
  const x = rand() * SS;
  const len = 60 + rand() * 220;
  strokePath([{ x, y }, { x: x + len, y }], 5, CYAN, 0.10 + rand() * 0.12, 0.6);
}
{
  // The gate stands ~300px wide at render scale — the koi is ~1500px long.
  const gx = 1760; // centre of the gate
  const baseY = 1968;
  const postH = 215;
  const postW = 26;
  const spread = 105; // half distance between posts
  // dark rock it stands on
  ellipse(gx, baseY + 16, 210, 34, 0, [8, 10, 30], 0.85, 0.3);
  // posts
  fillPoly(
    [
      { x: gx - spread - postW / 2, y: baseY },
      { x: gx - spread + postW / 2, y: baseY },
      { x: gx - spread + postW / 2 - 4, y: baseY - postH },
      { x: gx - spread - postW / 2 + 4, y: baseY - postH },
    ],
    VERMILION, 1,
  );
  fillPoly(
    [
      { x: gx + spread - postW / 2, y: baseY },
      { x: gx + spread + postW / 2, y: baseY },
      { x: gx + spread + postW / 2 - 4, y: baseY - postH },
      { x: gx + spread - postW / 2 + 4, y: baseY - postH },
    ],
    VERMILION, 1,
  );
  // centre post
  fillPoly(
    [
      { x: gx - 9, y: baseY },
      { x: gx + 9, y: baseY },
      { x: gx + 9, y: baseY - postH + 52 },
      { x: gx - 9, y: baseY - postH + 52 },
    ],
    VERMILION_DARK, 1,
  );
  // lower beam
  fillPoly(
    [
      { x: gx - spread - 44, y: baseY - postH + 58 },
      { x: gx + spread + 44, y: baseY - postH + 58 },
      { x: gx + spread + 44, y: baseY - postH + 82 },
      { x: gx - spread - 44, y: baseY - postH + 82 },
    ],
    VERMILION, 1,
  );
  // top beam: gently upturned curve, sampled from a quadratic
  const beam: Pt[] = [];
  const b0 = { x: gx - spread - 92, y: baseY - postH - 6 };
  const b1 = { x: gx, y: baseY - postH - 52 };
  const b2 = { x: gx + spread + 92, y: baseY - postH - 6 };
  for (let i = 0; i <= 16; i++) beam.push(quad(b0, b1, b2, i / 16));
  const beamPoly: Pt[] = [
    ...beam,
    ...beam.slice().reverse().map((p) => ({ x: p.x, y: p.y + 34 })),
  ];
  fillPoly(beamPoly, VERMILION_DARK, 1);
  const beamTop: Pt[] = beam.map((p) => ({ x: p.x, y: p.y - 2 }));
  strokePath(beamTop, 7, VERMILION, 0.9, 0.3);
  // faint reflection shimmer under the gate
  for (let i = 0; i < 7; i++) {
    const y = baseY + 26 + i * 13;
    const len = 150 - i * 16;
    strokePath([{ x: gx - len / 2, y }, { x: gx + len / 2, y }], 4, VERMILION, 0.13, 0.6);
  }
}

// ---------------------------------------------------------------------------
// Downscale 2x (box filter) + vignette, then encode PNG
// ---------------------------------------------------------------------------
const out = new Uint8Array(OUT * OUT * 3);
const vc = SS / 2; // vignette centre in render coords
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const i = ((y * 2 + dy) * SS + (x * 2 + dx)) * 3;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2];
      }
    }
    const cx = x * 2 - vc, cy = y * 2 - vc;
    const d = Math.hypot(cx, cy) / (SS * 0.72);
    const vig = 1 - 0.30 * clamp(d * d, 0, 1);
    const o = (y * OUT + x) * 3;
    out[o] = clamp(Math.round((r / 4) * vig), 0, 255);
    out[o + 1] = clamp(Math.round((g / 4) * vig), 0, 255);
    out[o + 2] = clamp(Math.round((b / 4) * vig), 0, 255);
  }
}

// --- Minimal PNG encoder (Sub filter + zlib) --------------------------------
const crcTable: number[] = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable.push(c >>> 0);
}
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const stride = OUT * 3;
const raw = Buffer.alloc((stride + 1) * OUT);
for (let y = 0; y < OUT; y++) {
  const rowOff = y * (stride + 1);
  raw[rowOff] = 1; // filter: Sub
  for (let x = 0; x < stride; x++) {
    const v = out[y * stride + x];
    const left = x >= 3 ? out[y * stride + x - 3] : 0;
    raw[rowOff + 1 + x] = (v - left) & 0xff;
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0);
ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type: truecolour RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "entry.png");
writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${png.length} bytes, ${OUT}x${OUT})`);

'use strict';
// Vishwaroop Sky: finds the sky in a camera frame or photo and replaces it with an
// Interstellar-style cosmos, with a colossal Vishnu standing behind the skyline.

const $ = s => document.querySelector(s);
const view = $('#view');
const vctx = view.getContext('2d');
const video = $('#video');

const settings = { intensity: 0.95, size: 0.9, glow: 0.7, halo: true, showMask: false, x: 0.5, y: 0.97 };

let source = null;          // { el, w, h, still }
let facing = 'environment';
let stream = null;
let deity = null;           // { canvas, blend, headY } headY = halo centre as a fraction of height
let maskPrev = null;
let stillMaskDirty = true;

// ---------- small canvases ----------
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const sampler = makeCanvas(1, 1);
const sctx = sampler.getContext('2d', { willReadFrequently: true });
const maskCanvas = makeCanvas(1, 1);
const mctx = maskCanvas.getContext('2d');
const cosmos = makeCanvas(1, 1);
const cctx = cosmos.getContext('2d');

// ---------- sky detection ----------
// Heuristic: sky pixels are blue, or bright and grey (cloud/overcast), and smooth.
// Only regions connected to the top of the frame count, so blue walls and cars below stay put.
function computeSkyMask(el, sw, sh, still) {
  const mw = still ? 320 : 160;
  const mh = Math.max(1, Math.round(mw * sh / sw));
  if (sampler.width !== mw || sampler.height !== mh) { sampler.width = mw; sampler.height = mh; }
  sctx.drawImage(el, 0, 0, sw, sh, 0, 0, mw, mh);
  const d = sctx.getImageData(0, 0, mw, mh).data;
  const n = mw * mh;
  const lum = new Float32Array(n), score = new Float32Array(n);

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const v = mx / 255, s = mx ? (mx - mn) / mx : 0;
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    let sc = 0;
    if (b > r * 1.04 && b >= g * 0.85 && v > 0.32) sc = 1;            // blue sky
    else if (v > 0.6 && s < 0.22) sc = 0.9;                            // cloud / overcast
    else if (v > 0.72 && s < 0.55) sc = 0.6;                           // bright haze, sunset glow
    score[i] = sc;
  }
  // texture: sky is smooth, foliage and buildings are not
  const texLimit = still ? 26 : 22;
  for (let y = 0; y < mh - 1; y++) for (let x = 0; x < mw - 1; x++) {
    const i = y * mw + x;
    const gr = Math.abs(lum[i] - lum[i + 1]) + Math.abs(lum[i] - lum[i + mw]);
    if (gr > texLimit) score[i] *= 0.15;
  }

  // flood fill from the top edge
  const mask = new Uint8Array(n);
  const q = new Int32Array(n);
  let qh = 0, qt = 0;
  const seedRows = Math.max(1, Math.round(mh * 0.04));
  for (let y = 0; y < seedRows; y++) for (let x = 0; x < mw; x++) {
    const i = y * mw + x;
    if (score[i] > 0.5 && !mask[i]) { mask[i] = 1; q[qt++] = i; }
  }
  while (qh < qt) {
    const i = q[qh++], x = i % mw, y = (i / mw) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < mw - 1 ? i + 1 : -1, y > 0 ? i - mw : -1, y < mh - 1 ? i + mw : -1];
    for (const j of nb) {
      if (j < 0 || mask[j]) continue;
      if (score[j] > 0.4 && Math.abs(lum[j] - lum[i]) < 28) { mask[j] = 1; q[qt++] = j; }
    }
  }

  // close small holes (birds, wires, thin branches): dilate then erode
  // then erode once more so the cosmos never bleeds over rooftops
  const closed = morph(morph(morph(mask, mw, mh, true), mw, mh, false), mw, mh, false);

  // soften
  let f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = closed[i];
  f = boxBlur(boxBlur(f, mw, mh), mw, mh);

  if (!still) {
    if (maskPrev && maskPrev.length === n) for (let i = 0; i < n; i++) f[i] = maskPrev[i] * 0.65 + f[i] * 0.35;
    maskPrev = f;
  }

  if (maskCanvas.width !== mw || maskCanvas.height !== mh) { maskCanvas.width = mw; maskCanvas.height = mh; }
  const img = mctx.createImageData(mw, mh);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    img.data[p] = img.data[p + 1] = img.data[p + 2] = 255;
    img.data[p + 3] = Math.min(255, f[i] * 270);
  }
  mctx.putImageData(img, 0, 0);
}

function morph(m, w, h, grow) {
  const out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = grow ? 0 : 1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = Math.min(h - 1, Math.max(0, y + dy)), xx = Math.min(w - 1, Math.max(0, x + dx));
      const s = m[yy * w + xx];
      if (grow) v |= s; else v &= s;
    }
    out[y * w + x] = v;
  }
  return out;
}

function boxBlur(a, w, h) {
  const t = new Float32Array(a.length), o = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    t[i] = (a[i] + a[y * w + Math.max(0, x - 1)] + a[y * w + Math.min(w - 1, x + 1)]) / 3;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    o[i] = (t[i] + t[Math.max(0, y - 1) * w + x] + t[Math.min(h - 1, y + 1) * w + x]) / 3;
  }
  return o;
}

// ---------- cosmos assets ----------
function valueNoise(seed) {
  const N = 256, perm = new Uint8Array(N * 2), vals = new Float32Array(N);
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < N; i++) { perm[i] = i; vals[i] = rnd(); }
  for (let i = N - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < N; i++) perm[i + N] = perm[i];
  const h = (x, y) => vals[perm[(perm[x & 255] + y) & 511]];
  const sm = t => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), e = h(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + e) * xf * yf;
  };
}

function fbm(noise, x, y, oct) {
  let v = 0, amp = 0.5, f = 1;
  for (let o = 0; o < oct; o++) { v += amp * noise(x * f, y * f); f *= 2.03; amp *= 0.5; }
  return v;
}

function buildNebula() {
  const S = 512, c = makeCanvas(S, S), x = c.getContext('2d');
  const img = x.createImageData(S, S);
  const n1 = valueNoise(7), n2 = valueNoise(91), n3 = valueNoise(333);
  const pal = [[6, 10, 34], [18, 64, 104], [74, 30, 98], [214, 150, 70]];
  for (let y = 0; y < S; y++) for (let xx = 0; xx < S; xx++) {
    const u = xx / S * 4, v = y / S * 4;
    const w = fbm(n3, u * 0.7, v * 0.7, 3) * 2.2;                      // domain warp
    const a = fbm(n1, u + w, v - w, 6), b = fbm(n2, u - w * 0.5, v + w, 5);
    const dens = Math.max(0, a - 0.35) * 2.4;
    const mixT = Math.min(1, Math.max(0, (b - 0.4) * 2.5));
    const base = pal[0];
    const c1 = pal[1].map((k, i) => k + (pal[2][i] - k) * mixT);
    const hot = Math.max(0, dens - 0.55) * 1.6;
    const p = (y * S + xx) * 4;
    for (let i = 0; i < 3; i++) {
      const col = base[i] + (c1[i] - base[i]) * Math.min(1, dens) + (pal[3][i] - c1[i]) * Math.min(1, hot) * 0.6;
      img.data[p + i] = Math.min(255, col);
    }
    img.data[p + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}

let stars = [];
function buildStars(W, H) {
  const count = Math.round(W * H / 2600);
  stars = [];
  let s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < count; i++) {
    const big = rnd() < 0.04;
    stars.push({ x: rnd() * W, y: rnd() * H, r: big ? 1.2 + rnd() * 1.6 : 0.4 + rnd() * 0.8,
      a: 0.35 + rnd() * 0.65, f: 0.6 + rnd() * 2.5, p: rnd() * 6.28, warm: rnd() < 0.25, big });
  }
}

const nebula = buildNebula();

// ---------- built-in Vishwaroop figure (placeholder until real art is loaded) ----------
function buildFigure() {
  const W = 1000, H = 1400, c = makeCanvas(W, H), x = c.getContext('2d');
  const shape = makeCanvas(W, H), s = shape.getContext('2d');
  s.lineCap = 'round'; s.lineJoin = 'round';
  s.fillStyle = s.strokeStyle = '#fff';
  const cx = 500, shY = 450;

  // arms, fanned like the universal form; 9 per side
  const symbols = [];
  for (const side of [-1, 1]) {
    const N = 9;
    for (let k = 0; k < N; k++) {
      const t = k / (N - 1);
      const a1 = (-100 + t * 155) * Math.PI / 180;           // upper arm, from up to down-out
      const a2 = a1 - (40 - t * 20) * Math.PI / 180;           // forearm bends upward
      const sx = cx + side * 105, sy = shY + 10 + t * 30;
      const ex = sx + side * Math.cos(a1) * 175, ey = sy + Math.sin(a1) * 175;
      const hx = ex + side * Math.cos(a2) * 150, hy = ey + Math.sin(a2) * 150;
      s.globalAlpha = 0.55 + 0.45 * (k === 2 || k === 6 ? 1 : 0.6);
      s.lineWidth = 30 - t * 4;
      s.beginPath(); s.moveTo(sx, sy); s.lineTo(ex, ey); s.stroke();
      s.lineWidth = 24 - t * 4;
      s.beginPath(); s.moveTo(ex, ey); s.lineTo(hx, hy); s.stroke();
      s.beginPath(); s.arc(hx, hy, 15, 0, Math.PI * 2); s.fill();
      if (k === 2) symbols.push({ kind: side > 0 ? 'chakra' : 'shankha', x: hx, y: hy - 30 });
      if (k === 6) symbols.push({ kind: side > 0 ? 'padma' : 'gada', x: hx, y: hy - 20 });
    }
  }
  s.globalAlpha = 1;

  // torso and dhoti, fading into the horizon
  s.beginPath();
  s.moveTo(cx - 110, shY); s.quadraticCurveTo(cx, shY - 40, cx + 110, shY);
  s.quadraticCurveTo(cx + 95, 600, cx + 70, 720);
  s.quadraticCurveTo(cx + 190, 1050, cx + 210, H);
  s.lineTo(cx - 210, H);
  s.quadraticCurveTo(cx - 190, 1050, cx - 70, 720);
  s.quadraticCurveTo(cx - 95, 600, cx - 110, shY);
  s.fill();
  s.fillRect(cx - 32, 340, 64, 100);                          // neck
  s.beginPath(); s.ellipse(cx, 300, 64, 78, 0, 0, Math.PI * 2); s.fill(); // head
  // kireeta mukuta (tall crown)
  s.beginPath();
  s.moveTo(cx - 72, 262); s.lineTo(cx + 72, 262); s.lineTo(cx + 52, 150); s.lineTo(cx + 30, 70);
  s.lineTo(cx, 20); s.lineTo(cx - 30, 70); s.lineTo(cx - 52, 150); s.closePath(); s.fill();

  // colour the silhouette gold, fading at the bottom
  s.globalCompositeOperation = 'source-in';
  const g = s.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#fff3cf'); g.addColorStop(0.3, '#f2c062'); g.addColorStop(0.65, '#b8741f');
  g.addColorStop(1, 'rgba(120,60,20,0)');
  s.fillStyle = g; s.fillRect(0, 0, W, H);
  s.globalCompositeOperation = 'source-over';

  // ornaments: necklaces, armbands, urdhva pundra
  s.strokeStyle = 'rgba(255,250,230,.9)'; s.lineWidth = 5;
  for (let i = 0; i < 3; i++) { s.beginPath(); s.arc(cx, 400 + i * 22, 90 - i * 6, 0.2 * Math.PI, 0.8 * Math.PI); s.stroke(); }
  s.lineWidth = 4; s.strokeStyle = '#fff8e6';
  s.beginPath(); s.moveTo(cx - 14, 236); s.quadraticCurveTo(cx, 285, cx + 14, 236); s.stroke();
  s.strokeStyle = '#ff5a3c'; s.beginPath(); s.moveTo(cx, 240); s.lineTo(cx, 270); s.stroke();
  // vanamala, the long garland
  s.strokeStyle = 'rgba(255,220,150,.75)'; s.lineWidth = 9;
  s.beginPath(); s.moveTo(cx - 100, shY + 10); s.quadraticCurveTo(cx, 1050, cx + 100, shY + 10); s.stroke();

  for (const sy of symbols) drawSymbol(s, sy);

  // glow: draw blurred copy then the crisp figure
  x.filter = 'blur(18px)'; x.globalAlpha = 0.9; x.drawImage(shape, 0, 0);
  x.filter = 'none'; x.globalAlpha = 1; x.drawImage(shape, 0, 0);
  return { canvas: c, blend: 'source-over', headY: 300 / H, builtIn: true };
}

function drawSymbol(s, { kind, x, y }) {
  s.save(); s.translate(x, y); s.strokeStyle = '#fffaf0'; s.fillStyle = '#fffaf0';
  if (kind === 'chakra') {
    s.lineWidth = 6; s.beginPath(); s.arc(0, 0, 42, 0, Math.PI * 2); s.stroke();
    s.beginPath(); s.arc(0, 0, 12, 0, Math.PI * 2); s.fill();
    for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; s.beginPath(); s.moveTo(Math.cos(a) * 12, Math.sin(a) * 12); s.lineTo(Math.cos(a) * 42, Math.sin(a) * 42); s.stroke(); }
    for (let i = 0; i < 24; i++) { const a = i * Math.PI / 12; s.beginPath(); s.moveTo(Math.cos(a) * 42, Math.sin(a) * 42); s.lineTo(Math.cos(a + 0.12) * 56, Math.sin(a + 0.12) * 56); s.stroke(); }
  } else if (kind === 'shankha') {
    s.beginPath(); s.moveTo(0, -46); s.bezierCurveTo(38, -30, 34, 30, 0, 44); s.bezierCurveTo(-30, 26, -34, -26, 0, -46); s.fill();
    s.strokeStyle = '#c88b2e'; s.lineWidth = 4;
    s.beginPath(); for (let t = 0; t < 12; t += 0.2) s.lineTo(Math.cos(t) * t * 2, -20 + Math.sin(t) * t * 2 + t * 2); s.stroke();
  } else if (kind === 'padma') {
    for (let i = 0; i < 8; i++) { s.save(); s.rotate(-Math.PI / 2 + (i - 3.5) * 0.32); s.beginPath(); s.ellipse(0, -30, 12, 32, 0, 0, Math.PI * 2); s.globalAlpha = 0.85; s.fill(); s.restore(); }
  } else if (kind === 'gada') {
    s.lineWidth = 10; s.beginPath(); s.moveTo(0, 60); s.lineTo(0, -70); s.stroke();
    s.beginPath(); s.arc(0, -90, 30, 0, Math.PI * 2); s.fill();
  }
  s.restore();
}

// ---------- rendering ----------
function resize(W, H) {
  if (view.width === W && view.height === H) return;
  view.width = W; view.height = H; cosmos.width = W; cosmos.height = H;
  buildStars(W, H);
  maskPrev = null;
}

function deityRect(W, H) {
  const d = deity.canvas;
  const h = H * settings.size, w = h * d.width / d.height;
  const breathe = 1 + Math.sin(performance.now() / 2400) * 0.006;
  const cx = W * settings.x, bottom = H * settings.y;
  return { x: cx - w * breathe / 2, y: bottom - h * breathe, w: w * breathe, h: h * breathe };
}

function drawCosmos(W, H, t) {
  const c = cctx;
  c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.filter = 'none';
  c.fillStyle = '#02030a'; c.fillRect(0, 0, W, H);

  const D = Math.hypot(W, H) * 1.25;
  c.save(); c.translate(W * 0.5, H * 0.4); c.rotate(t * 0.006); c.globalAlpha = 0.95;
  c.drawImage(nebula, -D / 2, -D / 2, D, D); c.restore();

  for (const s of stars) {
    c.globalAlpha = s.a * (0.55 + 0.45 * Math.sin(t * s.f + s.p));
    c.fillStyle = s.warm ? '#ffe2b0' : '#dfe9ff';
    c.beginPath(); c.arc(s.x, s.y, s.r * Math.max(1, W / 1400), 0, Math.PI * 2); c.fill();
  }
  c.globalAlpha = 1;

  const r = deityRect(W, H);
  const hx = r.x + r.w / 2, hy = r.y + r.h * deity.headY;
  const R = r.h * 0.2;

  // warm light pouring from the figure
  const glow = c.createRadialGradient(hx, hy, 0, hx, hy, R * 5);
  glow.addColorStop(0, `rgba(255,214,140,${0.55 * settings.glow})`);
  glow.addColorStop(0.35, `rgba(240,150,60,${0.22 * settings.glow})`);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  c.globalCompositeOperation = 'screen'; c.fillStyle = glow; c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'source-over';

  if (settings.halo) drawGargantua(c, hx, hy, R, t);

  c.save();
  c.globalCompositeOperation = deity.blend;
  c.globalAlpha = 0.96;
  c.drawImage(deity.canvas, r.x, r.y, r.w, r.h);
  c.restore();

  // horizon haze so the sky meets the skyline softly
  const hz = c.createLinearGradient(0, H * 0.45, 0, H);
  hz.addColorStop(0, 'rgba(30,60,90,0)'); hz.addColorStop(1, 'rgba(120,110,120,.35)');
  c.fillStyle = hz; c.fillRect(0, 0, W, H);

  // keep only the sky
  c.globalCompositeOperation = 'destination-in';
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  c.drawImage(maskCanvas, 0, 0, W, H);
  c.globalCompositeOperation = 'source-over';
}

// Gargantua: a black disc with a lensed photon ring and a flat accretion disc, used as the halo
function drawGargantua(c, x, y, R, t) {
  c.save(); c.translate(x, y);
  // outer lensed light
  const lens = c.createRadialGradient(0, 0, R * 0.9, 0, 0, R * 2.1);
  lens.addColorStop(0, `rgba(255,236,190,${0.9 * settings.glow + 0.1})`);
  lens.addColorStop(0.18, 'rgba(255,180,90,.55)');
  lens.addColorStop(1, 'rgba(255,120,40,0)');
  c.globalCompositeOperation = 'screen'; c.fillStyle = lens;
  c.beginPath(); c.arc(0, 0, R * 2.1, 0, Math.PI * 2); c.fill();
  // accretion disc, back half
  c.save(); c.scale(1, 0.13);
  const disc = c.createRadialGradient(0, 0, R * 1.05, 0, 0, R * 3.4);
  disc.addColorStop(0, 'rgba(255,245,215,1)'); disc.addColorStop(0.3, 'rgba(255,170,80,.75)'); disc.addColorStop(1, 'rgba(255,90,20,0)');
  c.fillStyle = disc; c.beginPath(); c.arc(0, 0, R * 3.4, Math.PI, Math.PI * 2); c.fill();
  c.restore();
  // event horizon
  c.globalCompositeOperation = 'source-over'; c.fillStyle = '#000';
  c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fill();
  // photon ring
  c.globalCompositeOperation = 'screen';
  c.strokeStyle = 'rgba(255,240,200,.95)'; c.lineWidth = Math.max(1.5, R * 0.035);
  c.beginPath(); c.arc(0, 0, R * 1.03, 0, Math.PI * 2); c.stroke();
  // slowly turning chakra spokes on the ring
  c.rotate(t * 0.15); c.strokeStyle = 'rgba(255,215,140,.35)'; c.lineWidth = Math.max(1, R * 0.012);
  for (let i = 0; i < 24; i++) { const a = i * Math.PI / 12; c.beginPath(); c.moveTo(Math.cos(a) * R * 1.12, Math.sin(a) * R * 1.12); c.lineTo(Math.cos(a) * R * 1.5, Math.sin(a) * R * 1.5); c.stroke(); }
  c.rotate(-t * 0.15);
  // accretion disc, front half crossing the black disc
  c.scale(1, 0.13);
  const front = c.createRadialGradient(0, 0, R * 0.2, 0, 0, R * 3.4);
  front.addColorStop(0, 'rgba(255,250,230,1)'); front.addColorStop(0.45, 'rgba(255,180,90,.8)'); front.addColorStop(1, 'rgba(255,90,20,0)');
  c.fillStyle = front; c.beginPath(); c.arc(0, 0, R * 3.4, 0, Math.PI); c.fill();
  c.restore();
}

function render() {
  requestAnimationFrame(render);
  if (!source || !deity) return;
  if (!source.still && video.readyState < 2) return;
  const W = source.w, H = source.h;
  resize(W, H);
  const t = performance.now() / 1000;

  if (!source.still || stillMaskDirty) { computeSkyMask(source.el, W, H, source.still); stillMaskDirty = false; }

  vctx.globalCompositeOperation = 'source-over'; vctx.globalAlpha = 1;
  vctx.drawImage(source.el, 0, 0, W, H);

  const k = settings.intensity;
  // cool, cinematic grade on the ground so it sits under a cosmic sky
  vctx.globalCompositeOperation = 'multiply';
  vctx.globalAlpha = k * 0.85;
  vctx.fillStyle = 'rgb(176,188,220)'; vctx.fillRect(0, 0, W, H);
  // gold light spill from the figure onto the world
  const r = deityRect(W, H);
  const spill = vctx.createRadialGradient(r.x + r.w / 2, r.y + r.h * 0.4, 0, r.x + r.w / 2, r.y + r.h * 0.4, Math.max(W, H));
  spill.addColorStop(0, `rgba(255,190,110,${0.35 * settings.glow})`); spill.addColorStop(1, 'rgba(0,0,0,0)');
  vctx.globalCompositeOperation = 'screen'; vctx.globalAlpha = k;
  vctx.fillStyle = spill; vctx.fillRect(0, 0, W, H);

  drawCosmos(W, H, t);
  vctx.globalCompositeOperation = 'source-over'; vctx.globalAlpha = k;
  vctx.drawImage(cosmos, 0, 0);
  vctx.globalAlpha = 1;

  // vignette
  const vg = vctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${0.55 * k})`);
  vctx.fillStyle = vg; vctx.fillRect(0, 0, W, H);

  if (settings.showMask) {
    vctx.globalAlpha = 0.5; vctx.globalCompositeOperation = 'source-over';
    vctx.drawImage(maskCanvas, 0, 0, W, H);
    vctx.globalAlpha = 1;
  }
}

// ---------- sources ----------
async function startCamera() {
  try {
    if (stream) stream.getTracks().forEach(tr => tr.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    video.srcObject = stream;
    await video.play();
    await new Promise(res => video.videoWidth ? res() : video.addEventListener('loadedmetadata', res, { once: true }));
    source = { el: video, w: video.videoWidth, h: video.videoHeight, still: false };
    $('#start').style.display = 'none';
  } catch (e) {
    toast('Camera unavailable: ' + e.message);
  }
}

function loadImageFile(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => res(im); im.onerror = rej; im.src = url;
  });
}

async function usePhoto(file) {
  const im = await loadImageFile(file);
  const max = 2400, sc = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
  const c = makeCanvas(Math.round(im.naturalWidth * sc), Math.round(im.naturalHeight * sc));
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  if (stream) { stream.getTracks().forEach(tr => tr.stop()); stream = null; }
  source = { el: c, w: c.width, h: c.height, still: true };
  stillMaskDirty = true;
  $('#start').style.display = 'none';
}

// Loaded art: keep transparency; screen-blend dark backgrounds; key out light flat backgrounds.
function prepareDeity(im) {
  const max = 1800, sc = Math.min(1, max / Math.max(im.naturalWidth || im.width, im.naturalHeight || im.height));
  const w = Math.round((im.naturalWidth || im.width) * sc), h = Math.round((im.naturalHeight || im.height) * sc);
  const c = makeCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(im, 0, 0, w, h);
  const data = x.getImageData(0, 0, w, h), d = data.data;
  const corners = [0, w - 1, (h - 1) * w, h * w - 1].map(i => i * 4);
  const transparent = corners.some(p => d[p + 3] < 20);
  let blend = 'source-over';
  if (!transparent) {
    const bg = [0, 1, 2].map(k => corners.reduce((s, p) => s + d[p + k], 0) / 4);
    const bgLum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    if (bgLum < 50) blend = 'screen';
    else keyOutBackground(d, w, h, bg);
    x.putImageData(data, 0, 0);
  }
  return { canvas: c, blend, headY: 0.2, builtIn: false };
}

function keyOutBackground(d, w, h, bg) {
  const n = w * h, seen = new Uint8Array(n), q = new Int32Array(n);
  let qh = 0, qt = 0;
  const dist = i => Math.hypot(d[i * 4] - bg[0], d[i * 4 + 1] - bg[1], d[i * 4 + 2] - bg[2]);
  const push = i => { if (!seen[i] && dist(i) < 70) { seen[i] = 1; q[qt++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (qh < qt) {
    const i = q[qh++], x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
  }
  for (let i = 0; i < n; i++) if (seen[i]) d[i * 4 + 3] = Math.min(255, Math.max(0, (dist(i) - 25) * 5.6));
}

// ---------- storage ----------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('skycam', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kvSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function kvGet(k) {
  const db = await idb();
  return new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function initDeity() {
  try {
    const saved = await kvGet('deity');
    if (saved) { deity = prepareDeity(await loadImageFile(saved)); return; }
  } catch (e) { /* storage unavailable, fall through */ }
  try {
    const r = await fetch('vishnu.png');
    if (r.ok) { deity = prepareDeity(await loadImageFile(await r.blob())); return; }
  } catch (e) { /* no bundled art */ }
  deity = buildFigure();
}

// ---------- capture ----------
function capture() {
  if (!source) return;
  view.toBlob(async blob => {
    const name = `vishwaroop-sky-${Date.now()}.jpg`;
    const file = new File([blob], name, { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    toast('Saved');
  }, 'image/jpeg', 0.93);
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.style.display = 'none'), 2600);
}

// ---------- gestures: drag to move, pinch to resize ----------
const pointers = new Map();
let pinchStart = null;
function displayScale() {
  const r = view.getBoundingClientRect();
  return Math.min(r.width / view.width, r.height / view.height);
}
view.addEventListener('pointerdown', e => { view.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
view.addEventListener('pointermove', e => {
  const prev = pointers.get(e.pointerId);
  if (!prev || !source) return;
  const cur = { x: e.clientX, y: e.clientY };
  if (pointers.size === 1) {
    const s = displayScale();
    settings.x += (cur.x - prev.x) / (view.width * s);
    settings.y += (cur.y - prev.y) / (view.height * s);
  } else if (pointers.size === 2) {
    pointers.set(e.pointerId, cur);
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (!pinchStart) pinchStart = { dist, size: settings.size };
    settings.size = Math.min(3, Math.max(0.3, pinchStart.size * dist / pinchStart.dist));
    $('#size').value = settings.size;
  }
  pointers.set(e.pointerId, cur);
});
const endPointer = e => { pointers.delete(e.pointerId); pinchStart = null; };
view.addEventListener('pointerup', endPointer);
view.addEventListener('pointercancel', endPointer);

// ---------- wiring ----------
$('#startCam').onclick = startCamera;
$('#startPhoto').onclick = $('#photoBtn').onclick = () => $('#photoInput').click();
$('#photoInput').onchange = e => e.target.files[0] && usePhoto(e.target.files[0]);
$('#flipBtn').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; startCamera(); };
$('#shutter').onclick = capture;
$('#gear').onclick = () => $('#panel').classList.toggle('open');
for (const id of ['intensity', 'size', 'glow']) $('#' + id).oninput = e => (settings[id] = +e.target.value);
$('#halo').onchange = e => (settings.halo = e.target.checked);
$('#showMask').onchange = e => (settings.showMask = e.target.checked);
$('#pickDeity').onclick = () => $('#deityInput').click();
$('#deityInput').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  deity = prepareDeity(await loadImageFile(f));
  try { await kvSet('deity', f); } catch (err) { /* keep for this session only */ }
  toast('Vishnu image loaded');
};
$('#resetDeity').onclick = async () => { deity = buildFigure(); try { await kvSet('deity', null); } catch (e) {} };
document.addEventListener('click', e => { if (!e.target.closest('#panel, #gear')) $('#panel').classList.remove('open'); });

// for testing in a browser without a camera: ?photo=<url>
const testPhoto = new URLSearchParams(location.search).get('photo');
initDeity().then(async () => {
  if (testPhoto) { const r = await fetch(testPhoto); await usePhoto(await r.blob()); }
});
requestAnimationFrame(render);

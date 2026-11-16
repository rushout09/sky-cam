'use strict';
// Vishwaroop Sky: finds the sky in a camera frame or photo and replaces it with an
// Interstellar-style cosmos, with a colossal Vishnu standing behind the skyline.

const $ = s => document.querySelector(s);
const view = $('#view');
const vctx = view.getContext('2d');
const video = $('#video');

const settings = { intensity: 0.95, size: 0.9, glow: 0.7, halo: true, showMask: false, x: 0.5, y: 0.97,
  figure: true, embers: true, artX: 0.5, artY: 0.12, artScale: 1 };

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
const darkMask = makeCanvas(1, 1);
const dctx = darkMask.getContext('2d');
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
  const closed = morph(morph(mask, mw, mh, true), mw, mh, false);

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
  // a dark copy of the mask, laid over the old sky so its bright blue cannot fringe the rooftops
  if (darkMask.width !== mw || darkMask.height !== mh) { darkMask.width = mw; darkMask.height = mh; }
  dctx.globalCompositeOperation = 'source-over'; dctx.clearRect(0, 0, mw, mh); dctx.drawImage(maskCanvas, 0, 0);
  dctx.globalCompositeOperation = 'source-in'; dctx.fillStyle = '#060912'; dctx.fillRect(0, 0, mw, mh);
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
  // deep ocean teal against amber cosmic gas, as in the Ksheer Sagar references
  const pal = [[3, 9, 18], [14, 64, 84], [132, 76, 26], [255, 200, 116]];
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
  // golden embers and petals drifting upward
  embers = [];
  const ec = Math.round(W * H / 11000);
  for (let i = 0; i < ec; i++) {
    embers.push({ x: rnd() * W, y: rnd() * H, r: (0.8 + rnd() * 2.6) * Math.max(1, W / 1200),
      v: 0.008 + rnd() * 0.03, amp: 6 + rnd() * 22, f: 0.2 + rnd() * 0.8, p: rnd() * 6.28, a: 0.4 + rnd() * 0.6 });
  }
}
let embers = [];

function drawEmbers(c, W, H, t) {
  c.globalCompositeOperation = 'screen';
  for (const e of embers) {
    const y = ((e.y - t * e.v * H) % H + H) % H;
    const x = e.x + Math.sin(t * e.f + e.p) * e.amp;
    const fl = e.a * (0.65 + 0.35 * Math.sin(t * 3 * e.f + e.p));
    c.globalAlpha = fl * 0.25; c.fillStyle = '#ff9a2e';
    c.beginPath(); c.arc(x, y, e.r * 3.2, 0, Math.PI * 2); c.fill();
    c.globalAlpha = fl; c.fillStyle = '#ffd27a';
    c.beginPath(); c.arc(x, y, e.r, 0, Math.PI * 2); c.fill();
  }
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
}

function drawPlanets(c, W, H, lx, ly) {
  const m = Math.min(W, H);
  for (const [fx, fy, fr, col] of [[0.16, 0.3, 0.05, ['#9fb3c4', '#3b4a58']], [0.84, 0.2, 0.028, ['#d9b48a', '#5a3b22']]]) {
    const x = W * fx, y = H * fy, r = m * fr;
    const a = Math.atan2(ly - y, lx - x);
    const g = c.createRadialGradient(x + Math.cos(a) * r * 0.5, y + Math.sin(a) * r * 0.5, r * 0.1, x, y, r);
    g.addColorStop(0, col[0]); g.addColorStop(0.7, col[1]); g.addColorStop(1, '#05070c');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    c.globalCompositeOperation = 'screen'; c.strokeStyle = 'rgba(255,200,120,.35)'; c.lineWidth = Math.max(1, r * 0.06);
    c.beginPath(); c.arc(x, y, r, a - 1.1, a + 1.1); c.stroke();
    c.globalCompositeOperation = 'source-over';
  }
}

// ---------- sky art: any picture the user loads becomes the sky ----------
let skyArt = null;          // { canvas, tint }
function prepareSkyArt(im) {
  const max = 2400, w0 = im.naturalWidth || im.width, h0 = im.naturalHeight || im.height;
  const sc = Math.min(1, max / Math.max(w0, h0));
  const c = makeCanvas(Math.round(w0 * sc), Math.round(h0 * sc));
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  // average colour, used to grade the real world so it sits under this sky
  const t = makeCanvas(8, 8), tx = t.getContext('2d', { willReadFrequently: true });
  tx.drawImage(c, 0, 0, 8, 8);
  const d = tx.getImageData(0, 0, 8, 8).data, avg = [0, 0, 0];
  for (let p = 0; p < d.length; p += 4) for (let k = 0; k < 3; k++) avg[k] += d[p + k] / 64;
  const mx = Math.max(...avg, 1);
  const tint = `rgb(${avg.map(v => Math.round(150 + 105 * v / mx)).join(',')})`;
  const blur = makeCanvas(24, Math.max(1, Math.round(24 * c.height / c.width)));
  blur.getContext('2d').drawImage(c, 0, 0, blur.width, blur.height);
  return { canvas: c, tint, blur };
}

// Cover the frame, but never zoom a tall painting past 1.7x the frame height on a wide frame:
// past that, fit it and fill the sides with a blurred copy. artX/artY pick which part shows (0..1).
function skyArtRect(W, H) {
  const a = skyArt.canvas;
  const cover = Math.max(W / a.width, H / a.height);
  const s = Math.min(cover, 1.7 * H / a.height) * settings.artScale;
  const w = a.width * s, h = a.height * s;
  return { x: (W - w) * settings.artX, y: (H - h) * settings.artY, w, h };
}

function drawSkyArt(c, W, H) {
  const r = skyArtRect(W, H);
  if (r.w < W || r.h < H) {
    const b = skyArt.blur, s = Math.max(W / b.width, H / b.height);
    c.imageSmoothingEnabled = true;
    c.drawImage(b, (W - b.width * s) / 2, (H - b.height * s) / 2, b.width * s, b.height * s);
  }
  c.drawImage(skyArt.canvas, r.x, r.y, r.w, r.h);
}

const nebula = buildNebula();

// ---------- built-in Vishwaroop figure (placeholder until real art is loaded) ----------
// Blue skin, gold ornaments, yellow pitambar, many arms fanned like the universal form.
function buildFigure() {
  const W = 1000, H = 1400, cx = 500, shY = 450;
  const layer = (draw, stops) => {
    const L = makeCanvas(W, H), l = L.getContext('2d');
    l.lineCap = 'round'; l.lineJoin = 'round'; l.fillStyle = l.strokeStyle = '#fff';
    draw(l);
    l.globalCompositeOperation = 'source-in';
    const g = l.createLinearGradient(0, 0, 0, H);
    for (const [o, col] of stops) g.addColorStop(o, col);
    l.fillStyle = g; l.fillRect(0, 0, W, H);
    return L;
  };

  const arms = [];
  for (const side of [-1, 1]) {
    const N = 9;
    for (let k = 0; k < N; k++) {
      const t = k / (N - 1);
      const a1 = (-100 + t * 155) * Math.PI / 180;           // upper arm, from up to down-out
      const a2 = a1 - (40 - t * 20) * Math.PI / 180;           // forearm bends upward
      const sx = cx + side * 105, sy = shY + 10 + t * 30;
      const ex = sx + side * Math.cos(a1) * 175, ey = sy + Math.sin(a1) * 175;
      const hx = ex + side * Math.cos(a2) * 150, hy = ey + Math.sin(a2) * 150;
      arms.push({ side, k, t, sx, sy, ex, ey, hx, hy, main: k === 2 || k === 6 });
    }
  }

  const skin = layer(s => {
    for (const a of arms) {
      s.globalAlpha = a.main ? 1 : 0.82;
      s.lineWidth = 30 - a.t * 4; s.beginPath(); s.moveTo(a.sx, a.sy); s.lineTo(a.ex, a.ey); s.stroke();
      s.lineWidth = 24 - a.t * 4; s.beginPath(); s.moveTo(a.ex, a.ey); s.lineTo(a.hx, a.hy); s.stroke();
      s.beginPath(); s.arc(a.hx, a.hy, 15, 0, Math.PI * 2); s.fill();
    }
    s.globalAlpha = 1;
    s.beginPath();
    s.moveTo(cx - 110, shY); s.quadraticCurveTo(cx, shY - 40, cx + 110, shY);
    s.quadraticCurveTo(cx + 95, 600, cx + 72, 740); s.lineTo(cx - 72, 740);
    s.quadraticCurveTo(cx - 95, 600, cx - 110, shY); s.fill();
    s.fillRect(cx - 32, 340, 64, 100);
    s.beginPath(); s.ellipse(cx, 300, 64, 78, 0, 0, Math.PI * 2); s.fill();
  }, [[0, '#a9c4ff'], [0.25, '#5b86e6'], [0.5, '#2f56b8'], [0.8, '#1d357f']]);

  const cloth = layer(s => {
    s.beginPath();
    s.moveTo(cx - 80, 700); s.lineTo(cx + 80, 700);
    s.quadraticCurveTo(cx + 190, 1050, cx + 215, H); s.lineTo(cx - 215, H);
    s.quadraticCurveTo(cx - 190, 1050, cx - 80, 700); s.fill();
    // angavastram sweeping over the shoulders
    s.lineWidth = 26; s.globalAlpha = 0.9;
    s.beginPath(); s.moveTo(cx - 120, shY + 5); s.bezierCurveTo(cx - 260, 620, cx - 190, 820, cx - 300, 980); s.stroke();
    s.beginPath(); s.moveTo(cx + 120, shY + 5); s.bezierCurveTo(cx + 260, 620, cx + 190, 820, cx + 300, 980); s.stroke();
  }, [[0.45, '#ffe07a'], [0.65, '#e9b21f'], [0.85, '#b57a0c'], [1, 'rgba(120,70,10,0)']]);

  const gold = layer(s => {
    s.beginPath();                                              // kireeta mukuta
    s.moveTo(cx - 72, 262); s.lineTo(cx + 72, 262); s.lineTo(cx + 52, 150); s.lineTo(cx + 30, 70);
    s.lineTo(cx, 20); s.lineTo(cx - 30, 70); s.lineTo(cx - 52, 150); s.closePath(); s.fill();
    s.lineWidth = 7;
    for (let i = 0; i < 3; i++) { s.beginPath(); s.arc(cx, 400 + i * 22, 90 - i * 6, 0.2 * Math.PI, 0.8 * Math.PI); s.stroke(); }
    for (const a of arms) {                                     // armbands and bracelets
      s.lineWidth = 9;
      const bx = a.sx + (a.ex - a.sx) * 0.55, by = a.sy + (a.ey - a.sy) * 0.55;
      s.beginPath(); s.arc(bx, by, 14 - a.t * 2, 0, Math.PI * 2); s.stroke();
      s.beginPath(); s.arc(a.hx + (a.ex - a.hx) * 0.15, a.hy + (a.ey - a.hy) * 0.15, 12, 0, Math.PI * 2); s.stroke();
    }
    s.lineWidth = 6; s.beginPath(); s.moveTo(cx - 92, 718); s.lineTo(cx + 92, 718); s.stroke();   // waist belt
    s.beginPath(); s.arc(cx - 66, 330, 13, 0, Math.PI * 2); s.arc(cx + 66, 330, 13, 0, Math.PI * 2); s.fill(); // makara kundala
  }, [[0, '#fff6d6'], [0.3, '#f6cf6a'], [0.7, '#d79a2b'], [1, '#a8661a']]);

  const shape = makeCanvas(W, H), s = shape.getContext('2d');
  s.drawImage(skin, 0, 0); s.drawImage(cloth, 0, 0); s.drawImage(gold, 0, 0);
  s.lineCap = 'round';
  // vanamala, the long garland of forest flowers
  s.strokeStyle = 'rgba(255,240,220,.85)'; s.lineWidth = 9; s.setLineDash([2, 16]);
  s.beginPath(); s.moveTo(cx - 100, shY + 10); s.quadraticCurveTo(cx, 1050, cx + 100, shY + 10); s.stroke();
  s.setLineDash([]);
  // urdhva pundra tilak
  s.lineWidth = 4; s.strokeStyle = '#fff8e6';
  s.beginPath(); s.moveTo(cx - 14, 236); s.quadraticCurveTo(cx, 285, cx + 14, 236); s.stroke();
  s.strokeStyle = '#ff5a3c'; s.beginPath(); s.moveTo(cx, 240); s.lineTo(cx, 270); s.stroke();
  for (const a of arms) if (a.main) {
    const kind = a.k === 2 ? (a.side > 0 ? 'chakra' : 'shankha') : (a.side > 0 ? 'padma' : 'gada');
    drawSymbol(s, { kind, x: a.hx, y: a.hy - (a.k === 2 ? 30 : 20) });
  }

  // golden aura: a blurred gold copy of the silhouette behind the figure
  const aura = makeCanvas(W, H), ax = aura.getContext('2d');
  ax.drawImage(shape, 0, 0); ax.globalCompositeOperation = 'source-in';
  ax.fillStyle = '#ffc861'; ax.fillRect(0, 0, W, H);
  const c = makeCanvas(W, H), x = c.getContext('2d');
  x.filter = 'blur(22px)'; x.drawImage(aura, 0, 0); x.drawImage(aura, 0, 0);
  x.filter = 'none'; x.drawImage(shape, 0, 0);
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

  const r = deityRect(W, H);
  const hx = r.x + r.w / 2, hy = r.y + r.h * deity.headY;
  const R = r.h * 0.2;

  if (skyArt) drawSkyArt(c, W, H);
  else {
    const D = Math.hypot(W, H) * 1.25;
    c.save(); c.translate(W * 0.5, H * 0.4); c.rotate(t * 0.006); c.globalAlpha = 0.95;
    c.drawImage(nebula, -D / 2, -D / 2, D, D); c.restore();

    for (const s of stars) {
      c.globalAlpha = s.a * (0.55 + 0.45 * Math.sin(t * s.f + s.p));
      c.fillStyle = s.warm ? '#ffe2b0' : '#dfe9ff';
      c.beginPath(); c.arc(s.x, s.y, s.r * Math.max(1, W / 1400), 0, Math.PI * 2); c.fill();
    }
    c.globalAlpha = 1;
    drawPlanets(c, W, H, hx, hy);
  }

  if (settings.figure) drawFigureLayer(c, r, hx, hy, R, W, H, t);
  if (settings.embers) drawEmbers(c, W, H, t);

  // horizon haze so the sky meets the skyline softly
  const hz = c.createLinearGradient(0, H * 0.45, 0, H);
  hz.addColorStop(0, 'rgba(30,60,90,0)'); hz.addColorStop(1, `rgba(120,110,120,${skyArt ? 0.18 : 0.35})`);
  c.fillStyle = hz; c.fillRect(0, 0, W, H);

  // keep only the sky
  c.globalCompositeOperation = 'destination-in';
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  c.drawImage(maskCanvas, 0, 0, W, H);
  c.globalCompositeOperation = 'source-over';
}

function drawFigureLayer(c, r, hx, hy, R, W, H, t) {
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
  vctx.fillStyle = skyArt ? skyArt.tint : 'rgb(176,188,220)'; vctx.fillRect(0, 0, W, H);
  if (settings.figure) {
    // gold light spill from the figure onto the world
    const r = deityRect(W, H);
    const spill = vctx.createRadialGradient(r.x + r.w / 2, r.y + r.h * 0.4, 0, r.x + r.w / 2, r.y + r.h * 0.4, Math.max(W, H));
    spill.addColorStop(0, `rgba(255,190,110,${0.35 * settings.glow})`); spill.addColorStop(1, 'rgba(0,0,0,0)');
    vctx.globalCompositeOperation = 'screen'; vctx.globalAlpha = k;
    vctx.fillStyle = spill; vctx.fillRect(0, 0, W, H);
  }

  vctx.globalCompositeOperation = 'source-over'; vctx.globalAlpha = k;
  vctx.imageSmoothingEnabled = true;
  vctx.drawImage(darkMask, 0, 0, W, H);

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

// ---------- presets: art generated for the app, in assets/ ----------
const PRESETS = [
  { id: 'vishwaroop', label: 'Vishwaroop', figure: 'assets/figure-vishwaroop.webp', headY: 0.19, halo: true },
  { id: 'blackhole', label: 'Black hole', figure: 'assets/figure-vishwaroop-gargantua.webp', headY: 0.3, halo: false },
  { id: 'interstellar', label: 'Interstellar', sky: 'assets/sky-gargantua.webp' },
  { id: 'ksheer-sagar', label: 'Ksheer Sagar', sky: 'assets/sky-cosmic-ocean.webp' },
  { id: 'anantashayana', label: 'Anantashayana', sky: 'assets/sky-anantashayana.webp' },
  { id: 'divine-foot', label: 'Divine foot', sky: 'assets/sky-divine-foot.webp' },
  { id: 'drawn', label: 'Drawn', halo: true },
];
const thumbFor = p => (p.figure || p.sky || '').replace('.webp', '-thumb.jpg');
const imageCache = new Map();
function loadUrl(url) {
  if (!imageCache.has(url)) imageCache.set(url, new Promise((res, rej) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url;
  }));
  return imageCache.get(url);
}

async function applyPreset(id) {
  const p = PRESETS.find(q => q.id === id) || PRESETS[0];
  document.querySelectorAll('#presets button').forEach(b => b.classList.toggle('on', b.dataset.id === p.id));
  try { localStorage.setItem('preset', p.id); } catch (e) {}
  if (p.sky) {
    setSkyArt(prepareSkyArt(await loadUrl(p.sky)));
  } else {
    deity = p.figure ? { ...prepareDeity(await loadUrl(p.figure)), headY: p.headY } : buildFigure();
    setSkyArt(null);
    settings.halo = p.halo; $('#halo').checked = p.halo;
  }
}

function buildPresetBar() {
  const bar = $('#presets');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.dataset.id = p.id;
    b.innerHTML = (p.figure || p.sky ? `<img src="${thumbFor(p)}" alt="">` : '<span class="drawn">✦</span>') + `<span>${p.label}</span>`;
    b.onclick = async () => {
      await applyPreset(p.id);
      try { await kvSet('deity', null); await kvSet('skyart', null); } catch (e) {}
    };
    bar.appendChild(b);
  }
}

// a picture the user loaded wins over the preset, so it survives a reload
async function initArt() {
  buildPresetBar();
  let start = 'vishwaroop';
  try { start = localStorage.getItem('preset') || start; } catch (e) {}
  await applyPreset(start);
  try {
    const d = await kvGet('deity');
    if (d) { deity = prepareDeity(await loadImageFile(d)); setSkyArt(null); }
    const a = await kvGet('skyart');
    if (a) setSkyArt(prepareSkyArt(await loadImageFile(a)));
  } catch (e) { /* storage unavailable */ }
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
    const dx = (cur.x - prev.x) / s, dy = (cur.y - prev.y) / s;
    if (settings.figure) { settings.x += dx / view.width; settings.y += dy / view.height; }
    else if (skyArt) {
      const r = skyArtRect(view.width, view.height), clamp = v => Math.min(1, Math.max(0, v));
      if (Math.abs(view.width - r.w) > 1) settings.artX = clamp(settings.artX + dx / (view.width - r.w));
      if (Math.abs(view.height - r.h) > 1) settings.artY = clamp(settings.artY + dy / (view.height - r.h));
    }
  } else if (pointers.size === 2) {
    pointers.set(e.pointerId, cur);
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const key = settings.figure ? 'size' : 'artScale';
    if (!pinchStart) pinchStart = { dist, size: settings[key] };
    settings[key] = Math.min(4, Math.max(settings.figure ? 0.3 : 1, pinchStart.size * dist / pinchStart.dist));
    if (settings.figure) $('#size').value = settings.size;
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
$('#figure').onchange = e => (settings.figure = e.target.checked);
$('#embers').onchange = e => (settings.embers = e.target.checked);
function setSkyArt(art) {
  skyArt = art;
  Object.assign(settings, { artX: 0.5, artY: 0.12, artScale: 1, figure: !art });
  $('#figure').checked = settings.figure;
  $('#hint').textContent = settings.figure ? 'Drag to move · pinch to resize' : 'Drag to move the sky · pinch to zoom';
}
$('#pickArt').onclick = () => $('#artInput').click();
$('#artInput').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  setSkyArt(prepareSkyArt(await loadImageFile(f)));
  try { await kvSet('skyart', f); } catch (err) { /* keep for this session only */ }
  toast('Sky art loaded');
};
$('#clearArt').onclick = async () => { setSkyArt(null); try { await kvSet('skyart', null); } catch (e) {} };
$('#figure').addEventListener('change', () => setHint());
function setHint() { $('#hint').textContent = settings.figure ? 'Drag to move · pinch to resize' : 'Drag to move the sky · pinch to zoom'; }
$('#showMask').onchange = e => (settings.showMask = e.target.checked);
$('#pickDeity').onclick = () => $('#deityInput').click();
$('#deityInput').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  deity = prepareDeity(await loadImageFile(f));
  try { await kvSet('deity', f); } catch (err) { /* keep for this session only */ }
  toast('Vishnu image loaded');
};
document.addEventListener('click', e => { if (!e.target.closest('#panel, #gear')) $('#panel').classList.remove('open'); });

// for testing in a browser without a camera: ?photo=<url>
const testPhoto = new URLSearchParams(location.search).get('photo');
const testArt = new URLSearchParams(location.search).get('art');
const testPreset = new URLSearchParams(location.search).get('preset');
initArt().then(async () => {
  if (testPreset) await applyPreset(testPreset);
  if (testArt) setSkyArt(prepareSkyArt(await loadImageFile(await (await fetch(testArt)).blob())));
  if (testPhoto) { const r = await fetch(testPhoto); await usePhoto(await r.blob()); }
});
requestAnimationFrame(render);

'use strict';
// Sky Cam: finds the sky in a camera frame or photo and replaces it with another sky:
// an animated cosmos, a painted sky, or any picture the user adds.

const $ = s => document.querySelector(s);
const view = $('#view');
const vctx = view.getContext('2d');
const video = $('#video');

const settings = { intensity: 0.95, size: 0.9, glow: 0.7, showMask: false, x: 0.5, y: 0.97,
  object: true, embers: true, artX: 0.5, artY: 0.12, artScale: 1 };

let source = null;          // { el, w, h, still }
let facing = 'environment';
let stream = null;
let deity = null;           // optional figure in the cosmos: { canvas, blend, headY }, headY = glow centre as a fraction of height
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

// ---------- rendering ----------
function resize(W, H) {
  if (view.width === W && view.height === H) return;
  view.width = W; view.height = H; cosmos.width = W; cosmos.height = H;
  buildStars(W, H);
  maskPrev = null;
}

// Where the figure sits in the frame
function deityRect(W, H) {
  const h = H * settings.size, w = h * (deity ? deity.canvas.width / deity.canvas.height : 0.6);
  const breathe = 1 + Math.sin(performance.now() / 2400) * 0.006;
  const cx = W * settings.x, bottom = H * settings.y;
  return { x: cx - w * breathe / 2, y: bottom - h * breathe, w: w * breathe, h: h * breathe };
}

function drawCosmos(W, H, t) {
  const c = cctx;
  c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.filter = 'none';
  c.fillStyle = '#02030a'; c.fillRect(0, 0, W, H);

  const r = deityRect(W, H);
  const hx = r.x + r.w / 2, hy = r.y + r.h * (deity ? deity.headY : 0.3);
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

  if (settings.object) drawFigureLayer(c, r, hx, hy, R, W, H, t);
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

  if (!deity) return;
  c.save();
  c.globalCompositeOperation = deity.blend;
  c.globalAlpha = 0.96;
  c.drawImage(deity.canvas, r.x, r.y, r.w, r.h);
  c.restore();
}

function render() {
  requestAnimationFrame(render);
  if (!source) return;
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
  if (settings.object) {
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
    $('#photoBtn').classList.remove('camera');
    $('#start').style.display = 'none';
  } catch (e) {
    toast('Camera unavailable: ' + e.message);
  }
}

function loadImageFile(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('This phone could not open that picture. Try a JPG or PNG.'));
    im.src = url;
  });
}

async function usePhoto(file) {
  const im = await loadImageFile(file);
  $('#photoBtn').classList.add('camera');
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
  return { canvas: c, blend, headY: 0.2, transparent };
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

// ---------- skies ----------
// cosmos: the animated nebula; figure: a cut-out painted on top; sky: a full painting
const PRESETS = [
  { id: 'cosmos', label: 'Cosmos', cosmos: true, embers: true },
  { id: 'blackhole', label: 'Black hole', sky: 'assets/sky-blackhole.webp' },
  { id: 'milkyway', label: 'Milky Way', sky: 'assets/sky-milkyway.webp' },
  { id: 'aurora', label: 'Aurora', sky: 'assets/sky-aurora.webp' },
  { id: 'ringed-planet', label: 'Giant planet', sky: 'assets/sky-ringed-planet.webp' },
  { id: 'two-moons', label: 'Two moons', sky: 'assets/sky-two-moons.webp' },
  { id: 'nebula', label: 'Nebula', sky: 'assets/sky-nebula.webp' },
  { id: 'anime-sunset', label: 'Anime sunset', sky: 'assets/sky-anime-sunset.webp' },
  { id: 'starry-night', label: 'Starry Night', sky: 'assets/sky-starry-night.webp' },
  { id: 'storm', label: 'Storm', sky: 'assets/sky-storm.webp' },
  { id: 'pastel', label: 'Pastel', sky: 'assets/sky-pastel.webp' },
  { id: 'vishwaroop', label: 'Vishwaroop', cosmos: true, figure: 'assets/figure-vishwaroop.webp', headY: 0.19, embers: true },
  { id: 'vishnu-blackhole', label: 'Vishnu halo', cosmos: true, figure: 'assets/figure-vishwaroop-gargantua.webp', headY: 0.3, embers: true },
  { id: 'vishnu-space', label: 'Vishnu space', sky: 'assets/sky-gargantua.webp', embers: true },
  { id: 'ksheer-sagar', label: 'Ksheer Sagar', sky: 'assets/sky-cosmic-ocean.webp', embers: true },
  { id: 'anantashayana', label: 'Anantashayana', sky: 'assets/sky-anantashayana.webp', embers: true },
  { id: 'divine-foot', label: 'Divine foot', sky: 'assets/sky-divine-foot.webp' },
];
let userSkies = [];          // [{ id, blob, url }] pictures the user added, kept on the phone in IndexedDB
const imageCache = new Map();
function loadUrl(url) {
  if (!imageCache.has(url)) imageCache.set(url, new Promise((res, rej) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url;
  }));
  return imageCache.get(url);
}

function setSkyArt(art) {
  skyArt = art;
  Object.assign(settings, { artX: 0.5, artY: 0.12, artScale: 1 });
}

function setHint() {
  $('#hint').textContent = settings.object ? 'Drag to move · pinch to resize' : 'Drag to move the sky · pinch to zoom';
}

function markSelected(id) {
  document.querySelectorAll('#presets [data-id]').forEach(b => b.classList.toggle('on', b.dataset.id === id));
  try { localStorage.setItem('preset', id); } catch (e) {}
}

async function applyPreset(id) {
  const user = userSkies.find(u => u.id === id);
  if (user) return applyUserImage(user);
  const p = PRESETS.find(q => q.id === id) || PRESETS[0];
  markSelected(p.id);
  if (p.sky) {
    setSkyArt(prepareSkyArt(await loadUrl(p.sky)));
    settings.object = false;
  } else {
    deity = p.figure ? { ...prepareDeity(await loadUrl(p.figure)), headY: p.headY } : null;
    setSkyArt(null);
    settings.object = true;
  }
  settings.embers = !!p.embers;
  syncControls();
}

// A picture with a transparent background floats in the cosmos; anything else becomes the whole sky.
async function applyUserImage(u) {
  const im = await loadImageFile(u.blob);
  const fig = prepareDeity(im);
  markSelected(u.id);
  if (fig.transparent) {
    deity = fig; setSkyArt(null);
    Object.assign(settings, { object: true, embers: true });
  } else {
    setSkyArt(prepareSkyArt(im));
    Object.assign(settings, { object: false, embers: false });
  }
  syncControls();
}

function syncControls() {
  $('#embers').checked = settings.embers;
  setHint();
}

function chip(id, label, thumb) {
  const b = document.createElement('button');
  b.dataset.id = id;
  b.innerHTML = `<img src="${thumb}" alt=""><span>${label}</span>`;
  b.onclick = () => applyPreset(id).catch(e => toast(e.message));
  return b;
}

function buildPresetBar() {
  const bar = $('#presets');
  bar.querySelectorAll('[data-id]').forEach(b => b.remove());
  for (const u of userSkies) {
    const b = chip(u.id, 'Yours', u.url);
    // long press removes one of your pictures
    let timer;
    b.addEventListener('pointerdown', () => { timer = setTimeout(() => removeUserSky(u.id), 700); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(timer));
    b.addEventListener('contextmenu', e => e.preventDefault());
    bar.appendChild(b);
  }
  for (const p of PRESETS) {
    bar.appendChild(chip(p.id, p.label, (p.figure || p.sky || 'assets/cosmos.webp').replace('.webp', '-thumb.jpg')));
  }
  let current = null;
  try { current = localStorage.getItem('preset'); } catch (e) {}
  if (current) markSelected(current);
}

async function addUserSky(file) {
  try {
    await loadImageFile(file);                                // fail early if the phone cannot read it
    const u = { id: 'user-' + Date.now(), blob: file, url: URL.createObjectURL(file) };
    userSkies.unshift(u);
    buildPresetBar();
    await applyUserImage(u);
    $('#presets').scrollLeft = 0;
    toast('Added. Long-press it to remove.');
    try { await kvSet('userSkies', userSkies.map(({ id, blob }) => ({ id, blob }))); }
    catch (e) { toast('Added for now; this browser will not keep it after a reload.'); }
  } catch (e) {
    toast(e.message);
  }
}

async function removeUserSky(id) {
  if (!confirm('Remove this picture from your skies?')) return;
  userSkies = userSkies.filter(u => u.id !== id);
  buildPresetBar();
  await applyPreset(PRESETS[0].id);
  try { await kvSet('userSkies', userSkies.map(({ id, blob }) => ({ id, blob }))); } catch (e) {}
}

async function initArt() {
  try {
    const saved = (await kvGet('userSkies')) || [];
    userSkies = saved.map(({ id, blob }) => ({ id, blob, url: URL.createObjectURL(blob) }));
  } catch (e) { /* storage unavailable */ }
  buildPresetBar();
  let start = PRESETS[0].id;
  try { start = localStorage.getItem('preset') || start; } catch (e) {}
  try { await applyPreset(start); } catch (e) { await applyPreset(PRESETS[0].id); }
}

// ---------- capture ----------
function capture() {
  if (!source) return;
  view.toBlob(async blob => {
    const name = `sky-cam-${Date.now()}.jpg`;
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
    if (settings.object) { settings.x += dx / view.width; settings.y += dy / view.height; }
    else if (skyArt) {
      const r = skyArtRect(view.width, view.height), clamp = v => Math.min(1, Math.max(0, v));
      if (Math.abs(view.width - r.w) > 1) settings.artX = clamp(settings.artX + dx / (view.width - r.w));
      if (Math.abs(view.height - r.h) > 1) settings.artY = clamp(settings.artY + dy / (view.height - r.h));
    }
  } else if (pointers.size === 2) {
    pointers.set(e.pointerId, cur);
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const key = settings.object ? 'size' : 'artScale';
    if (!pinchStart) pinchStart = { dist, size: settings[key] };
    settings[key] = Math.min(4, Math.max(settings.object ? 0.3 : 1, pinchStart.size * dist / pinchStart.dist));
    if (settings.object) $('#size').value = settings.size;
  }
  pointers.set(e.pointerId, cur);
});
const endPointer = e => { pointers.delete(e.pointerId); pinchStart = null; };
view.addEventListener('pointerup', endPointer);
view.addEventListener('pointercancel', endPointer);

// ---------- wiring ----------
// file inputs are reset after each pick, so choosing the same picture twice still works
function onFile(input, fn) {
  input.onchange = async () => { const f = input.files[0]; input.value = ''; if (f) await fn(f); };
}
$('#startCam').onclick = startCamera;
$('#startPhoto').onclick = () => $('#photoInput').click();
$('#photoBtn').onclick = () => $('#photoBtn').classList.contains('camera') ? startCamera() : $('#photoInput').click();
onFile($('#photoInput'), f => usePhoto(f).catch(e => toast(e.message)));
onFile($('#skyInput'), addUserSky);
$('#flipBtn').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; startCamera(); };
$('#shutter').onclick = capture;
$('#gear').onclick = () => $('#panel').classList.toggle('open');
for (const id of ['intensity', 'size', 'glow']) $('#' + id).oninput = e => (settings[id] = +e.target.value);
$('#embers').onchange = e => (settings.embers = e.target.checked);
$('#showMask').onchange = e => (settings.showMask = e.target.checked);
document.addEventListener('click', e => { if (!e.target.closest('#panel, #gear')) $('#panel').classList.remove('open'); });

// for testing in a browser without a camera: ?photo=<url>&preset=<id>&art=<url>
const params = new URLSearchParams(location.search);
initArt().then(async () => {
  if (params.get('preset')) await applyPreset(params.get('preset'));
  if (params.get('art')) await addUserSky(await (await fetch(params.get('art'))).blob());
  if (params.get('photo')) await usePhoto(await (await fetch(params.get('photo'))).blob());
});
requestAnimationFrame(render);

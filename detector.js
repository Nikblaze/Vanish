// dynamic import so a load failure is reported instead of killing the listener
let FilesetResolver, HandLandmarker, FaceLandmarker, ImageSegmenter;

let hand, face, initErr = null;
const stamps = [];
let lastTs = 0;

async function make(Cls, file, extra) {
  const base = { modelAssetPath: chrome.runtime.getURL('models/' + file), runningMode: 'VIDEO', ...extra };
  try {
    return await Cls.createFromOptions(fileset, { baseOptions: { modelAssetPath: base.modelAssetPath, delegate: 'GPU' }, ...strip(base) });
  } catch (e) {
    console.warn('[TLFX] GPU failed, CPU retry', file, e);
    return await Cls.createFromOptions(fileset, { baseOptions: { modelAssetPath: base.modelAssetPath, delegate: 'CPU' }, ...strip(base) });
  }
}
const strip = ({ modelAssetPath, ...rest }) => rest;
let fileset;
(async () => {
  try {
    ({ FilesetResolver, HandLandmarker, FaceLandmarker, ImageSegmenter } = await import('./vendor/vision_bundle.mjs'));
    fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('vendor/wasm'));
    hand = await make(HandLandmarker, 'hand_landmarker.task', { numHands: 2 });
    face = await make(FaceLandmarker, 'face_landmarker.task', { numFaces: 1 });
    console.log('[TLFX] detector ready');
  } catch (e) {
    initErr = String(e);
    console.error('[TLFX] detector init failed', e);
  }
})();

const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// segmenter: lazy-loaded on first wantMask. selfie_segmenter has a single label ("selfie"), so which output is
// "person" is not documented; pick by data: person mask is brighter in the center third than in the side 10% columns.
let seg, segLoading = false, segLock = false, segIdx = 0, segInv = false;
function ensureSeg() {
  if (seg || segLoading || !fileset) return;
  segLoading = true;
  make(ImageSegmenter, 'selfie_segmenter.tflite', { outputConfidenceMasks: true, outputCategoryMask: false })
    .then((s) => { seg = s; }).catch((e) => console.error('[TLFX] segmenter init failed', e)).finally(() => { segLoading = false; });
}
function segment(bmp, ts) {
  const res = seg.segmentForVideo(bmp, ts);
  const ms = res.confidenceMasks || [];
  try {
    if (!ms.length) return null;
    const w = ms[0].width, h = ms[0].height;
    const arrs = ms.map((m) => m.getAsFloat32Array());
    if (!segLock) {
      const score = (a) => {
        let c = 0, e = 0, nc = 0, ne = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const v = a[y * w + x];
          if (x >= w / 3 && x < (2 * w) / 3) { c += v; nc++; } else if (x < w * 0.1 || x >= w * 0.9) { e += v; ne++; }
        }
        return c / nc - e / ne;
      };
      const sc = arrs.map(score);
      segIdx = sc.indexOf(Math.max(...sc));
      segInv = arrs.length === 1 && sc[0] < 0; // single output that is brighter at the edges = background prob
      if (Math.abs(sc[segIdx]) > 0.3) segLock = true; // decide only once the frame clearly has a person
      console.log('[TLFX] seg mask pick', { n: arrs.length, segIdx, segInv, sc, segLock });
    }
    const a = arrs[Math.min(segIdx, arrs.length - 1)];
    const buf = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < a.length; i++) {
      buf[i * 4] = buf[i * 4 + 1] = buf[i * 4 + 2] = 255;
      buf[i * 4 + 3] = (segInv ? 1 - a[i] : a[i]) * 255;
    }
    return { w, h, buf: buf.buffer };
  } finally {
    for (const m of ms) try { m.close(); } catch {}
  }
}

// Gesture thresholds. Ratios of hand/face size, so scale-invariant. Final tuned values are recorded in README.
const TH = {
  EXT: 1.1,           // finger extended: dist(tip, wrist) > dist(pip, wrist) * EXT
  EXT_MIDDLE: 1.0,    // middle finger uses a looser test (often slightly bent in two-finger poses)
  FOREHEAD_R: 0.35,   // forehead zone radius, fraction of face width (face landmarks 234↔454)
  IT_TIP_R: 1.6,      // INSTANT_TRANSMISSION: both tips within FOREHEAD_R * IT_TIP_R of forehead centre
  GOJO_CROSS: 1.5,    // GOJO crossed: tip order swapped vs knuckles AND tips within palm * GOJO_CROSS
  GOJO_TOGETHER: 0.9, // GOJO together: dist(tip8, tip12) < palm * GOJO_TOGETHER (palm = dist(lm5, lm9))
};

// ar = frame width/height; x is scaled by ar so distances are isotropic (z too, same scale as x).
function prepHand(raw, ar, score) {
  const lm = raw.map((l) => ({ x: l.x * ar, y: l.y, z: l.z * ar }));
  const ext = (tip, pip, k = TH.EXT) => d(lm[tip], lm[0]) > d(lm[pip], lm[0]) * k;
  const e = { i: ext(8, 6), m: ext(12, 10, TH.EXT_MIDDLE), r: ext(16, 14), p: ext(20, 18) };
  return { raw, lm, score, palm: d(lm[5], lm[9]), ext: e, twoUp: e.i && e.m && !e.r && !e.p };
}
const tipMid = (h) => ({ x: (h.raw[8].x + h.raw[12].x) / 2, y: (h.raw[8].y + h.raw[12].y) / 2 });

// Ordered rule list. Two-hand rules are always evaluated before one-hand rules (sorted below) so a two-hand
// pose is never read as a one-hand one. match() returns null or { anchor, anchors? } (normalized frame coords).
// loose() is the hysteresis test used once the gesture is ACTIVE (a looser version of the pose); same return shape.
const RULES = [
  { id: 'INSTANT_TRANSMISSION', hands: 1,
    match(h, F) { if (!h.twoUp) return null; const fz = F.forehead(); if (!fz) return null; const R = fz.r * TH.IT_TIP_R; return d(h.lm[8], fz.c) < R && d(h.lm[12], fz.c) < R ? { anchor: tipMid(h) } : null; },
    loose: (h) => h.twoUp ? { anchor: tipMid(h) } : null },
  { id: 'GOJO', hands: 1,
    match(h) { if (!h.twoUp) return null; const lm = h.lm, t = d(lm[8], lm[12]);
      const crossed = Math.sign(lm[8].x - lm[12].x) !== Math.sign(lm[5].x - lm[9].x) && t < h.palm * TH.GOJO_CROSS;
      return crossed || t < h.palm * TH.GOJO_TOGETHER ? { anchor: tipMid(h) } : null; },
    loose: (h) => h.twoUp ? { anchor: tipMid(h) } : null },
].sort((a, b) => b.hands - a.hands); // stable: two-hand first, otherwise list order

// hands = prepped list, off = Set of disabled ids. Also returns `loose`: hysteresis matches for every enabled rule.
function classify(hands, F, off) {
  if (!hands.length) return { gesture: 'no-hand', loose: {} };
  const run = (rule, fn) => {
    if (rule.hands === 2) {
      if (hands.length < 2) return null;
      const r = fn(hands[0], hands[1], F);
      return r && { ...r, confidence: Math.min(hands[0].score, hands[1].score) };
    }
    for (const h of hands) { const r = fn(h, F); if (r) return { ...r, confidence: h.score }; }
    return null;
  };
  let out = { gesture: 'none' };
  const loose = {};
  for (const rule of RULES) {
    if (off.has(rule.id)) continue;
    if (out.gesture === 'none') {
      const r = run(rule, rule.match);
      if (r) out = { gesture: rule.id, anchor: r.anchor, anchors: r.anchors, confidence: r.confidence };
    }
    const l = run(rule, rule.loose);
    if (l) loose[rule.id] = { anchor: l.anchor, anchors: l.anchors };
  }
  return { ...out, loose };
}

window.addEventListener('message', (event) => {
  const m = event.data;
  if (m?.type !== 'tlfx:frame') return;
  const reply = (o) => event.source.postMessage({ type: 'tlfx:result', ...o }, event.origin);
  const bmp = m.bmp;
  try {
    if (!hand || !face) {
      bmp.close?.();
      return reply(initErr ? { gesture: 'error', error: initErr } : { gesture: 'loading' });
    }
    let ts = performance.now();
    if (ts <= lastTs) ts = lastTs + 1;
    lastTs = ts;
    const hr = hand.detectForVideo(bmp, ts);
    const ar = bmp.width / bmp.height;
    const raws = hr.landmarks || [];
    const hands = raws.map((raw, i) => prepHand(raw, ar, hr.handedness?.[i]?.[0]?.score ?? 1));
    const P = (l) => ({ x: l.x * ar, y: l.y });
    const F = { ar, zones: [], _f: undefined, _fz: undefined,
      face() { if (this._f === undefined) this._f = face.detectForVideo(bmp, ts).faceLandmarks?.[0] || null; return this._f; }, // lazy: only when a rule asks
      forehead() {
        if (this._fz !== undefined) return this._fz;
        const f = this.face();
        if (!f) return (this._fz = null);
        const a = P(f[10]), b = P(f[151]), c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const r = d(P(f[234]), P(f[454])) * TH.FOREHEAD_R;
        this.zones.push({ x: c.x / ar, y: c.y, r, label: 'forehead' }, { x: c.x / ar, y: c.y, r: r * TH.IT_TIP_R, label: 'IT tips' });
        return (this._fz = { c, r });
      } };
    const out = classify(hands, F, new Set(m.off || []));
    let mask = null;
    if (m.wantMask) {
      ensureSeg();
      if (seg) mask = segment(bmp, ts);
    }
    bmp.close();
    const now = performance.now();
    stamps.push(now);
    while (stamps.length && now - stamps[0] > 2000) stamps.shift();
    const fps = Math.round((stamps.length / 2) * 10) / 10;
    const msg = { ...out, fps };
    if (m.debug) { msg.hands = raws.map((raw) => raw.map(({ x, y }) => ({ x, y }))); msg.zones = F.zones; }
    if (mask) msg.mask = mask;
    event.source.postMessage({ type: 'tlfx:result', ...msg }, event.origin, mask ? [mask.buf] : []);
  } catch (e) {
    try { bmp.close(); } catch {}
    reply({ gesture: 'error', error: String(e) });
  }
});

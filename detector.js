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

// ar = frame width/height; x is scaled by ar so distances are isotropic.
function classify(lms, faceLms, ar) {
  const P = (l) => ({ x: l.x * ar, y: l.y });
  let forehead = null, center = null, r = 0;
  if (faceLms) {
    const a = P(faceLms[10]), b = P(faceLms[151]);
    center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    r = d(P(faceLms[234]), P(faceLms[454])) * 0.35;
    forehead = { x: center.x / ar, y: center.y, r: r / ar };
  }
  let tip = null;
  const tipOf = (raw) => ({ x: (raw[8].x + raw[12].x) / 2, y: (raw[8].y + raw[12].y) / 2 });
  for (const t of lms) {
    const lm = t.lm;
    const instant = center && d(lm[8], center) < r * 1.6 && d(lm[12], center) < r * 1.6;
    if (instant) return { gesture: 'INSTANT_TRANSMISSION', forehead, tip: tipOf(t.raw), twoUp: true };
    const palm = d(lm[5], lm[9]);
    const crossed = Math.sign(lm[8].x - lm[12].x) !== Math.sign(lm[5].x - lm[9].x) && d(lm[8], lm[12]) < palm * 1.5;
    const together = d(lm[8], lm[12]) < palm * 0.9;
    if (crossed || together)
      return { gesture: 'GOJO', forehead, tip: tipOf(t.raw), twoUp: true };
    tip ||= tipOf(t.raw);
  }
  return { gesture: 'none', forehead, tip, twoUp: true };
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
    const hands = hr.landmarks || [];
    // twoUp = index+middle extended, ring+pinky curled. Face runs only when some hand is twoUp.
    const up = [];
    for (const raw of hands) {
      const lm = raw.map((l) => ({ x: l.x * ar, y: l.y }));
      const ext = (tip, pip, k = 1.1) => d(lm[tip], lm[0]) > d(lm[pip], lm[0]) * k;
      if (ext(8, 6) && ext(12, 10, 1.0) && !ext(16, 14) && !ext(20, 18)) up.push({ lm, raw });
    }
    let out = { gesture: hands.length ? 'none' : 'no-hand', forehead: null, tip: null, twoUp: false };
    if (up.length) out = classify(up, face.detectForVideo(bmp, ts).faceLandmarks?.[0], ar);
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
    if (m.debug) msg.hands = hands.flat().map(({ x, y }) => ({ x, y }));
    if (mask) msg.mask = mask;
    event.source.postMessage({ type: 'tlfx:result', ...msg }, event.origin, mask ? [mask.buf] : []);
  } catch (e) {
    try { bmp.close(); } catch {}
    reply({ gesture: 'error', error: String(e) });
  }
});

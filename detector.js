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
  LOW_ZONE: 0.25,        // shared: gestures need the wrist above the bottom LOW_ZONE of the frame (no desk/typing hands)
  // ROOM palm normal = (lm5-lm0) x (lm17-lm0) in aspect-corrected 3D. We use |ny| (orientation-agnostic, no handedness
  // needed): palm facing camera puts the normal on z, sideways on x, palm up/down on y. "Tips below MCPs" then
  // separates palm-down (bowl) from palm-up (cup).
  ROOM_EXT: 1.0,         // ROOM: looser finger-extended ratio (fingers are curved down into a bowl)
  ROOM_NY: 0.55,         // ROOM: |palm normal . y| / |normal| — palm plane roughly horizontal (palm down)
  ROOM_NY_LOOSE: 0.4,    // ROOM hysteresis
  ROOM_TIP_DROP: 0.1,    // ROOM: fingertip must be below its MCP by > ROOM_TIP_DROP * hs (curved down)
  ROOM_TIPS_DOWN: 3,     // ROOM: at least this many of index..pinky tips dropped
  ROOM_SPREAD: 1.3,      // ROOM: dist(tip8, tip20) > ROOM_SPREAD * dist(mcp5, mcp17) — fingers fanned
  ROOM_THUMB: 0.5,       // ROOM: thumb spread — dist(tip4, mcp5) > ROOM_THUMB * hs
  SC_TOGETHER: 1.0, // SHADOW_CLONE: index+middle pressed together on each hand: dist(tip8, tip12) < palm * SC_TOGETHER
  SC_PERP_COS: 0.45,// SHADOW_CLONE: |cos| between the two finger directions < this (≈ 63°–117°, a "+")
  SC_AXIS: 0.75,    // SHADOW_CLONE: one pair within ~41° of vertical (|vy|/len > SC_AXIS), the other within ~41° of horizontal
  SC_NEAR: 3,       // SHADOW_CLONE/GOJO: another hand with its wrist within SC_NEAR * hs = seal attempt, so GOJO is blocked
  BK_MAX_EXT: 1,    // BANKAI: a "fist" has at most this many of index..pinky extended (one misread finger tolerated)
  BK_STACK: 0.7,    // BANKAI stacked fists: min(d(h1.idxMCP5, h2.pinkyMCP17), d(h2.lm5, h1.lm17)) < BK_STACK * mean hs
  BK_VERT: 0.6,     // BANKAI stacked fists: palm centres one above the other, |dy| / dist > BK_VERT
  BK_WRIST: 0.7,    // BANKAI wrist grip: other hand's palm centre within BK_WRIST * fist hs of the fist's wrist (lm0)
  BK_NEAR_LOOSE: 3, // BANKAI hysteresis: both hands fist-ish (<= 2 extended), wrists within BK_NEAR_LOOSE * hs
  SC_CROSS: 0.7,    // SHADOW_CLONE: finger-segment midpoints closer than SC_CROSS * mean finger length (crossing near their middles)
};

// ar = frame width/height; x is scaled by ar so distances are isotropic (z too, same scale as x).
function prepHand(raw, ar, score) {
  const lm = raw.map((l) => ({ x: l.x * ar, y: l.y, z: l.z * ar }));
  const ext = (tip, pip, k = TH.EXT) => d(lm[tip], lm[0]) > d(lm[pip], lm[0]) * k;
  const e = { i: ext(8, 6), m: ext(12, 10, TH.EXT_MIDDLE), r: ext(16, 14), p: ext(20, 18) };
  return { raw, lm, score, palm: d(lm[5], lm[9]), hs: d(lm[0], lm[9]), extK: (tip, pip, k) => ext(tip, pip, k), ext: e, twoUp: e.i && e.m && !e.r && !e.p };
}
const tipMid = (h) => ({ x: (h.raw[8].x + h.raw[12].x) / 2, y: (h.raw[8].y + h.raw[12].y) / 2 });
const palmMid = (h) => { const p = [0, 5, 9, 13, 17].map((i) => h.raw[i]); return { x: p.reduce((a, l) => a + l.x, 0) / 5, y: p.reduce((a, l) => a + l.y, 0) / 5 }; };
function roomMetrics(h) {
  if (h._room) return h._room;
  const lm = h.lm, a = { x: lm[5].x - lm[0].x, y: lm[5].y - lm[0].y, z: lm[5].z - lm[0].z }, b = { x: lm[17].x - lm[0].x, y: lm[17].y - lm[0].y, z: lm[17].z - lm[0].z };
  const n = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  return (h._room = {
    ny: Math.abs(n.y) / (Math.hypot(n.x, n.y, n.z) || 1),
    drops: [[8, 5], [12, 9], [16, 13], [20, 17]].filter(([t, m]) => lm[t].y > lm[m].y + TH.ROOM_TIP_DROP * h.hs).length,
    spread: d(lm[8], lm[20]) / (d(lm[5], lm[17]) || 1),
    thumb: d(lm[4], lm[5]) / (h.hs || 1),
    nExt: [[8, 6], [12, 10], [16, 14], [20, 18]].filter(([t, p]) => h.extK(t, p, TH.ROOM_EXT)).length,
    low: h.raw[0].y > 1 - TH.LOW_ZONE });
}
const roomHit = (h) => { const t = [8, 12, 16, 20].map((i) => h.raw[i]).reduce((a, l) => (l.y > a.y ? l : a)); // lowest fingertip
  return { anchor: palmMid(h), anchors: { wrist: { x: h.raw[0].x, y: h.raw[0].y }, mid: { x: h.raw[9].x, y: h.raw[9].y }, tip: { x: t.x, y: t.y } } }; };

// SHADOW_CLONE: two-hand cross seal. fingerSeg = index+middle pair as one segment (knuckle mid -> tip mid), lm space.
// In the seal one hand's middle finger is often hidden behind the other hand, so a hand only needs its index up
// (ring+pinky curled) — `pairish`; at least one hand must be fully twoUp. Hidden middle → index-only segment.
const pairish = (h) => h.ext.i && !h.ext.r && !h.ext.p;
function fingerSeg(h) {
  const lm = h.lm, m = h.ext.m, a = m ? { x: (lm[5].x + lm[9].x) / 2, y: (lm[5].y + lm[9].y) / 2 } : lm[5], b = m ? { x: (lm[8].x + lm[12].x) / 2, y: (lm[8].y + lm[12].y) / 2 } : lm[8];
  const v = { x: b.x - a.x, y: b.y - a.y };
  return { v, len: Math.hypot(v.x, v.y) || 1e-6, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}
function scMetrics(h1, h2) {
  const s1 = fingerSeg(h1), s2 = fingerSeg(h2);
  const vert = (s) => Math.abs(s.v.y) / s.len > TH.SC_AXIS, horiz = (s) => Math.abs(s.v.x) / s.len > TH.SC_AXIS;
  const tog = (h) => !h.ext.m || d(h.lm[8], h.lm[12]) < h.palm * TH.SC_TOGETHER;
  return { ok2: pairish(h1) && pairish(h2) && (h1.twoUp || h2.twoUp),
    tog: tog(h1) && tog(h2),
    cos: Math.abs(s1.v.x * s2.v.x + s1.v.y * s2.v.y) / (s1.len * s2.len),
    axis: (vert(s1) && horiz(s2)) || (vert(s2) && horiz(s1)),
    cross: d(s1.m, s2.m) / ((s1.len + s2.len) / 2),
    len: (s1.len + s2.len) / 2,
    c: { x: (s1.m.x + s2.m.x) / 2, y: (s1.m.y + s2.m.y) / 2 } };
}

// BANKAI: two-handed sword grip. Either two stacked fists, or one fist held out with the other hand gripping its wrist.
const nExt = (h) => +h.ext.i + +h.ext.m + +h.ext.r + +h.ext.p;
const fist = (h) => nExt(h) <= TH.BK_MAX_EXT;
const pcLm = (h) => { const p = [0, 5, 9, 13, 17].map((i) => h.lm[i]); return { x: p.reduce((a, l) => a + l.x, 0) / 5, y: p.reduce((a, l) => a + l.y, 0) / 5 }; };
const up = (h) => palmMid(h).y < 1 - TH.LOW_ZONE;
function bkMetrics(h1, h2, ar) {
  const p1 = pcLm(h1), p2 = pcLm(h2), hs = (h1.hs + h2.hs) / 2, dist = d(p1, p2) || 1e-6;
  // wrist grip: the holding palm must be nearer the fist's wrist than the fist's own palm — rejects interlaced/clasped hands
  const grip = Math.min(...[[h1, h2, p2], [h2, h1, p1]].filter(([f, , po]) => fist(f) && d(po, f.lm[0]) < d(po, pcLm(f))).map(([f, , po]) => d(po, f.lm[0]) / f.hs), Infinity);
  const hi = p1.y < p2.y ? h1 : h2;
  return { fists: +fist(h1) + +fist(h2), hs,
    stack: Math.min(d(h1.lm[5], h2.lm[17]), d(h2.lm[5], h1.lm[17])) / hs,
    vert: Math.abs(p1.y - p2.y) / dist, grip, up: up(h1) && up(h2),
    c: { x: (p1.x + p2.x) / 2 / ar, y: (p1.y + p2.y) / 2 },
    top: { x: (hi.lm[5].x + hi.lm[17].x) / 2 / ar, y: (hi.lm[5].y + hi.lm[17].y) / 2 } };
}

// Ordered rule list. Two-hand rules are always evaluated before one-hand rules (sorted below) so a two-hand
// pose is never read as a one-hand one. match() returns null or { anchor, anchors? } (normalized frame coords).
// loose() is the hysteresis test used once the gesture is ACTIVE (a looser version of the pose); same return shape.
const RULES = [
  { id: 'SHADOW_CLONE', hands: 2,
    match(h1, h2, F) { const m = scMetrics(h1, h2);
      if (m.ok2) F.zones.push({ x: m.c.x / F.ar, y: m.c.y, r: m.len, label: 'SC cos ' + m.cos.toFixed(2) + ' ax ' + +m.axis + ' x ' + m.cross.toFixed(2) + ' tog ' + +m.tog });
      return m.ok2 && m.tog && m.cos < TH.SC_PERP_COS && m.axis && m.cross < TH.SC_CROSS ? { anchor: { x: m.c.x / F.ar, y: m.c.y } } : null; },
    loose(h1, h2, F) { if (!pairish(h1) || !pairish(h2)) return null; const c = scMetrics(h1, h2).c; return { anchor: { x: c.x / F.ar, y: c.y } }; } },
  { id: 'BANKAI', hands: 2,
    match(h1, h2, F) { const m = bkMetrics(h1, h2, F.ar);
      if (m.fists) F.zones.push({ x: m.c.x, y: m.c.y, r: m.hs, label: 'BK st ' + m.stack.toFixed(2) + ' vt ' + m.vert.toFixed(2) + ' gr ' + m.grip.toFixed(2) + ' f ' + m.fists });
      return m.up && ((m.fists === 2 && m.stack < TH.BK_STACK && m.vert > TH.BK_VERT) || m.grip < TH.BK_WRIST) ? { anchor: m.c, anchors: { top: m.top } } : null; },
    loose(h1, h2, F) { const m = bkMetrics(h1, h2, F.ar);
      return m.up && nExt(h1) <= 2 && nExt(h2) <= 2 && d(h1.lm[0], h2.lm[0]) < TH.BK_NEAR_LOOSE * m.hs ? { anchor: m.c, anchors: { top: m.top } } : null; } },
  { id: 'INSTANT_TRANSMISSION', hands: 1,
    match(h, F) { if (!h.twoUp) return null; const fz = F.forehead(); if (!fz) return null; const R = fz.r * TH.IT_TIP_R; return d(h.lm[8], fz.c) < R && d(h.lm[12], fz.c) < R ? { anchor: tipMid(h) } : null; },
    loose: (h) => h.twoUp ? { anchor: tipMid(h) } : null },
  { id: 'GOJO', hands: 1,
    // a second hand close by = a (maybe partly hidden) SHADOW_CLONE seal, never one-hand GOJO
    match(h, F) { if (!h.twoUp || F.hands.some((x) => x !== h && d(x.lm[0], h.lm[0]) < TH.SC_NEAR * h.hs)) return null; const lm = h.lm, t = d(lm[8], lm[12]);
      const crossed = Math.sign(lm[8].x - lm[12].x) !== Math.sign(lm[5].x - lm[9].x) && t < h.palm * TH.GOJO_CROSS;
      return crossed || t < h.palm * TH.GOJO_TOGETHER ? { anchor: tipMid(h) } : null; },
    loose: (h) => h.twoUp ? { anchor: tipMid(h) } : null },
  { id: 'ROOM', hands: 1,
    match(h, F) { const m = roomMetrics(h);
      if (m.nExt >= 3) { const c = palmMid(h); F.zones.push({ x: c.x, y: c.y, r: h.hs, label: 'ROOM ny ' + m.ny.toFixed(2) + ' sp ' + m.spread.toFixed(2) + ' th ' + m.thumb.toFixed(2) + ' dn ' + m.drops }); }
      return !m.low && m.nExt === 4 && m.ny > TH.ROOM_NY && m.drops >= TH.ROOM_TIPS_DOWN && m.spread > TH.ROOM_SPREAD && m.thumb > TH.ROOM_THUMB ? roomHit(h) : null; },
    loose(h) { const m = roomMetrics(h); return !m.low && m.ny > TH.ROOM_NY_LOOSE && m.nExt >= 3 ? roomHit(h) : null; } },
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
    const F = { ar, hands, zones: [], _f: undefined, _fz: undefined,
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

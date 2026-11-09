(() => {
  if (window.__tlfxInstalled) return;
  window.__tlfxInstalled = true;
  // patch prototype: catches MediaDevices.prototype.getUserMedia.call(...) too
  const proto = window.MediaDevices && MediaDevices.prototype;
  if (!proto || !proto.getUserMedia) return;
  const origFn = proto.getUserMedia;
  let patched = 0;
  let last = null;
  let detWin = null, detOrigin = null, busy = false, busyTimer = null;
  const live = new Set(); // all active patched videos; Teams opens/stops several
  let sendErr = '';
  let dbg = null;
  let firstResult = true;
  let sent = 0, det = 'no iframe', ticks = 0, lastAsk = 0, oc = null;
  const log = (...a) => console.log('[TLFX]', ...a);
  const dbgOn = () => window.__tlfxDebug === true;

  // ---------- shared state machine (one, global; every stream's draw loop renders from it) ----------
  const S = { st: 'IDLE', kind: null, t0: 0, lastHold: 0, t1: 0, leaveAt: 0, test: false,
    cand: null, candStart: 0, candLast: 0, tip: { x: 0.5, y: 0.4 }, cx: 0.5, capAt: 0, stepT: 0,
    tc: 0, pc: 0, raw: null, rawAt: 0, sm: null, smId: null, mem: {} };
  let lastRecv = 0, haveMask = false, plateImg = null;
  const maskCv = document.createElement('canvas'), maskHard = document.createElement('canvas');
  try {
    const u = localStorage.getItem('tlfx-plate');
    if (u) { plateImg = new Image(); plateImg.src = u; }
  } catch {}

  const LEAVE_MS = 5000; // hold time from activation to auto-leave
  const ARM_MS = 700, GAP_MS = 1000, CANCEL_MS = 600, TEST_MS = 4000; // gesture held to arm; no-hold gap before cancel; reverse-anim length; preview length
  const ANCHOR_EMA = 0.5; // weight of the newest detector anchor; detector runs ~10 fps at 320 px, EMA removes landmark jitter
  const offSet = new Set(); // disabled gesture ids, persisted in localStorage 'tlfx-off'
  try { const a = JSON.parse(localStorage.getItem('tlfx-off')); if (Array.isArray(a)) for (const x of a) if (typeof x === 'string') offSet.add(x); } catch {}
  const saveOff = () => { try { localStorage.setItem('tlfx-off', JSON.stringify([...offSet])); } catch {} };
  const errSeen = {};
  let firstPatchAt = 0;
  // ---------- debug pill ----------
  let pill, body, open = false;
  function updateDebug() { try { updateDebugInner(); } catch (e) { log('debug ui error', String(e)); } }
  function updateDebugInner() {
    if (!document.body) return;
    if (!dbg) {
      dbg = document.createElement('div');
      dbg.style.cssText = 'position:fixed;left:0;bottom:0;z-index:2147483647;font:11px monospace;color:#fff;pointer-events:none';
      pill = document.createElement('div');
      pill.style.cssText = 'display:inline-block;background:#000;padding:2px 6px;border-radius:0 6px 0 0;cursor:pointer;pointer-events:auto';
      pill.onclick = () => { open = !open; updateDebug(); };
      body = document.createElement('div');
      body.style.cssText = 'background:#000;padding:4px 8px;white-space:pre';
      const btn = document.createElement('button');
      btn.textContent = 'Capture background';
      btn.style.cssText = 'display:block;margin-top:4px;pointer-events:auto;cursor:pointer';
      btn.onclick = () => { S.capAt = performance.now() + 3000; };
      body.append(document.createElement('div'), btn);
      const gh = document.createElement('div'); gh.textContent = 'Gestures'; gh.style.marginTop = '6px'; body.append(gh);
      for (const fx of Object.values(FX)) {
        const lb = document.createElement('label'), cb = document.createElement('input');
        lb.style.cssText = 'display:block;pointer-events:auto;cursor:pointer';
        cb.type = 'checkbox'; cb.checked = !offSet.has(fx.id); cb.style.pointerEvents = 'auto';
        cb.onchange = () => {
          if (cb.checked) offSet.delete(fx.id); else { offSet.add(fx.id); if (S.cand === fx.id) S.cand = null; }
          saveOff(); updateDebug();
        };
        lb.append(cb, document.createTextNode(' ' + fx.label + (fx.needsBackgroundPlate ? ' (uses bg)' : '')));
        body.append(lb);
      }
      dbg.append(body, pill);
      document.body.appendChild(dbg);
    }
    const arming = S.st === 'IDLE' && S.cand;
    const col = S.st === 'ACTIVE' || S.st === 'LEAVING' ? '#f33' : arming || S.st === 'CANCELLING' ? '#fc0' : '#888';
    // Teams enforces Trusted Types: never innerHTML
    pill.textContent = 'TLFX ';
    const dot = document.createElement('span'); dot.textContent = '●'; dot.style.color = col; pill.append(dot);
    body.style.display = open ? 'block' : 'none';
    body.firstChild.textContent = `${label()}\npatched: ${patched} | detector: ${det} | ticks: ${ticks} | sent: ${sent} | live: ${live.size}\nbg: ${plateImg ? 'saved' : 'none'}` + (sendErr ? `\nsend error: ${sendErr}` : '') + (last?.error ? `\nerror: ${last.error}` : '');
  }
  function label() {
    return `TLFX: ${last?.gesture ?? 'waiting'}${last?.confidence != null ? ' ' + last.confidence.toFixed(2) : ''} | ${S.st}${S.cand ? ' cand ' + S.cand : ''}${S.kind ? ' fx ' + S.kind : ''} | fps ${last?.fps ?? 0}`;
  }

  // ---------- leave ----------
  function leaveMeeting() {
    for (const sel of ['#hangup-button', '[data-tid="hangup-main-btn"]', 'button[aria-label="Leave call"]', '[jsname="CQylAd"]', 'button[aria-label^="Leave"]', 'button[aria-label*="Leave"]', '[data-tid*="hangup"]']) {
      const el = [...document.querySelectorAll(sel)].find((x) => x.getClientRects().length);
      if (el) { el.click(); log('leave clicked via', sel); setTimeout(() => { if (S.st === 'LEAVING') { toIdle(); overlay(performance.now()); } }, 2500); return; }
    }
    log('leave button not found');
  }

  // ---------- sound: one shared AudioContext; fxBus -> speakers (0.6) and -> each patched mic stream's mix dest ----------
  let ac, fxBus, mg, srcs = [], mixed = 0;
  function getAC() {
    if (!ac) {
      ac = new AudioContext(); fxBus = ac.createGain();
      // mic flows through this context: if it gets suspended mid-call (sleep/device change), resume at once
      ac.onstatechange = () => { if (ac.state === 'suspended') ac.resume().catch(() => {}); log('audio context', ac.state); };
      const mon = ac.createGain(); mon.gain.value = 0.6; fxBus.connect(mon).connect(ac.destination);
    }
    return ac;
  }
  function sound(kind) {
    try {
      const ac = getAC(); ac.resume(); stopSound();
      const g = mg = ac.createGain(), mine = srcs = [], T = ac.currentTime;
      g.connect(fxBus);
      const go = (n, t, dur) => { n.start(T + t); n.stop(T + t + dur); mine.push(n); return n; };
      const node = (type, v) => { const n = ac.createBiquadFilter(); n.type = type; n.frequency.value = v; return n; };
      const gain = (v, out = g) => { const n = ac.createGain(); n.gain.value = v; n.connect(out); return n; };
      // enveloped oscillator: f0->f1 over dur, gain gn decaying to ~0
      const osc = (type, f0, f1, t, dur, gn, vib) => {
        const o = ac.createOscillator(), n = gain(gn);
        o.type = type; o.frequency.setValueAtTime(f0, T + t); o.frequency.exponentialRampToValueAtTime(f1, T + t + dur);
        n.gain.setValueAtTime(gn, T + t); n.gain.exponentialRampToValueAtTime(0.001, T + t + dur);
        o.connect(n);
        if (vib) { const l = ac.createOscillator(); l.frequency.value = 8; l.connect(gain(vib, o.frequency)); go(l, t, dur); }
        return go(o, t, dur);
      };
      const noise = (t, dur, filt, gn, sweep) => {
        const b = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate), d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const s = ac.createBufferSource(), n = gain(gn);
        s.buffer = b; s.connect(filt).connect(n);
        n.gain.setValueAtTime(gn, T + t); n.gain.exponentialRampToValueAtTime(0.001, T + t + dur);
        if (sweep) { filt.Q.value = 3; filt.frequency.setValueAtTime(sweep[0], T + t); filt.frequency.exponentialRampToValueAtTime(sweep[1], T + t + dur); }
        go(s, t, dur);
      };
      FX[kind].sound({ ac, T, out: g, go, node, gain, osc, noise, holdS: (S.test ? TEST_MS : LEAVE_MS) / 1000 }, 0);
    } catch (e) { log('sound failed', String(e)); }
  }
  function stopSound() {
    const g = mg, s = srcs; mg = null; srcs = [];
    if (!g) return;
    try { const t = ac.currentTime; g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + 0.3); } catch {}
    setTimeout(() => { for (const n of s) { try { n.stop(); } catch {} try { n.disconnect(); } catch {} } try { g.disconnect(); } catch {} }, 350);
  }

  // ---------- local page overlay ----------
  let ov;
  const mk = (css, p) => { const e = document.createElement('div'); e.style.cssText = css; p.appendChild(e); return e; };
  function overlay(now) {
    if (!document.body || (!ov && S.st === 'IDLE' && !S.capAt)) return;
    if (!ov) {
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;font-family:sans-serif;color:#fff;text-align:center';
      ov = {
        r,
        bg: mk('position:absolute;inset:0;opacity:0;transition:opacity .6s;background:radial-gradient(circle at 20% 30%,rgba(123,92,255,.25),transparent 40%),radial-gradient(circle at 80% 70%,rgba(63,208,255,.2),transparent 40%),radial-gradient(circle,rgba(255,255,255,.7) 0 1px,transparent 1.5px) 0 0/90px 90px,radial-gradient(circle,rgba(180,200,255,.5) 0 1px,transparent 1.5px) 40px 55px/130px 130px,rgba(0,0,0,.9)', r),
        flash: mk('position:absolute;inset:0;background:#fff;opacity:0', r),
        cnt: mk('position:absolute;left:0;right:0;bottom:12%;font-size:64px;font-weight:700;text-shadow:0 0 20px #000;display:none', r),
        bar: mk('position:absolute;left:30%;right:30%;bottom:9%;height:6px;background:rgba(255,255,255,.25);border-radius:3px;display:none', r),
        cap: mk('position:absolute;left:0;right:0;top:40%;font-size:56px;font-weight:700;text-shadow:0 0 20px #000;display:none', r),
      };
      ov.fill = mk('height:100%;width:0;background:#fff;border-radius:3px', ov.bar);
      document.body.appendChild(r);
    }
    const act = S.st === 'ACTIVE' || S.st === 'LEAVING';
    ov.bg.style.opacity = act && FX[S.kind]?.localVoid ? 1 : 0;
    ov.cnt.style.display = ov.bar.style.display = act ? 'block' : 'none';
    if (act) {
      const tot = S.test ? TEST_MS : LEAVE_MS, rem = Math.max(0, Math.ceil((tot - (now - S.t0)) / 1000));
      const txt = (S.test ? 'Preview ' : 'Leaving in ') + rem;
      if (ov.cnt.textContent !== txt) ov.cnt.textContent = txt;
      ov.fill.style.width = Math.min(100, ((now - S.t0) / tot) * 100) + '%';
    }
    ov.cap.style.display = S.capAt ? 'block' : 'none';
    if (S.capAt) ov.cap.textContent = 'Step out of frame: ' + Math.max(1, Math.ceil((S.capAt - now) / 1000));
  }

  function capturePlate() {
    const v = [...live].reverse().find((x) => x.readyState >= 2 && x.videoWidth);
    if (!v) return log('capture: no live video');
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const url = c.toDataURL('image/jpeg', 0.85);
    plateImg = new Image(); plateImg.src = url;
    try { localStorage.setItem('tlfx-plate', url); } catch (e) { log('plate not persisted', String(e)); }
    updateDebug();
  }

  // ---------- state transitions ----------
  function setSt(st) { S.st = st; updateDebug(); }
  function activate(kind, now, test) {
    Object.assign(S, { kind, t0: now, lastHold: now, test, cand: null, mem: {} });
    S.tip = { ...((S.raw && now - S.rawAt < 600 && S.raw) || FX[kind].defaultAnchor) };
    setSt('ACTIVE');
    sound(kind);
    overlay(now);
    if (FX[kind].flashOnStart && ov) ov.flash.animate([{ opacity: 0.8 }, { opacity: 0 }], 350);
    log('ACTIVE', kind, test ? '(test)' : '');
  }
  function cancel(now) {
    S.tc = now - S.t0; S.pc = progress(now);
    S.t1 = now;
    stopSound();
    setSt('CANCELLING');
  }
  const ease = (x) => 1 - (1 - x) ** 3;
  function toIdle() { S.gain = 0; setSt('IDLE'); S.kind = null; S.cand = null; S.sm = null; S.smId = null; S.raw = null; haveMask = false; stopSound(); }

  const progress = (now) => S.st === 'LEAVING' ? 1 : S.st === 'CANCELLING' ? S.pc * Math.max(0, 1 - (now - S.t1) / CANCEL_MS)
    : S.st === 'ACTIVE' ? Math.min(1, (now - S.t0) / (S.test ? TEST_MS : LEAVE_MS)) : 0;
  const anchorFor = (r, id) => r.gesture === id ? { anchor: r.anchor, anchors: r.anchors } : r.loose?.[id] || null;
  const ema = (o, n) => { for (const k in n) o[k] += (n[k] - o[k]) * ANCHOR_EMA; };
  function onResult(r, now) {
    lastRecv = now;
    const g = r.gesture, id = S.st === 'IDLE' ? g : S.kind, a = id && FX[id] ? anchorFor(r, id) : null;
    S.raw = a?.anchor || null; S.rawAt = now;
    if (a?.anchor) {
      if (S.smId !== id || !S.sm) { S.sm = { anchor: { ...a.anchor }, anchors: {} }; S.smId = id; for (const k in a.anchors) S.sm.anchors[k] = { ...a.anchors[k] }; }
      else {
        ema(S.sm.anchor, a.anchor);
        for (const k in a.anchors) { const o = S.sm.anchors[k] ||= { ...a.anchors[k] }; ema(o, a.anchors[k]); }
      }
    }
    if (S.st === 'IDLE') {
      if (FX[g] && !offSet.has(g)) {
        if (S.cand !== g || now - S.candLast > 500) { S.cand = g; S.candStart = now; }
        S.candLast = now;
        if (now - S.candStart >= ARM_MS) activate(g, now, false);
      }
    } else if (S.st === 'ACTIVE' && !S.test && (g === S.kind || r.loose?.[S.kind])) S.lastHold = now; // loose = hysteresis
  }

  // driven from every stream's draw loop (guarded so it advances once per frame)
  function step(now) {
    if (now - S.stepT < 8) return;
    S.stepT = now;
    if (S.capAt && now >= S.capAt) { S.capAt = 0; capturePlate(); }
    if (S.st === 'IDLE' && S.cand && now - S.candLast > 500) { S.cand = null; updateDebug(); }
    if (S.st === 'ACTIVE') {
      if (S.test ? now - S.t0 >= TEST_MS : now - S.lastHold > GAP_MS) cancel(now);
      else if (!S.test && now - S.t0 >= LEAVE_MS) { setSt('LEAVING'); S.leaveAt = now; leaveMeeting(); }
    } else if (S.st === 'CANCELLING' && now - S.t1 >= CANCEL_MS) toIdle();
    else if (S.st === 'LEAVING' && now - S.leaveAt >= 2000) { stopSound(); toIdle(); }
    overlay(now);
  }

  // ---------- detector connection (one per frame) ----------
  window.addEventListener('message', (e) => {
    if (detOrigin && e.origin === detOrigin && e.data?.type === 'tlfx:result') {
      last = e.data;
      det = 'replying';
      busy = false;
      clearTimeout(busyTimer);
      if (firstResult) { firstResult = false; log('first result', last.gesture); }
      if (last.error) log('detector error', last.error);
      const m = last.mask;
      if (m) {
        if (maskCv.width !== m.w || maskCv.height !== m.h) { maskCv.width = maskHard.width = m.w; maskCv.height = maskHard.height = m.h; }
        const c = maskCv.getContext('2d');
        c.putImageData(new ImageData(new Uint8ClampedArray(m.buf), m.w, m.h), 0, 0);
        // dilate/harden at mask resolution (union of two blurred copies), cheaper than at full res
        const h = maskHard.getContext('2d');
        h.clearRect(0, 0, m.w, m.h); h.filter = 'blur(2px)';
        h.drawImage(maskCv, 0, 0); h.drawImage(maskCv, 0, 0); h.filter = 'none';
        haveMask = true;
        let sx = 0, sa = 0;
        const u8 = new Uint8ClampedArray(m.buf);
        for (let i = 3, n = 0; i < u8.length; i += 4, n++) { sx += (n % m.w) * u8[i]; sa += u8[i]; }
        if (sa > 255 * 50) S.cx = sx / sa / m.w;
        delete last.mask;
      }
      onResult(last, performance.now());
      updateDebug();
    }
  });

  const needDetector = () => window.postMessage({ type: 'tlfx:need-detector' }, '*');

  // called from the per-stream draw loop: a document_start setInterval gets killed by Teams boot
  function sendTick() {
    if (!live.size) return;
    ticks++;
    const f = document.getElementById('tlfx-detector');
    if (!f) {
      det = 'no iframe'; detWin = null;
      const n = performance.now();
      // ponytail: fixed 4s delay so wasm/model load doesn't compete with Teams joining
      if (n - firstPatchAt > 4000 && n - lastAsk > 1000) { lastAsk = n; needDetector(); }
      if (ticks % 12 === 0) updateDebug();
      return;
    }
    detWin = f.contentWindow;
    detOrigin = new URL(f.src).origin;
    if (det === 'no iframe') { det = 'iframe'; log('detector iframe found', f.src); }
    if (ticks % 12 === 0) updateDebug();
    const v = [...live].reverse().find((x) => x.readyState >= 2 && x.videoWidth);
    if (!detWin || busy || !v) return;
    busy = true;
    busyTimer = setTimeout(() => { busy = false; }, 1000);
    try {
      // sync capture: OffscreenCanvas + transferToImageBitmap (createImageBitmap(video) can hang)
      const w = 320, h = Math.round(320 * v.videoHeight / v.videoWidth);
      if (!oc || oc.height !== h) oc = new OffscreenCanvas(w, h);
      oc.getContext('2d').drawImage(v, 0, 0, w, h);
      const bmp = oc.transferToImageBitmap();
      // mask also while arming so the segmenter is loaded by activation
      const k = S.st === 'IDLE' ? S.cand : S.kind, wantMask = !!(k && FX[k]?.needsMask);
      detWin.postMessage({ type: 'tlfx:frame', bmp, t: performance.now(), wantMask, debug: dbgOn(), off: [...offSet] }, detOrigin, [bmp]);
      sent++;
    } catch (err) {
      busy = false;
      sendErr = String(err);
      log('frame send error', sendErr);
      updateDebug();
    }
  }

  function drawDebug(ctx, w, h) {
    const fs = Math.round(h / 18);
    ctx.font = `bold ${fs}px monospace`;
    const text = label();
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(10, 10, ctx.measureText(text).width + 20, fs * 1.6);
    ctx.fillStyle = '#0f0';
    ctx.textBaseline = 'top';
    ctx.fillText(text, 20, 10 + fs * 0.3);
    if (!last) return;
    const g = Object.keys(last.loose || {});
    if (g.length) { ctx.font = `${Math.round(h / 30)}px monospace`; ctx.fillStyle = '#0f0'; ctx.fillText('loose: ' + g.join(' '), 20, 10 + fs * 1.7); }
    const BONES = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [5, 9, 10, 11, 12], [9, 13, 14, 15, 16], [13, 17, 18, 19, 20], [0, 17]];
    (last.hands || []).forEach((hd, i) => {
      ctx.strokeStyle = ctx.fillStyle = ['#f0f', '#0ff'][i % 2]; ctx.lineWidth = 2;
      for (const b of BONES) { ctx.beginPath(); b.forEach((j, n) => ctx[n ? 'lineTo' : 'moveTo'](hd[j].x * w, hd[j].y * h)); ctx.stroke(); }
      for (const p of hd) { ctx.beginPath(); ctx.arc(p.x * w, p.y * h, 4, 0, 7); ctx.fill(); }
    });
    ctx.font = `${Math.round(h / 40)}px monospace`; ctx.textBaseline = 'bottom';
    for (const z of last.zones || []) {
      ctx.strokeStyle = ctx.fillStyle = '#ff0'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(z.x * w, z.y * h, z.r * h, 0, 7); ctx.stroke();
      if (z.label) ctx.fillText(z.label, z.x * w, z.y * h - z.r * h);
    }
    ctx.textBaseline = 'top';
    if (S.st !== 'IDLE' && S.sm) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(S.sm.anchor.x * w, S.sm.anchor.y * h, 8, 0, 7); ctx.stroke();
    }
  }

  // ---------- effects (procedural canvas 2D) ----------
  const mkRnd = (s) => () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rnd = mkRnd(42);
  const STARS = Array.from({ length: 200 }, () => ({ a: rnd() * 6.283, s: 0.3 + rnd() * 0.7, p: rnd() }));
  const glow = (ctx, x, y, r, c0, c1 = 'rgba(0,0,0,0)') => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  // mean luminance of the top 25% corners (rarely the person) of src, sampled at 32x18
  const lumCv = new OffscreenCanvas(32, 18), lumCtx = lumCv.getContext('2d', { willReadFrequently: true });
  function lum(src) {
    lumCtx.drawImage(src, 0, 0, 32, 18);
    const d = lumCtx.getImageData(0, 0, 32, 5).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const x = (i / 4) % 32; if (x < 8 || x >= 24) { sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; n++; } }
    return sum / n;
  }
  // e = {kind, t (ms since activation) | null, te (ms since cancel) | null, a0}
  function fxIT(ctx, w, h, video, tmp, e, now) {
    const t = e.t, tc = tmp.getContext('2d');
    const tip = (e.t != null && e.raw) || S.tip;
    let v = 0, flick = false;
    if (t != null) { if (t >= 1200) v = 1; else if (t >= 600) { flick = true; v = Math.floor(t / 70) % 2; } }
    else if (e.a0) { flick = true; v = Math.floor(e.te / 70) % 2 && e.te < 540 ? 1 : 0; }
    const layer = (src, masked) => { // src (or plate) restricted to the person mask, into tmp
      tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, w, h);
      if (src) tc.drawImage(src, 0, 0, w, h); // caller may set tc.filter (brightness)
      else { tc.filter = 'blur(40px)'; tc.drawImage(video, 0, 0, w, h); tc.filter = 'none'; } // no plate: blurred camera
      if (masked) { tc.globalCompositeOperation = 'destination-in'; tc.drawImage(maskHard, 0, 0, w, h); tc.globalCompositeOperation = 'source-over'; }
    };
    if (v) {
      const plate = plateImg?.complete && plateImg.naturalWidth ? plateImg : null;
      if (plate && !S.gain) S.gain = lum(video) / Math.max(1, lum(plate)); // match camera auto-exposure
      if (plate) tc.filter = `brightness(${S.gain || 1})`;
      // fully vanished: whole plate, no mask seam/shadow. Flicker phase: masked cutout.
      layer(plate, haveMask && !(t != null && t >= 1200));
      tc.filter = 'none';
      ctx.drawImage(tmp, 0, 0);
    }
    if (flick) for (let i = 0; i < 6; i++) { // scanline offset bands
      const y = Math.random() * h, bh = h * (0.02 + 0.05 * Math.random());
      ctx.drawImage(ctx.canvas, 0, y, w, bh, (Math.random() - 0.5) * w * 0.08, y, w, bh);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (t != null && t >= 1200 && t < 1600 && haveMask) { // afterimage
      layer(video, true);
      ctx.globalAlpha = 0.3 * (1 - (t - 1200) / 400); ctx.drawImage(tmp, 0, 0);
    }
    ctx.globalAlpha = 1;
    if (t != null && t < 1200) {
      ctx.fillStyle = `rgba(255,255,255,${0.08 * Math.random()})`; ctx.fillRect(0, 0, w, h); // brightness flicker
      const a = t < 600 ? 1 : Math.max(0, 1 - (t - 600) / 300), ox = tip.x * w, oy = tip.y * h;
      if (a > 0) {
        const r = h * 0.14 * (1 + 0.2 * Math.sin(now / 50)) * (0.6 + 0.4 * Math.min(t / 300, 1));
        glow(ctx, ox, oy, r, `rgba(255,255,255,${0.9 * a})`, 'rgba(0,200,255,0)');
        glow(ctx, ox, oy, r * 0.5, `rgba(180,255,255,${a})`);
        ctx.strokeStyle = `rgba(200,255,255,${a})`; ctx.lineWidth = 2;
        for (let i = 0; i < 8; i++) {
          const an = Math.random() * 6.283, r0 = r * 0.5, r1 = r * (0.9 + Math.random() * 0.8);
          ctx.beginPath(); ctx.moveTo(ox + Math.cos(an) * r0, oy + Math.sin(an) * r0); ctx.lineTo(ox + Math.cos(an) * r1, oy + Math.sin(an) * r1); ctx.stroke();
        }
      }
    }
    if (t != null && t >= 1000 && t < 1350) { // collapsing vertical light line at the person's center
      const p = Math.min((t - 1000) / 150, 1), wd = w * 0.2 * (1 - p) + 3, x = S.cx * w;
      ctx.globalAlpha = t < 1200 ? 1 : 1 - (t - 1200) / 150;
      ctx.shadowColor = '#3fd0ff'; ctx.shadowBlur = 30; ctx.fillStyle = '#fff';
      ctx.fillRect(x - wd / 2, 0, wd, h);
    }
    ctx.restore();
  }

  function fxGojo(ctx, w, h, video, e, now) {
    const f = e.t != null ? ease(Math.min(e.t / 900, 1)) : e.a0 * (1 - e.te / 600);
    const ox = S.tip.x * w, oy = S.tip.y * h, R = Math.hypot(Math.max(ox, w - ox), Math.max(oy, h - oy)) * 1.02, r = f * R;
    if (r < 1) return;
    const cx = w / 2, cy = h / 2, full = f >= 1;
    ctx.save();
    if (!full) { ctx.beginPath(); ctx.arc(ox, oy, r, 0, 7); ctx.clip(); }
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.save(); // nebula
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(cx, cy); ctx.rotate(now / 9000);
    for (let i = 0; i < 4; i++) {
      const an = i * 1.57 + 0.4;
      glow(ctx, Math.cos(an) * h * 0.3, Math.sin(an) * h * 0.3, h * 0.45, i % 2 ? 'rgba(63,208,255,.16)' : 'rgba(123,92,255,.2)');
    }
    ctx.restore();
    ctx.globalAlpha = 0.12; ctx.filter = 'grayscale(1) brightness(0.6)'; // person, faint
    ctx.drawImage(video, 0, 0, w, h);
    ctx.filter = 'none'; ctx.globalAlpha = 1;
    const maxR = Math.hypot(cx, cy);
    for (const s of STARS) { // radial star streaks
      const u = (s.p + now * s.s * 0.00025) % 1, d = u * u * maxR, c = Math.cos(s.a), n = Math.sin(s.a);
      ctx.strokeStyle = `rgba(200,220,255,${u})`; ctx.lineWidth = 0.5 + u * 2;
      ctx.beginPath(); ctx.moveTo(cx + c * d * 0.9, cy + n * d * 0.9); ctx.lineTo(cx + c * d, cy + n * d); ctx.stroke();
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glow(ctx, cx, cy, h * 0.12 * (1 + 0.15 * Math.sin(now / 200)), 'rgba(255,255,255,.95)', 'rgba(63,208,255,0)');
    ctx.restore();
    ctx.restore();
    if (!full) { // glowing edge ring with chromatic jitter
      const j = (1 - f) * 8 * (Math.random() - 0.5);
      ctx.save(); ctx.lineWidth = 6; ctx.shadowBlur = 25;
      for (const [c, dx] of [['#7b5cff', j], ['#3fd0ff', -j]]) {
        ctx.strokeStyle = ctx.shadowColor = c;
        ctx.beginPath(); ctx.arc(ox + dx, oy, r, 0, 7); ctx.stroke();
      }
      ctx.restore();
    }
  }

  // ROOM timeline (p = progress 0→1 over the hold; reversed on cancel):
  //  charge 0–0.40   rotating ring of air/dust particles under the palm
  //  build  0.40–0.85 translucent cyan dome forms under the palm (0.40–0.55), then expands past the frame (0.55–0.85):
  //                  cool tint inside, bright rim, faint lattice, ring-shaped distortion at the rim
  //  climax 0.85–1.0 frame cut into a tile grid; tiles split (q 0–.35), user tiles swap with other tiles and the vacated
  //                  homes show the background plate (q .35–.6), scattered user tiles flip to plate (q .6–.75), all tiles
  //                  drift apart into black (q .75–1)
  //  end    p = 1    black frame while Leave is clicked
  const seg = (p, a, b) => Math.min(1, Math.max(0, (p - a) / (b - a)));
  const ROOM_COLS = 6, ROOM_ROWS = 4;
  const ROOM_PTS = Array.from({ length: 140 }, (_, i) => ({ a0: rnd() * 6.283, j: 0.85 + rnd() * 0.3, sz: 1.5 + rnd() * 2, sp: 0.7 + rnd() * 0.8, L: [0.7, 1, 1.3][i % 3] }));
  let roomLat = null;
  function roomLattice() { // unit sphere wireframe, rendered once
    if (roomLat) return roomLat;
    try { roomLat = new OffscreenCanvas(512, 512); } catch { roomLat = document.createElement('canvas'); roomLat.width = roomLat.height = 512; }
    const c = roomLat.getContext('2d');
    c.strokeStyle = 'rgba(170,240,255,0.5)'; c.lineWidth = 2;
    c.beginPath(); c.arc(256, 256, 250, 0, 7); c.stroke();
    for (let k = 0; k <= 6; k++) { c.beginPath(); c.ellipse(256, 256, 250 * Math.cos(k * Math.PI / 14), 250, 0, 0, 7); c.stroke(); }
    for (let j = 1; j <= 6; j++) for (const sg of [-1, 1]) {
      const dy = 250 * Math.sin(j * Math.PI / 14) * sg, hw = Math.sqrt(250 * 250 - dy * dy);
      c.beginPath(); c.moveTo(256 - hw, 256 + dy); c.lineTo(256 + hw, 256 + dy); c.stroke();
    }
    return roomLat;
  }
  function roomBuild(f, W, H, m) { // one-off per climax: plate, frozen frame, per-tile user flags, swap pairs
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    const plate = mk(), pc = plate.getContext('2d');
    if (plateImg?.complete && plateImg.naturalWidth) { pc.filter = `brightness(${lum(f.video) / Math.max(1, lum(plateImg))})`; pc.drawImage(plateImg, 0, 0, W, H); }
    else { pc.filter = 'blur(30px)'; pc.drawImage(f.video, 0, 0, W, H); }
    pc.filter = 'none';
    const src = mk(); src.getContext('2d').drawImage(f.video, 0, 0, W, H);
    for (const c of [pc, src.getContext('2d')]) { // keep the dome's cool tint so the dome→tiles cut doesn't pop
      c.fillStyle = 'rgba(70,190,255,0.13)'; c.fillRect(0, 0, W, H);
      c.globalCompositeOperation = 'multiply'; c.fillStyle = 'rgba(0,40,80,0.12)'; c.fillRect(0, 0, W, H); c.globalCompositeOperation = 'source-over';
    }
    const n = ROOM_COLS * ROOM_ROWS, user = [];
    let md = null;
    if (haveMask) { const mw = maskHard.width, mh = maskHard.height, t = document.createElement('canvas'); t.width = mw; t.height = mh; const tc = t.getContext('2d'); tc.drawImage(maskHard, 0, 0); md = tc.getImageData(0, 0, mw, mh).data; }
    for (let i = 0; i < n; i++) {
      const c = i % ROOM_COLS, r = Math.floor(i / ROOM_COLS);
      if (md) {
        const mw = maskHard.width, mh = maskHard.height, x0 = Math.floor(c * mw / ROOM_COLS), x1 = Math.max(x0 + 1, Math.floor((c + 1) * mw / ROOM_COLS)), y0 = Math.floor(r * mh / ROOM_ROWS), y1 = Math.max(y0 + 1, Math.floor((r + 1) * mh / ROOM_ROWS));
        let sum = 0, cnt = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += md[(y * mw + x) * 4 + 3]; cnt++; }
        user[i] = sum / cnt / 255 > 0.25;
      } else user[i] = r >= 1 && Math.abs((c + 0.5) / ROOM_COLS - S.cx) < 0.18;
    }
    const r7 = mkRnd(7), idx = [...Array(n).keys()];
    const shuf = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r7() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const pair = Array(n).fill(-1), non = shuf(idx.filter((i) => !user[i]));
    for (const i of idx.filter((i) => user[i])) {
      if (pair[i] >= 0) continue;
      let j = non.pop();
      if (j === undefined) j = idx.find((k) => k !== i && pair[k] < 0);
      if (j === undefined) continue;
      pair[i] = j; pair[j] = i;
    }
    const rest = shuf(idx.filter((i) => pair[i] < 0));
    while (rest.length > 1) { const a = rest.pop(), b = rest.pop(); pair[a] = b; pair[b] = a; }
    const rot = idx.map(() => (r7() - 0.5)), dir = idx.map((i) => {
      let dx = ((i % ROOM_COLS) + 0.5) / ROOM_COLS - 0.5, dy = (Math.floor(i / ROOM_COLS) + 0.5) / ROOM_ROWS - 0.5;
      if (!dx && !dy) { const an = r7() * 6.283; dx = Math.cos(an); dy = Math.sin(an); }
      const l = Math.hypot(dx, dy); return { x: dx / l, y: dy / l };
    });
    Object.assign(m, { W, H, plate, src, user, pair, rot, dir, tiles: true });
  }
  function fxRoom(ctx, f, p, a, s) {
    const W = f.w, H = f.h, now = f.now;
    if (p <= 0) return;
    if (p >= 1) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); return; }
    if (p >= 0.85) return roomClimax(ctx, f, seg(p, 0.85, 1), s.mem);
    const P = { x: a.x * W, y: a.y * H }, wr = s.anchors.wrist, md = s.anchors.mid;
    const hs = Math.min(H * 0.3, Math.max(H * 0.06, wr && md ? Math.hypot((md.x - wr.x) * W, (md.y - wr.y) * H) : H * 0.12));
    const rx = hs * (1.4 + 1.0 * ease(seg(p, 0, 0.4))), ry = rx * 0.32, tip = s.anchors.tip;
    const C = { x: P.x, y: Math.max(P.y + 0.9 * hs, tip ? tip.y * H + ry * 1.3 + 0.15 * hs : 0) }; // ring sits below the fingertips
    const Rmax = Math.hypot(Math.max(C.x, W - C.x), Math.max(C.y, H - C.y)) * 1.05;
    if (p < 0.6) { // charge: fast air vortex — 3 orbit layers of dust streaks, thick wind arcs, haze
      const al = seg(p, 0, 0.08) * (1 - seg(p, 0.5, 0.6)), w = now * 0.012;
      if (al > 0) {
        ctx.save();
        ctx.save(); ctx.translate(C.x, C.y); ctx.scale(1, 0.32); glow(ctx, 0, 0, rx * 1.15, `rgba(190,235,255,${0.2 * al})`); ctx.restore();
        ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
        for (let k = 0; k < 6; k++) { // wind arcs, alternating layers
          const L = [0.8, 1.15][k % 2], st = w * (k % 2 ? 0.8 : 1.25) + k * 1.047;
          ctx.strokeStyle = `rgba(120,210,255,${0.15 * al})`; ctx.lineWidth = 10; ctx.beginPath(); ctx.ellipse(C.x, C.y, rx * L, ry * L, 0, st, st + 1.6); ctx.stroke();
          ctx.strokeStyle = `rgba(215,245,255,${0.55 * al})`; ctx.lineWidth = 2.5; ctx.stroke();
        }
        for (const q of ROOM_PTS) { // dust streaks: short arcs along the orbit, back half dimmer
          const an = q.a0 + w * q.sp * (1.6 - q.L * 0.6), sn = Math.sin(an);
          ctx.strokeStyle = `rgba(215,245,255,${al * (sn > 0 ? 0.95 : 0.35)})`; ctx.lineWidth = q.sz;
          ctx.beginPath(); ctx.ellipse(C.x, C.y, rx * q.L * q.j, ry * q.L * q.j, 0, an - 0.22, an); ctx.stroke();
        }
        ctx.restore();
      }
    }
    if (p < 0.4) return;
    const form = seg(p, 0.4, 0.55), grow = ease(seg(p, 0.55, 0.85)), A = form;
    const R = hs * 1.2 * (0.3 + 0.7 * form) + (Rmax - hs * 1.2) * grow;
    ctx.save();
    if (grow > 0 && R < Rmax) { // ring-shaped lens distortion at the rim
      const band = Math.max(12, R * 0.06);
      ctx.save();
      ctx.beginPath(); ctx.arc(C.x, C.y, R + band, 0, 7); ctx.moveTo(C.x + Math.max(0, R - band), C.y); ctx.arc(C.x, C.y, Math.max(0, R - band), 0, 7);
      ctx.clip('evenodd');
      ctx.translate(C.x, C.y); ctx.scale(1.035, 1.035); ctx.translate(-C.x, -C.y);
      ctx.drawImage(ctx.canvas, 0, 0);
      ctx.restore();
    }
    ctx.save(); // inside: cool tint + lattice
    ctx.beginPath(); ctx.arc(C.x, C.y, R, 0, 7); ctx.clip();
    ctx.fillStyle = `rgba(70,190,255,${0.13 * A})`; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = `rgba(0,40,80,${0.12 * A})`; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 0.35 * A;
    ctx.translate(C.x, C.y); ctx.rotate(now * 0.0002);
    ctx.drawImage(roomLattice(), -R, -R, 2 * R, 2 * R);
    ctx.restore();
    if (R < Rmax) { // rim, no shadowBlur
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(80,210,255,${0.25 * A})`; ctx.lineWidth = 10; ctx.beginPath(); ctx.arc(C.x, C.y, R, 0, 7); ctx.stroke();
      ctx.strokeStyle = `rgba(220,250,255,${0.9 * A})`; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(C.x, C.y, R, 0, 7); ctx.stroke();
    }
    ctx.restore();
  }
  function roomClimax(ctx, f, q, m) {
    const W = f.w, H = f.h, now = f.now;
    if (!m.tiles || m.W !== W || m.H !== H) roomBuild(f, W, H, m);
    const { plate, src, user, pair, rot, dir } = m, tw = W / ROOM_COLS, th = H / ROOM_ROWS;
    const sp = ease(seg(q, 0, 0.35)), sw = ease(seg(q, 0.35, 0.6)), fl = seg(q, 0.6, 0.75), dr = seg(q, 0.75, 1);
    const hc = (i) => ({ x: ((i % ROOM_COLS) + 0.5) * tw, y: (Math.floor(i / ROOM_COLS) + 0.5) * th });
    const tile = (img, si, pos, rt, sx, dst, i) => { // draw source tile si centred at pos with split/drift transform
      const jx = Math.sin(now * 0.05 + i * 7) * 2 * sp, jy = Math.cos(now * 0.043 + i * 3) * 2 * sp, k = dr * dr * 0.8 * Math.max(W, H), sc = 1 - 0.4 * dr, ins = 3 * sp;
      ctx.save(); ctx.globalAlpha = 1 - dr;
      ctx.translate(pos.x + jx + dir[dst].x * k, pos.y + jy + dir[dst].y * k); ctx.rotate(rt + rot[i] * 0.15 * sp + rot[i] * dr * 2); ctx.scale(sx * sc, sc);
      ctx.drawImage(img, (si % ROOM_COLS) * tw, Math.floor(si / ROOM_COLS) * th, tw, th, -tw / 2 + ins, -th / 2 + ins, tw - 2 * ins, th - 2 * ins);
      ctx.restore();
    };
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const n = ROOM_COLS * ROOM_ROWS;
    if (q >= 0.35 && q < 1) for (let k = 0; k < n; k++) if (user[k]) tile(plate, k, hc(k), 0, 1, k, k); // vacated homes show the background
    for (let i = 0; i < n; i++) {
      const j = pair[i], a = hc(i), b = j >= 0 ? hc(j) : a, dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, arc = Math.sin(Math.PI * sw) * 0.15 * H;
      const pos = { x: a.x + dx * sw - dy / l * arc, y: a.y + dy * sw + dx / l * arc };
      const dst = sw >= 1 && j >= 0 ? j : i;
      if (user[i] && fl > 0.5) tile(plate, j >= 0 ? j : i, pos, rot[i] * Math.sin(Math.PI * sw), Math.abs(Math.cos(Math.PI * fl)), dst, i);
      else tile(src, i, pos, rot[i] * Math.sin(Math.PI * sw), user[i] ? Math.abs(Math.cos(Math.PI * fl)) : 1, dst, i);
    }
    const la = 0.8 * Math.sin(Math.PI * seg(q, 0, 0.35));
    if (la > 0.01) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = `rgba(220,250,255,${la})`; ctx.lineWidth = 2; ctx.beginPath();
      for (let c = 1; c < ROOM_COLS; c++) { ctx.moveTo(c * tw, 0); ctx.lineTo(c * tw, H); }
      for (let r = 1; r < ROOM_ROWS; r++) { ctx.moveTo(0, r * th); ctx.lineTo(W, r * th); }
      ctx.stroke(); ctx.restore();
    }
  }
  function soundRoom(b) {
    const { ac, T, out, go, node, gain, osc, noise, holdS } = b, at = (p) => p * holdS;
    const nb = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const wind = ac.createBufferSource(), bp = node('bandpass', 500), env = gain(0, out), lfo = ac.createOscillator();
    wind.buffer = nb; wind.loop = true; bp.Q.value = 1.2; wind.connect(bp).connect(env);
    env.gain.setValueAtTime(0, T); env.gain.linearRampToValueAtTime(0.38, T + at(0.25)); env.gain.setValueAtTime(0.38, T + at(0.6)); env.gain.linearRampToValueAtTime(0.0001, T + at(0.9));
    lfo.frequency.value = 2.2; lfo.connect(gain(350, bp.frequency)); // fast swirl
    go(wind, 0, at(0.92)); go(lfo, 0, at(0.92));
    osc('sine', 75, 42, at(0.55), 1.4, 0.5); osc('triangle', 150, 90, at(0.55), 1.0, 0.12);
    noise(at(0.55), 1.2, node('lowpass', 300), 0.35);
    for (let i = 0; i < 10; i++) { const t = at(0.85 + i * 0.012); noise(t, 0.035, node('bandpass', 4500 + i * 300), 0.45); osc('square', 3200, 1600, t, 0.04, 0.06); }
    osc('sine', 90, 40, at(0.98), 0.5, 0.35);
  }

  // SHADOW_CLONE timeline (p 0→1 over the hold; reversed on cancel):
  //  charge 0–0.40   smoke puffs pop and leave silhouette copies of the user (clones 1–3 at p .10/.20/.30)
  //  build  0.40–0.85 copies multiply (clones 4–6 at p .45/.55/.65), gentle sway
  //  climax 0.85–1.0 every clone and the real user burst into smoke at once (p .86); smoke clears to the empty background
  //  end    p = 1    full background plate (user gone) while Leave is clicked
  // Pure function of p (now only for sway / puff wobble) so cancel replays backwards.
  const CLONES = [ { dx: -0.14, dy: -0.03, sc: 0.75, t: 0.30 }, { dx: 0.14, dy: -0.03, sc: 0.75, t: 0.65 }, { dx: -0.28, dy: 0.01, sc: 0.88, t: 0.10 }, { dx: 0.28, dy: 0.01, sc: 0.88, t: 0.20 }, { dx: -0.42, dy: 0.04, sc: 1.0, t: 0.45 }, { dx: 0.42, dy: 0.04, sc: 1.0, t: 0.55 } ]; // back→front
  const PUFF_DUR = 0.07, BURST_AT = 0.86, BURST_DUR = 0.12;
  const PUFF_OFS = Array.from({ length: 7 }, (_, i) => { const r = mkRnd(100 + i); return Array.from({ length: 12 }, () => ({ a: r() * 6.283, rj: 0.4 + r() * 0.6, rot: r() * 6.283 })); }); // per puff index: 12 sprites
  let smokeSp = null;
  function smokeSprite() { // lumpy soft smoke blob, rendered once
    if (smokeSp) return smokeSp;
    try { smokeSp = new OffscreenCanvas(128, 128); } catch { smokeSp = document.createElement('canvas'); smokeSp.width = smokeSp.height = 128; }
    const c = smokeSp.getContext('2d'), r = mkRnd(5);
    for (let i = 0; i < 7; i++) {
      const an = r() * 6.283, d = r() * 40, x = 64 + Math.cos(an) * d, y = 64 + Math.sin(an) * d, rr = 20 + r() * 4, g = c.createRadialGradient(x, y, 0, x, y, rr);
      g.addColorStop(0, 'rgb(255,255,255)'); g.addColorStop(1, 'rgba(230,230,235,0)');
      c.fillStyle = g; c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    }
    return smokeSp;
  }
  function puff(ctx, x, y, size, u, idx, now) { // u = lifetime 0→1
    if (u <= 0 || u >= 1) return;
    const e = ease(u), sp = smokeSprite(), sz = size * (0.5 + 0.9 * e), dist = size * 0.6 * e;
    ctx.save(); ctx.globalAlpha = (u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85) * 0.9;
    for (const q of PUFF_OFS[idx]) {
      ctx.save(); ctx.translate(x + Math.cos(q.a) * dist * q.rj, y + Math.sin(q.a) * dist * q.rj); ctx.rotate(q.rot + now * 0.0005);
      ctx.drawImage(sp, -sz / 2, -sz / 2, sz, sz); ctx.restore();
    }
    ctx.restore();
  }
  function fxClone(ctx, f, p, a, s) {
    const W = f.w, H = f.h, now = f.now, tc = f.tmp.getContext('2d');
    if (p <= 0) return;
    const plate = plateImg?.complete && plateImg.naturalWidth ? plateImg : null;
    const showPlate = (masked) => { // plate (brightness-matched) or blurred camera; masked = only inside the person
      if (plate && !S.gain) S.gain = lum(f.video) / Math.max(1, lum(plate));
      const c = masked ? tc : ctx;
      if (masked) { tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, W, H); }
      c.filter = plate ? `brightness(${S.gain || 1})` : 'blur(40px)';
      c.drawImage(plate || f.video, 0, 0, W, H); c.filter = 'none';
      if (masked) { tc.globalCompositeOperation = 'destination-in'; tc.drawImage(maskHard, 0, 0, W, H); tc.globalCompositeOperation = 'source-over'; ctx.drawImage(f.tmp, 0, 0); }
    };
    if (p >= 1) return showPlate(false);
    const X = S.cx * W, Fy = H, sy = (c) => H - 0.45 * H * c.sc + c.dy * H; // clone torso y (0.55H scaled about the feet, then shifted)
    if (p < BURST_AT + 0.02) {
      const fade = 1 - seg(p, BURST_AT, BURST_AT + 0.02);
      const al = CLONES.map((c) => ease(seg(p, c.t + PUFF_DUR * 0.35, c.t + PUFF_DUR)) * fade * 0.97);
      if (haveMask && al.some((x) => x > 0.003)) {
        tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, W, H); tc.drawImage(f.video, 0, 0, W, H);
        tc.globalCompositeOperation = 'destination-in'; tc.drawImage(maskHard, 0, 0, W, H); tc.globalCompositeOperation = 'source-over';
        CLONES.forEach((c, k) => {
          if (al[k] <= 0.003) return;
          ctx.save(); ctx.globalAlpha = al[k];
          ctx.translate(c.dx * W + Math.sin(now / 700 + k) * 0.004 * W, c.dy * H); ctx.translate(X, Fy); ctx.scale(c.sc, c.sc); ctx.translate(-X, -Fy);
          ctx.drawImage(f.tmp, 0, 0); ctx.restore();
        });
        ctx.drawImage(f.tmp, 0, 0); // real user stays in front
      }
      CLONES.forEach((c, k) => puff(ctx, X + c.dx * W, sy(c), 0.32 * H * c.sc, seg(p, c.t, c.t + PUFF_DUR), k, now));
    } else showPlate(haveMask && p < BURST_AT + 0.08);
    if (p >= BURST_AT - 0.005) {
      const uB = seg(p, BURST_AT, BURST_AT + BURST_DUR);
      CLONES.forEach((c, k) => puff(ctx, X + c.dx * W, sy(c), 0.45 * H * c.sc, uB, k, now));
      puff(ctx, X, 0.55 * H, 0.55 * H, uB, 6, now);
    }
  }
  function soundClone(b) {
    const { node, osc, noise, holdS } = b, at = (p) => p * holdS;
    for (const c of CLONES) { const t = at(c.t); noise(t, 0.25, node('lowpass', 700), 0.45); osc('sine', 190, 60, t, 0.16, 0.25); } // soft poofs
    const t = at(BURST_AT);
    noise(t, 0.9, node('lowpass', 1000), 0.8); osc('sine', 130, 38, t, 0.45, 0.5); noise(t, 0.5, node('highpass', 3000), 0.15); // big puff + airy hiss
  }

  // BANKAI timeline (p 0→1 over the hold; reversed on cancel):
  //  charge 0–0.40   dark red/black flame aura rises from the silhouette edge, background darkens + desaturates,
  //                  debris starts lifting from the bottom, faint camera shake
  //  build  0.40–0.85 aura taller/brighter, shake grows; at 0.60 a black-red blade of light shoots horizontally out of the fist
  //  climax 0.85–1.0 one bright diagonal slash crosses the frame (q 0–.25), white flash (q .25–.35), the frame splits along
  //                  the slash and the halves slide apart revealing black (q .35–1)
  //  end    p = 1    black frame while Leave is clicked
  // Pure function of p (now only for flicker/flow/shake phase). k = ease(seg(p, 0, 0.85)) is the overall intensity.
  const BK_DEB = (() => { const r = mkRnd(77); return Array.from({ length: 50 }, () => ({ x: r(), ph: r(), sp: 0.5 + r(), sz: 2 + r() * 4, rot: r() * 6.283 })); })();
  let bkAura = null, bkNoise = null;
  function bkNoiseTex() { // 128x128 tileable-ish soft black blobs, rendered once
    if (bkNoise) return bkNoise;
    bkNoise = document.createElement('canvas'); bkNoise.width = bkNoise.height = 128;
    const c = bkNoise.getContext('2d'), r = mkRnd(31);
    for (let i = 0; i < 40; i++) { const x = r() * 128, y = r() * 128, rr = 6 + r() * 14; for (const ox of [-128, 0, 128]) for (const oy of [-128, 0, 128]) glow(c, x + ox, y + oy, rr, 'rgba(0,0,0,0.9)'); }
    return bkNoise;
  }
  function bkAuraDraw(ctx, W, H, k, now) {
    const mw = maskHard.width, mh = maskHard.height;
    if (!mw || !mh) return;
    if (!bkAura) bkAura = document.createElement('canvas');
    if (bkAura.width !== mw || bkAura.height !== mh) { bkAura.width = mw; bkAura.height = mh; }
    const c = bkAura.getContext('2d');
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.clearRect(0, 0, mw, mh);
    c.filter = 'blur(3px)';
    for (let i = 0; i < 5; i++) { // flame tails: copies rising and growing about the bottom-centre
      c.save(); c.translate(mw / 2, mh - i * (2 + 6 * k)); c.scale(1 + 0.03 * i * k, 1 + 0.03 * i * k); c.translate(-mw / 2, -mh);
      c.drawImage(maskHard, 0, 0); c.restore();
    }
    c.filter = 'none';
    c.globalCompositeOperation = 'source-in';
    const g = c.createLinearGradient(0, mh, 0, 0);
    g.addColorStop(0, 'rgba(170,0,10,1)'); g.addColorStop(0.5, 'rgba(90,0,0,1)'); g.addColorStop(1, 'rgba(10,0,0,1)');
    c.fillStyle = g; c.fillRect(0, 0, mw, mh);
    c.globalCompositeOperation = 'destination-out'; c.globalAlpha = 0.85;
    const nt = bkNoiseTex(), ox = Math.sin(now / 900) * 10 - 128, oy = -((now * 0.06) % 128) - 128; // scrolls up
    for (let y = oy; y < mh; y += 128) for (let x = ox; x < mw; x += 128) c.drawImage(nt, x, y);
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    ctx.save(); ctx.globalAlpha = 0.35 + 0.65 * k; ctx.drawImage(bkAura, 0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.25 * k; ctx.drawImage(bkAura, 0, 0, W, H); ctx.restore();
  }
  function bkBladePath(ctx, bx, by, dx, len, t, now) { // flickering horizontal blade from the fist, pointed tip, 24 segments
    const T = [], B = [];
    for (let i = 0; i <= 24; i++) {
      const u = i / 24, x = bx + dx * len * u, ht = t / 2 * (u < 0.9 ? 1 : (1 - u) / 0.1) + Math.sin(i * 0.9 + now / 60) * t * 0.08 * (u < 0.9);
      T.push([x, by - ht]); B.push([x, by + ht]);
    }
    ctx.beginPath(); T.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); B.reverse().forEach(([x, y]) => ctx.lineTo(x, y)); ctx.closePath();
  }

  function fxBankai(ctx, f, p, a, s) {
    const W = f.w, H = f.h, now = f.now, tc = f.tmp.getContext('2d');
    if (p <= 0) return;
    if (p >= 1) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); return; }
    const k = ease(seg(p, 0, 0.85));
    ctx.save(); ctx.filter = `saturate(${1 - 0.8 * k}) brightness(${1 - 0.55 * k})`; ctx.drawImage(f.video, 0, 0, W, H); ctx.restore(); // 1 darken
    if (haveMask) bkAuraDraw(ctx, W, H, k, now); // 2 aura
    if (haveMask) { // 3 person on top
      tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, W, H); tc.drawImage(f.video, 0, 0, W, H);
      tc.globalCompositeOperation = 'destination-in'; tc.drawImage(maskHard, 0, 0, W, H); tc.globalCompositeOperation = 'source-over';
      ctx.save(); ctx.filter = `saturate(${1 - 0.3 * k}) brightness(${1 - 0.15 * k})`; ctx.drawImage(f.tmp, 0, 0); ctx.restore();
    }
    ctx.save(); // 4 debris
    const nd = Math.floor(BK_DEB.length * k);
    for (let i = 0; i < nd; i++) {
      const d = BK_DEB[i], u = (now * 0.00025 * d.sp + d.ph) % 1, y = H * (1 - u), x = d.x * W + Math.sin(now / 500 + d.ph * 10) * 6;
      ctx.globalAlpha = Math.min(1, y / (0.25 * H));
      ctx.save(); ctx.translate(x, y); ctx.rotate(d.rot + now * 0.001 * d.sp);
      ctx.fillStyle = 'rgba(30,10,10,0.9)'; ctx.fillRect(-d.sz / 2, -d.sz * 0.35, d.sz, d.sz * 0.7);
      ctx.strokeStyle = 'rgba(200,30,30,0.8)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-d.sz / 2, -d.sz * 0.35); ctx.lineTo(d.sz / 2, -d.sz * 0.35); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
    if (p >= 0.6) { // 5 blade: horizontal black-red blade out of the thumb side of the fist, across the frame
      const cu = ease(seg(p, 0.6, 0.85)), bl = s.anchors?.blade || a, bx = bl.x * W, by = bl.y * H, dx = (s.anchors?.dir?.x ?? 1) < 0 ? -1 : 1;
      const len = ((dx > 0 ? W - bx : bx) + 0.05 * W) * ease(seg(p, 0.6, 0.68)), t = H * (0.025 + 0.05 * cu);
      if (len > 1) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = `rgba(220,20,20,${0.25 * cu})`; bkBladePath(ctx, bx, by, dx, len, t * 2.2, now); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        const g = ctx.createLinearGradient(0, by - t / 2, 0, by + t / 2);
        g.addColorStop(0, 'rgba(255,40,30,0.95)'); g.addColorStop(0.3, 'rgba(120,0,0,0.95)'); g.addColorStop(0.5, 'rgba(5,0,0,0.98)'); g.addColorStop(0.7, 'rgba(120,0,0,0.95)'); g.addColorStop(1, 'rgba(255,40,30,0.95)');
        ctx.fillStyle = g; bkBladePath(ctx, bx, by, dx, len, t, now); ctx.fill();
        ctx.globalCompositeOperation = 'lighter'; glow(ctx, bx, by, t * 1.8, 'rgba(255,60,40,0.8)');
        ctx.restore();
      }
    }
    if (p < 0.85) { // 6 shake
      const amp = 0.012 * W * k * k;
      if (amp >= 0.5) {
        const dx = amp * (Math.sin(now * 0.091) + Math.sin(now * 0.137)) / 2, dy = amp * (Math.sin(now * 0.113) + Math.sin(now * 0.071)) / 2, sc = 1 + 2.5 * amp / W;
        ctx.save(); ctx.translate(W / 2 + dx, H / 2 + dy); ctx.scale(sc, sc); ctx.translate(-W / 2, -H / 2); ctx.drawImage(ctx.canvas, 0, 0, W, H); ctx.restore();
      }
      return;
    }
    const q = seg(p, 0.85, 1), S0 = { x: 0.88 * W, y: -0.1 * H }, S1 = { x: 0.12 * W, y: 1.1 * H };
    const len = Math.hypot(S1.x - S0.x, S1.y - S0.y), t = { x: (S1.x - S0.x) / len, y: (S1.y - S0.y) / len }, n = { x: -t.y, y: t.x };
    if (q < 0.35) {
      const Lq = ease(seg(q, 0, 0.25)), E = { x: S0.x + (S1.x - S0.x) * Lq, y: S0.y + (S1.y - S0.y) * Lq };
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
      for (const [lw, c] of [[18, 'rgba(255,60,40,0.5)'], [4, 'rgba(255,245,240,1)']]) { ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(S0.x, S0.y); ctx.lineTo(E.x, E.y); ctx.stroke(); }
      ctx.fillStyle = 'rgba(255,200,180,0.9)';
      for (let i = 0; i < 8; i++) { const an = now * 0.03 + i * 2.1, r = 6 + (i * 7) % 22; ctx.fillRect(E.x + Math.cos(an) * r, E.y + Math.sin(an) * r, 2, 2); }
      const fl = 0.8 * Math.sin(Math.PI * seg(q, 0.25, 0.35));
      if (fl > 0.003) { ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = `rgba(255,255,255,${fl})`; ctx.fillRect(0, 0, W, H); }
      ctx.restore();
      return;
    }
    tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, W, H); tc.drawImage(ctx.canvas, 0, 0, W, H);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const D = ease(seg(q, 0.35, 1)) * 0.55 * Math.max(W, H), B = 3 * Math.max(W, H), A = { x: S0.x - t.x * B, y: S0.y - t.y * B }, E2 = { x: S1.x + t.x * B, y: S1.y + t.y * B };
    for (const sg of [1, -1]) {
      ctx.save(); ctx.translate(sg * (n.x * D + t.x * D * 0.3), sg * (n.y * D + t.y * D * 0.3));
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(E2.x, E2.y); ctx.lineTo(E2.x + sg * n.x * B, E2.y + sg * n.y * B); ctx.lineTo(A.x + sg * n.x * B, A.y + sg * n.y * B); ctx.closePath(); ctx.clip();
      ctx.drawImage(f.tmp, 0, 0, W, H);
      ctx.strokeStyle = `rgba(255,80,60,${1 - seg(q, 0.35, 0.7)})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(E2.x, E2.y); ctx.stroke();
      ctx.restore();
    }
  }
  function soundBankai(b) {
    const { ac, T, out, go, node, gain, osc, noise, holdS } = b, at = (p) => p * holdS, r = mkRnd(9), end = at(0.85) + 0.05;
    const nb = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = r() * 2 - 1;
    const roar = ac.createBufferSource(), lp = node('lowpass', 200), env = gain(0, out), sub = ac.createOscillator(), sl = node('lowpass', 120), se = gain(0, out);
    roar.buffer = nb; roar.loop = true; lp.Q.value = 0.8; roar.connect(lp).connect(env);
    lp.frequency.setValueAtTime(200, T); lp.frequency.exponentialRampToValueAtTime(1800, T + at(0.84));
    sub.type = 'sawtooth'; sub.frequency.value = 45; sub.connect(sl).connect(se);
    for (const [e, v] of [[env, 0.5], [se, 0.25]]) { e.gain.setValueAtTime(0, T); e.gain.linearRampToValueAtTime(v, T + at(0.84)); e.gain.exponentialRampToValueAtTime(0.0001, T + end); }
    go(roar, 0, end + 0.05); go(sub, 0, end + 0.05);
    for (let i = 0; i < 45; i++) { const t = at(0.15 + 0.69 * Math.sqrt(r())); noise(t, 0.012, node('highpass', 2500), 0.15 + 0.3 * (t / at(0.84))); } // crackle
    noise(at(0.6), 1.0, node('lowpass', 600), 0.6); osc('sine', 85, 35, at(0.6), 0.8, 0.45); // blade eruption
    const ts = at(0.86);
    for (const f of [1830, 2770, 3910, 5150]) osc('sine', f, f, ts, 0.7, 0.07); // metallic ring
    noise(ts - 0.06, 0.16, node('bandpass', 6000), 0.5, [8000, 1500]); // swoosh
    osc('sine', 70, 30, at(0.9), 0.6, 0.5); // boom
  }

  // Effect registry. draw(ctx, frame, progress, anchor, state):
  //   frame = { w, h, video, tmp, now }; progress 0→1 over the hold (runs backwards while CANCELLING, 1 while LEAVING);
  //   anchor = smoothed primary anchor {x,y} in normalized output coords (detector frames are a downscale of the same,
  //   un-mirrored camera image we draw, so x*w, y*h maps directly; the app mirrors only its local self-view);
  //   state = { phase, t, te, tc, test, anchors, rawAnchor, startAnchor, mem } (mem = per-activation scratch, reset in activate()).
  // sound(bus, progress): scheduled once at activation (progress = 0); bus.holdS = seconds until leave.
  const FX = {
    INSTANT_TRANSMISSION: { id: 'INSTANT_TRANSMISSION', label: 'Instant Transmission', needsMask: true, needsBackgroundPlate: true,
      defaultAnchor: { x: 0.5, y: 0.4 }, flashOnStart: true,
      draw: (ctx, f, p, a, s) => fxIT(ctx, f.w, f.h, f.video, f.tmp, { t: s.t, te: s.te, a0: s.tc >= 600 ? 1 : 0, raw: s.rawAnchor }, f.now),
      sound(b) {
        const { osc, noise, node } = b;
        osc('sine', 400, 1200, 0, 0.6, 0.15, 25);                    // charge, slight vibrato
        noise(0.6, 0.5, node('bandpass', 500), 0.5, [500, 6000]);    // whoosh
        osc('square', 1800, 1800, 1.2, 0.08, 0.2);                   // zip/ping
        osc('triangle', 2600, 2600, 1.28, 0.08, 0.2);
      } },
    GOJO: { id: 'GOJO', label: 'Domain Expansion', needsMask: false, needsBackgroundPlate: false,
      defaultAnchor: { x: 0.5, y: 0.5 }, localVoid: true,
      draw: (ctx, f, p, a, s) => fxGojo(ctx, f.w, f.h, f.video, { t: s.t, te: s.te, a0: ease(Math.min(s.tc / 900, 1)) }, f.now),
      sound(b) {
        const { ac, go, node, gain, osc, noise } = b;
        noise(0, 0.4, node('lowpass', 800), 0.7);                    // impact
        osc('sine', 220, 110, 0, 0.6, 0.5);
        const life = LEAVE_MS / 1000 + 2, lp = node('lowpass', 900), dr = gain(0.12);
        lp.connect(dr); // void drone, stopped by stopSound(); auto-stops as safety
        for (const [f, det] of [[110, 0], [165, 4]]) { const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det; o.connect(lp); go(o, 0, life); }
        for (const f of [880, 1320]) { // shimmer: sine under 0.3 Hz tremolo (gain 0..0.06)
          const o = ac.createOscillator(), tg = gain(0.03), l = ac.createOscillator();
          o.frequency.value = f; o.connect(tg); l.frequency.value = 0.3; l.connect(gain(0.03, tg.gain));
          go(o, 0, life); go(l, 0, life);
        }
      } },
    ROOM: { id: 'ROOM', label: 'Room (dome)', needsMask: true, needsBackgroundPlate: true, defaultAnchor: { x: 0.5, y: 0.45 }, draw: fxRoom, sound: soundRoom },
    SHADOW_CLONE: { id: 'SHADOW_CLONE', label: 'Shadow clone', needsMask: true, needsBackgroundPlate: true, defaultAnchor: { x: 0.5, y: 0.5 }, draw: fxClone, sound: soundClone },
    BANKAI: { id: 'BANKAI', label: 'Bankai (sword)', needsMask: true, needsBackgroundPlate: false, defaultAnchor: { x: 0.5, y: 0.6 }, draw: fxBankai, sound: soundBankai },
  };

  function renderFx(ctx, w, h, video, tmp, now) {
    const fx = FX[S.kind];
    if (S.st === 'IDLE' || !fx) return;
    if (tmp.width !== w || tmp.height !== h) { tmp.width = w; tmp.height = h; }
    const can = S.st === 'CANCELLING';
    const state = { phase: S.st, t: can ? null : now - S.t0, te: can ? now - S.t1 : null, tc: S.tc, test: S.test, anchors: S.sm?.anchors || {},
      rawAnchor: S.raw && now - S.rawAt < 600 ? S.raw : null, startAnchor: S.tip, mem: S.mem };
    fx.draw(ctx, { w, h, video, tmp, now }, progress(now), S.sm?.anchor || S.tip, state);
  }

  // ---------- outgoing video: canvas-backed track with effects ----------
  function patchVideo(vt) {
    log('getUserMedia intercepted video');
    const s = vt.getSettings();
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.autoplay = true;
    video.srcObject = new MediaStream([vt]);
    video.play().catch((e) => log('video play failed', String(e)));
    const canvas = document.createElement('canvas');
    canvas.width = s.width || 1280;
    canvas.height = s.height || 720;
    const sync = () => {
      if (video.videoWidth && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      }
    };
    video.addEventListener('loadedmetadata', sync);
    video.addEventListener('resize', sync);
    const ctx = canvas.getContext('2d');
    // setInterval, not rAF: rAF freezes in background tabs
    let frameNo = 0;
    const tmp = document.createElement('canvas');
    const timer = setInterval(() => {
      if (video.readyState < 2) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const now = performance.now();
      // isolate failures: a broken effect must never stop leave logic, detection, or the raw video
      const safe = (f, n) => { try { f(); } catch (e) { if (!errSeen[n]) { errSeen[n] = 1; log(n + ' error', String(e)); } } };
      safe(() => step(now), 'step');
      safe(() => renderFx(ctx, canvas.width, canvas.height, video, tmp, now), 'fx');
      if (dbgOn()) safe(() => drawDebug(ctx, canvas.width, canvas.height), 'debug');
      if (++frameNo % 3 === 0) safe(sendTick, 'send'); // ~10 fps to detector
    }, 33);
    live.add(video);

    const out = canvas.captureStream(30);
    const ot = out.getVideoTracks()[0];
    const stopOut = ot.stop.bind(ot);
    const cleanup = () => {
      clearInterval(timer);
      live.delete(video);
      try { vt.stop(); } catch {}
      if (!live.size && S.st !== 'IDLE') { toIdle(); overlay(performance.now()); } // camera gone (left call)
    };
    ot.stop = () => { cleanup(); stopOut(); };
    // Teams identifies camera via settings/capabilities/label; canvas track has none → proxy to real cam.
    ot.getSettings = () => ({ ...vt.getSettings(), width: canvas.width, height: canvas.height });
    ot.getCapabilities = () => vt.getCapabilities?.() ?? {};
    ot.getConstraints = () => vt.getConstraints();
    ot.applyConstraints = (k) => vt.applyConstraints(k);
    Object.defineProperty(ot, 'label', { get: () => vt.label });
    vt.addEventListener('ended', () => { cleanup(); stopOut(); ot.dispatchEvent(new Event('ended')); });

    patched++;
    if (patched === 1) firstPatchAt = performance.now(); // detector requested by sendTick after join settles
    updateDebug();
    document.addEventListener('DOMContentLoaded', updateDebug, { once: true });
    return ot;
  }

  // ---------- outgoing audio: mic + fx mixed through the shared AudioContext; any failure -> raw mic track ----------
  const mixOn = () => { try { return localStorage.getItem('tlfx-mixmic') !== '0'; } catch { return true; } };
  async function mixAudio(at) {
    let src, send, done = false;
    try {
      const ac = getAC();
      await Promise.race([ac.resume(), new Promise((r) => setTimeout(r, 500))]);
      // CRITICAL: a suspended context would make the user's mic silent
      if (ac.state !== 'running') { log('mic mix skipped: audio context suspended'); return at; }
      src = ac.createMediaStreamSource(new MediaStream([at]));
      const dest = ac.createMediaStreamDestination();
      send = ac.createGain(); send.gain.value = 1;
      src.connect(dest); fxBus.connect(send); send.connect(dest);
      const ot = dest.stream.getAudioTracks()[0], stopOt = ot.stop.bind(ot);
      const cleanup = () => {
        if (done) return; done = true; mixed--;
        try { at.stop(); } catch {}
        try { src.disconnect(); } catch {}
        try { fxBus.disconnect(send); } catch {}
        try { send.disconnect(); } catch {}
      };
      ot.stop = () => { cleanup(); stopOt(); };
      ot.getSettings = () => ({ ...at.getSettings() });
      ot.getCapabilities = () => at.getCapabilities?.() ?? {};
      ot.getConstraints = () => at.getConstraints();
      ot.applyConstraints = (k) => at.applyConstraints(k);
      Object.defineProperty(ot, 'label', { get: () => at.label });
      Object.defineProperty(ot, 'enabled', { get: () => at.enabled, set: (v) => { at.enabled = v; } }); // app mute mutes mic (and fx)
      at.addEventListener('ended', () => { cleanup(); stopOt(); ot.dispatchEvent(new Event('ended')); });
      mixed++;
      return ot;
    } catch (e) {
      log('mic mix failed, using raw mic', String(e));
      try { src?.disconnect(); } catch {}
      try { send?.disconnect(); fxBus.disconnect(send); } catch {}
      return at;
    }
  }

  proto.getUserMedia = async function (c) {
    const wantA = !!(c && c.audio) && mixOn();
    if (!c || (!c.video && !wantA)) return origFn.call(this, c);
    const raw = await origFn.call(this, c);
    let vts = raw.getVideoTracks(), ats = raw.getAudioTracks(), changed = false;
    if (c.video && vts[0]) {
      try { vts = [patchVideo(vts[0])]; changed = true; } catch (e) { log('patch failed, using raw video', String(e)); vts = raw.getVideoTracks(); }
    }
    if (wantA && ats[0]) {
      const m = await mixAudio(ats[0]);
      if (m !== ats[0]) { ats = [m, ...ats.slice(1)]; changed = true; }
    }
    return changed ? new MediaStream([...vts, ...ats]) : raw;
  };
  // console probe: __tlfx()
  window.__tlfx = () => ({ det, ticks, sent, live: live.size, busy, detOrigin, sendErr, last, st: S.st, off: [...offSet], anchor: S.sm?.anchor, kind: S.kind, t0: S.t0, lastHold: S.lastHold, test: S.test, cand: S.cand, haveMask, plate: !!plateImg, mixMic: mixed });
  // preview effects without gestures; test mode never leaves (step() skips leave when S.test)
  window.__tlfxTest = (k) => {
    if (!FX[k]) return 'use one of: ' + Object.keys(FX).join(', ');
    if (S.st === 'IDLE') activate(k, performance.now(), true);
  };
  // audio-only preview: play a sound through fxBus (and the mic mix, if active) for 3 s
  window.__tlfxSound = (k) => {
    if (!FX[k]) return 'use one of: ' + Object.keys(FX).join(', ');
    sound(k); setTimeout(stopSound, 3000);
  };
  log('patch installed', location.href);
  if (window === top) {
    if (document.body) updateDebug();
    else document.addEventListener('DOMContentLoaded', updateDebug, { once: true });
  }
})();

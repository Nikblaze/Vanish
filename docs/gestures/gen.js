#!/usr/bin/env node
// Generates the gesture illustrations in this folder: `node docs/gestures/gen.js`. No dependencies.
// Hands are public-domain ASL handshape drawings from src/ (see src/README.md), placed and rotated per gesture;
// the head is drawn here in the same ink style.
const fs = require('fs'), path = require('path');

const W = 320, H = 260, SRC = path.join(__dirname, 'src');
const C = { ink: '#171717', body: '#3b3b3b', zone: '#f59e0b', text: '#6b7280', frame: '#9ca3af', red: '#ef4444', blue: '#3b82f6', purple: '#a855f7' };
const fmt = (n) => Math.round(n * 100) / 100;

// load a handshape: its paths (annotation greys dropped) and viewBox
const shapes = {};
function shape(name) {
  if (shapes[name]) return shapes[name];
  const s = fs.readFileSync(path.join(SRC, `asl-${name}.svg`), 'utf8');
  const vb = s.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
  const paths = (s.match(/<path\b[^>]*?\/>/gs) || []).filter((p) => !/#(616161|8f8f8f|c7c7c7)/.test(p));
  return (shapes[name] = { body: paths.join(''), vb });
}
// topmost point of a handshape as a box fraction [fx, fy]: the tip of its longest extended finger
function top(name) {
  const { body, vb } = shape(name); let best = [0, Infinity];
  for (const d of body.match(/\bd="([^"]*)"/g)) { const n = d.slice(3, -1).match(/-?\d*\.?\d+/g).map(Number); for (let i = 0; i + 1 < n.length; i += 2) if (n[i + 1] < best[1]) best = [n[i], n[i + 1]]; }
  return [(best[0] - vb[0]) / vb[2], (best[1] - vb[1]) / vb[3]];
}
// place a handshape: `h` = rendered height in px, centre at (cx, cy), rotated `rot` degrees clockwise about its centre,
// optionally mirrored or drawn as a solid silhouette. `anchor` = [fx, fy] fraction of the shape's box that should land on (cx, cy) instead of its centre.
function hand(name, { h, cx, cy, rot = 0, mirror = false, anchor = [0.5, 0.5], silhouette = false }) {
  let { body, vb } = shape(name); const k = h / vb[3], w = vb[2] * k;
  if (silhouette) {                                   // every shape in ink, over a white halo so it reads on the dark head
    const ink = body.replace(/style="[^"]*"/g, `style="fill:${C.ink}"`), halo = body.replace(/style="[^"]*"/g, `style="fill:#fff;stroke:#fff;stroke-width:${fmt(5 / k)};stroke-linejoin:round"`);
    body = halo + ink;
  }
  const ax = (anchor[0] - 0.5) * w, ay = (anchor[1] - 0.5) * h; // anchor offset from the centre, unrotated
  return `<g transform="translate(${fmt(cx)} ${fmt(cy)}) rotate(${rot}) ${mirror ? 'scale(-1 1)' : ''} translate(${fmt(-ax)} ${fmt(-ay)}) translate(${fmt(-w / 2)} ${fmt(-h / 2)}) scale(${fmt(k)}) translate(${fmt(-vb[0])} ${fmt(-vb[1])})">${body}</g>`;
}
// scene coordinates of a box fraction [fx, fy] of a hand placed with the same options
function at(name, { h, cx, cy, rot = 0, mirror = false, anchor = [0.5, 0.5] }, [fx, fy]) {
  const { vb } = shape(name), k = h / vb[3], w = vb[2] * k;
  let x = (fx - anchor[0]) * w, y = (fy - anchor[1]) * h; if (mirror) x = -x;
  const r = (rot * Math.PI) / 180;
  return [cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r)];
}
// head + neck + shoulders as one silhouette
function face(cx, cy, w) {
  const h = w * 1.3, ey = cy - h * 0.08, ex = w * 0.26, bot = cy + h / 2;
  const g = { forehead: [cx, cy - h * 0.4], eyeL: [cx - ex, ey], eyeR: [cx + ex, ey], eyeY: ey, w };
  const svg = `<g fill="${C.body}"><path d="M${fmt(cx - w * 1.35)} ${H} V${fmt(bot + 50)} Q${fmt(cx - w * 1.2)} ${fmt(bot + 14)} ${fmt(cx - w * 0.22)} ${fmt(bot + 6)} V${fmt(bot - 16)} H${fmt(cx + w * 0.22)} V${fmt(bot + 6)} Q${fmt(cx + w * 1.2)} ${fmt(bot + 14)} ${fmt(cx + w * 1.35)} ${fmt(bot + 50)} V${H} Z"/><ellipse cx="${cx}" cy="${cy}" rx="${fmt(w / 2)}" ry="${fmt(h / 2)}"/></g>`;
  return { svg, g };
}
const zone = (x, y, r) => `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(r)}" fill="${C.zone}" fill-opacity="0.15" stroke="${C.zone}" stroke-width="1.5" stroke-dasharray="4 3"/>`;
const text = (x, y, t, anchor = 'middle', color = C.text) => `<text x="${fmt(x)}" y="${fmt(y)}" text-anchor="${anchor}" fill="${color}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="11">${t}</text>`;
const lowZone = () => `<rect x="1" y="${H * 0.75}" width="${W - 2}" height="${H * 0.25 - 1}" fill="${C.zone}" fill-opacity="0.08"/><line x1="1" y1="${H * 0.75}" x2="${W - 1}" y2="${H * 0.75}" stroke="${C.zone}" stroke-width="1.5" stroke-dasharray="6 4"/>${text(10, H * 0.75 + 16, 'keep hand above this line', 'start')}`;
const dot = (x, y, color, r = 6) => `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r}" fill="${color}" fill-opacity="0.9"/><circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r + 5}" fill="none" stroke="${color}" stroke-width="1.5" stroke-opacity="0.5"/>`;
const svg = (title, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${title}">
<defs><clipPath id="f"><rect x="0" y="0" width="${W}" height="${H}" rx="8"/></clipPath></defs>
<rect x="0" y="0" width="${W}" height="${H}" rx="8" fill="#fff"/>
<g clip-path="url(#f)">${body}</g>
<rect x="1" y="${H - 20}" width="${W - 2}" height="19" fill="#fff" fill-opacity="0.9"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="8" fill="none" stroke="${C.frame}" stroke-width="1" stroke-dasharray="3 3"/>
${text(W / 2, H - 7, title)}
</svg>`;

// ---- scenes ----
const scenes = {
  INSTANT_TRANSMISSION() {
    const f = face(140, 150, 90), [fx, fy] = f.g.forehead;
    // U hand (index + middle together), fingertips (top centre of the drawing) on the forehead
    return svg('Instant Transmission: index + middle on forehead', f.svg + zone(fx, fy, f.g.w * 0.35) + hand('u', { h: 150, cx: fx - 14, cy: fy + 4, rot: -62, anchor: [0.56, 0.01], silhouette: true }) + text(60, 60, 'two fingertips') + text(60, 74, 'on the forehead'));
  },
  GOJO() {
    return svg('Domain Expansion: index + middle crossed (or together)', hand('r', { h: 190, cx: 160, cy: 140 }) + text(160, 28, 'index + middle crossed (or pressed together),') + text(160, 42, 'ring + pinky curled, hand raised'));
  },
  ROOM() {
    // user-supplied reference picture, inverted to black-on-white (src/room-hand-bw.png, made from src/room-hand.png); embedded so the SVG stays self-contained
    const png = fs.readFileSync(path.join(SRC, 'room-hand-bw.png')).toString('base64');
    return svg('Room: palm down, fingers spread and curved down', lowZone() + `<image href="data:image/png;base64,${png}" x="60" y="4" width="${W - 120}" height="${H * 0.75 - 6}" preserveAspectRatio="xMidYMid meet"/>`);
  },
  SHADOW_CLONE() {
    const m = [165, 118], a = [0.70, 0.25], ah = [0.70, 0.16]; // U's finger pair: x ≈ 0.70 of its box, tips 0.04 to knuckles 0.45
    // two U hands crossing at the middle of their fingers: horizontal (mirrored, rotated) behind, vertical on top, then the
    // horizontal fingers again clipped to the right of the crossing so they pass in front and both pairs read as a +
    const horiz = hand('u', { h: 180, cx: m[0], cy: m[1], rot: 90, mirror: true, anchor: ah });
    return svg('Shadow Clone: two hands, index + middle pairs crossed as a +', `<defs><clipPath id="sc"><rect x="${m[0] - 15}" y="0" width="${W}" height="${H}"/></clipPath></defs>` + horiz + hand('u', { h: 180, cx: m[0], cy: m[1], anchor: a }) + `<g clip-path="url(#sc)">${horiz}</g>` + zone(m[0], m[1], 16) + text(160, 28, 'index + middle together on both hands,') + text(160, 42, 'one pair vertical, one horizontal'));
  },
  BANKAI() {
    const f = face(110, 152, 86);
    return svg('Bankai: closed fist raised beside the head', f.svg + `<line x1="${f.g.eyeR[0] + 26}" y1="${fmt(f.g.eyeY)}" x2="${W - 10}" y2="${fmt(f.g.eyeY)}" stroke="${C.zone}" stroke-width="1.5" stroke-dasharray="4 3"/>` + hand('s', { h: 120, cx: 238, cy: f.g.eyeY - 12, rot: 6 }) + text(236, 44, 'fist at eye level, beside the head') + text(236, 58, 'back of the hand to the camera'));
  },
  KAMUI() {
    const f = face(140, 150, 90), [ex, ey] = f.g.eyeR;
    return svg('Kamui: index, middle and ring over one eye', f.svg + zone(ex, ey, f.g.w * 0.35) + hand('w', { h: 160, cx: ex, cy: ey, rot: -35, anchor: [0.5, 0.06], silhouette: true }) + text(58, 60, 'three fingertips') + text(58, 74, 'over one eye'));
  },
  HOLLOW_RED() {
    const [lx, rx, y] = [147, 173, 110];
    return svg('Hollow Red: two index fingers, tips close together', hand('1', { h: 160, cx: lx, cy: y, rot: 40, anchor: [0.58, 0.02] }) + hand('1', { h: 160, cx: rx, cy: y, rot: -40, mirror: true, anchor: [0.58, 0.02] }) + zone(160, y, 24) + dot(lx, y, C.red) + dot(rx, y, C.blue) + text(160, 28, 'only the index up on each hand,') + text(160, 42, 'fingertips almost touching'));
  },
  HOLLOW_PURPLE() {
    const hp = { h: 180, cx: 215, cy: 96 };
    return svg('Hollow Purple: V with thumb out, held still', lowZone() + hand('3', hp) + dot(...at('3', hp, [0.41, 0.3]), C.purple, 5) + text(10, 28, 'index + middle spread in a V,', 'start') + text(10, 42, 'thumb out, ring + pinky curled,', 'start') + text(10, 56, 'hold the hand still', 'start'));
  },
  REVERSAL_RED() {
    // L hand rotated: index points right, thumb up
    return svg('Reversal Red: finger gun, thumb up', hand('l', { h: 190, cx: 248, cy: 128, rot: 90, mirror: true, anchor: top('l') }) + dot(258, 128, C.red, 5) + text(160, 28, 'index pointing (at the camera or sideways), thumb up,') + text(160, 42, 'other fingers curled; anywhere in the frame, hold still'));
  },
};

module.exports = { hand, svg, text, dot, zone, top };
if (require.main === module) {
  for (const [id, fn] of Object.entries(scenes)) fs.writeFileSync(path.join(__dirname, id + '.svg'), fn());
  console.log('wrote', Object.keys(scenes).length, 'svgs to', __dirname);
}

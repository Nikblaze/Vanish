# Vanish

Leave video calls with an anime-style exit. Hold a hand gesture in front of your camera, an effect plays in your **outgoing video** (everyone in the call sees it), and after 5 seconds the extension clicks **Leave** for you. Drop the gesture to cancel.

Works on **Microsoft Teams web** (`teams.microsoft.com`, `teams.live.com`, `teams.cloud.microsoft`) and **Google Meet** (`meet.google.com`) in Chrome/Edge. Everything runs locally in the browser; no server, no network calls.

| Gesture | Effect |
|---|---|
| Index + middle finger on your forehead | **Instant Transmission**: fingertip glow, flicker, you vanish from the frame |
| Index + middle crossed (or pressed together), hand raised | **Domain Expansion**: black void expands from your hand, starfield, everything goes dark |
| **Room**: one hand palm-down, all five fingers spread and curved down like an upside-down bowl, hand above the bottom quarter of the frame | **Room**: particle ring, cyan dome expands past the frame, frame is sliced into tiles, you get scattered, tiles drift apart into black. Needs captured background |
| **Shadow Clone**: both hands, index + middle pressed together on each, one pair vertical and the other horizontal forming a "+", crossing near their middles | **Shadow clone**: smoke puffs leave copies of you, the copies multiply, then everyone (you included) bursts into smoke and the room is empty. Needs captured background |
| **Bankai**: both hands as fists stacked like gripping a sword hilt (or one fist held out with the other hand gripping its wrist), both hands above the bottom quarter | **Bankai**: dark red aura rises around you, the room darkens, debris lifts, a black-red light column erupts from your hands, then a slash splits the frame apart into black |

All visuals and sounds are generated in code. No third-party character art, clips, or audio are included.

---

## Install

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select the repo folder.
3. Open Teams web or Google Meet and **refresh the tab** (scripts inject only on page load).

After changing code: click reload (↻) on the extension card, then refresh the meeting tab.

## Use

1. Join a call with the camera on. Keep the app's own background effects/blur **off**.
2. Gesture detection starts ~4 s after the camera turns on.
3. One-time: click the **`TLFX ●`** pill (bottom-left) → **Capture background** → step out of frame during the 3 s countdown. This gives a clean background for the vanish effect. Recapture if your lighting or camera position changes.
4. Hold a gesture ~0.7 s → effect starts and a local-only countdown appears.
   - Hold for 5 s → the extension clicks Leave.
   - Remove your hand for > 1 s → effect reverses, you stay in the call.
5. To turn a gesture off, expand the **`TLFX ●`** pill → **Gestures** and untick it (persisted in `localStorage` key `tlfx-off`).

### Console helpers (DevTools on the meeting tab)

| Command | What it does |
|---|---|
| `__tlfxTest(id)` | Preview an effect for 4 s (`TEST_MS`). **Never leaves.** `id` is any registered effect (currently `INSTANT_TRANSMISSION`, `GOJO`, `ROOM`, `SHADOW_CLONE`, `BANKAI`; e.g. `__tlfxTest('BANKAI')`); ignores the Gestures toggles |
| `__tlfxSound(id)` | Play just the sound for 3 s (same ids) |
| `__tlfx()` | Dump internal state (detector status, frames sent, state machine, mic mixing) |
| `window.__tlfxDebug = true` | Draw onto the video: gesture + confidence, state / candidate / active effect, both hands' skeletons, rule zones, the smoothed anchor, and loose (hysteresis) matches |
| `localStorage.setItem('tlfx-mixmic','0')` + refresh | Disable mixing effect sounds into your mic |

## Configuration

| Setting | Where | Default |
|---|---|---|
| Hold time before leaving | `LEAVE_MS` in `inject.js` | `5000` ms |
| Arming time | `ARM_MS` in `inject.js` | `700` ms |
| Cancel grace period (gap) | `GAP_MS` in `inject.js` | `1000` ms |
| Cancel reverse animation | `CANCEL_MS` in `inject.js` | `600` ms |
| Preview length | `TEST_MS` in `inject.js` | `4000` ms |
| Anchor smoothing (weight of newest anchor) | `ANCHOR_EMA` in `inject.js` | `0.5` |
| Detector start delay | `sendTick()` in `inject.js` | `4000` ms after camera start |
| Gesture thresholds | `TH` at the top of `detector.js` | see below |

Gesture thresholds (`TH`, ratios of hand/face size, so scale-invariant):

| Name | Default | Meaning |
|---|---|---|
| `EXT` | `1.1` | finger extended: `dist(tip, wrist) > dist(pip, wrist) × EXT` |
| `EXT_MIDDLE` | `1.0` | looser test for the middle finger |
| `FOREHEAD_R` | `0.35` | forehead zone radius, fraction of face width |
| `IT_TIP_R` | `1.6` | Instant Transmission: both tips within `FOREHEAD_R × IT_TIP_R` of forehead centre |
| `GOJO_CROSS` | `1.5` | Gojo crossed: tips swapped vs knuckles and within `palm × GOJO_CROSS` |
| `GOJO_TOGETHER` | `0.9` | Gojo together: `dist(tip8, tip12) < palm × GOJO_TOGETHER` |
| `LOW_ZONE` | `0.25` | shared: gestures need the wrist above the bottom `LOW_ZONE` of the frame (no desk/typing hands) |
| `ROOM_EXT` | `1.0` | Room: looser finger-extended ratio (fingers curve down into a bowl) |
| `ROOM_NY` | `0.55` | Room: `\|palm normal · y\| / \|normal\|`, palm plane roughly horizontal (palm down) |
| `ROOM_NY_LOOSE` | `0.4` | Room hysteresis |
| `ROOM_TIP_DROP` | `0.1` | Room: fingertip below its MCP by more than `ROOM_TIP_DROP × hand size` (curved down) |
| `ROOM_TIPS_DOWN` | `3` | Room: at least this many of index..pinky tips dropped |
| `ROOM_SPREAD` | `1.3` | Room: `dist(tip8, tip20) > ROOM_SPREAD × dist(mcp5, mcp17)`, fingers fanned |
| `ROOM_THUMB` | `0.5` | Room: thumb spread, `dist(tip4, mcp5) > ROOM_THUMB × hand size` |
| `SC_TOGETHER` | `1.0` | Shadow Clone: index+middle pressed together on each hand, `dist(tip8, tip12) < palm × SC_TOGETHER` |
| `SC_PERP_COS` | `0.45` | Shadow Clone: `\|cos\|` between the two finger directions below this (≈ 63°–117°, a "+") |
| `SC_AXIS` | `0.75` | Shadow Clone: one pair within ~41° of vertical, the other within ~41° of horizontal |
| `SC_NEAR` | `3` | Shadow Clone / Gojo: a second hand with its wrist within `SC_NEAR × hand size` counts as a seal attempt and blocks Gojo. In the seal, the partly hidden hand only needs its index up (ring + pinky curled); the other needs the full two-finger pose |
| `SC_CROSS` | `0.7` | Shadow Clone: finger-segment midpoints closer than `SC_CROSS × mean finger length` |
| `BK_MAX_EXT` | `1` | Bankai: a "fist" has at most this many of index..pinky extended |
| `BK_STACK` | `0.7` | Bankai stacked fists: `min(d(h1.lm5, h2.lm17), d(h2.lm5, h1.lm17)) < BK_STACK × mean hand size` |
| `BK_VERT` | `0.6` | Bankai stacked fists: palm centres one above the other, `\|dy\| / dist > BK_VERT` |
| `BK_WRIST` | `0.7` | Bankai wrist grip: other hand's palm centre within `BK_WRIST × fist hand size` of the fist's wrist |
| `BK_NEAR_LOOSE` | `3` | Bankai hysteresis: both hands fist-ish (≤ 2 extended), wrists within `BK_NEAR_LOOSE × hand size` |

---

## How it works

```
┌──────────────────────────── Teams / Meet tab ────────────────────────────┐
│  MAIN world (inject.js)                     ISOLATED world (content.js)  │
│  ┌──────────────────────────────┐           ┌────────────────────────┐   │
│  │ patched getUserMedia         │  need     │ creates hidden iframe  │   │
│  │ camera → canvas → fake track │─detector─▶│ (has chrome.* APIs)    │   │
│  │ mic + fx → mixed track       │           └───────────┬────────────┘   │
│  │ state machine, effects, leave│                       ▼                │
│  └──────┬──────────────▲────────┘           ┌──────────────────────────┐ │
│         │ 320px frames │ gesture + mask     │ iframe (extension origin)│ │
│         └──────────────┼───────────────────▶│ detector.js: MediaPipe   │ │
│                        └────────────────────│ hand / face / segmenter  │ │
│                                             └──────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: target sites, content scripts, web-accessible resources, wasm CSP |
| `inject.js` | Runs in the page's MAIN world at `document_start`. Patches `MediaDevices.prototype.getUserMedia`, renders effects, runs the state machine, mixes audio, clicks Leave |
| `content.js` | Isolated-world script. Creates the hidden detector iframe on request |
| `detector.html` / `detector.js` | Extension-origin page running MediaPipe Tasks Vision (wasm). Classifies gestures, returns person masks |
| `vendor/` | `@mediapipe/tasks-vision@0.10.35` bundle + wasm |
| `models/` | MediaPipe models: hand landmarker, face landmarker, selfie segmenter |

### 1. Stream interception (the "JS virtual camera")
`getUserMedia` is patched on the prototype. The real camera track feeds a hidden `<video>`, which is drawn every 33 ms onto a `<canvas>` along with effects; `canvas.captureStream(30)` becomes the track the app sends. The fake track proxies `getSettings`, `getCapabilities`, `applyConstraints`, `label`, and stop/ended lifecycle to the real track so the app can't tell the difference.

Audio: mic → WebAudio `MediaStreamSource` + effect bus → `MediaStreamDestination` → returned to the app. If the `AudioContext` isn't `running`, the raw mic is returned unchanged.

### 2. Detection off the main page
Teams' CSP blocks wasm compilation in the page, so MediaPipe runs in an extension-origin iframe. Frames are downscaled to 320 px and transferred as `ImageBitmap` (zero-copy) with a `busy` flag for backpressure. The face model runs lazily, once per frame and only when a rule asks for it (e.g. Instant Transmission with a two-finger hand); the segmenter only for Instant Transmission.

### 3. Gesture rules
Plain geometry on landmarks, scale-invariant (ratios, aspect-corrected). Rules live in an ordered `RULES` list in `detector.js`; two-hand rules are evaluated before one-hand rules, the first match wins, and each rule has a `match()` plus a looser `loose()` for hysteresis. All thresholds live in `TH`.
- finger extended: `dist(tip, wrist) > dist(pip, wrist) × 1.1`
- **Instant Transmission**: index + middle up, ring + pinky down, both tips inside the forehead zone (face landmarks 10/151, radius from face width)
- **Gojo**: same finger pose, tips crossed (left/right order swapped vs. knuckles) or pressed together. Ignored when another hand's wrist is within `SC_NEAR × hand size`, so a cross seal (even with one hand partly hidden) never reads as Gojo
- **Shadow Clone**: two hands, each index+middle up and pressed together; each pair is one segment (knuckle mid to tip mid), the two are near-perpendicular (`|cos|`), one near-vertical and one near-horizontal, and cross near their middles
- **Room**: palm normal `(lm5−lm0)×(lm17−lm0)` mostly vertical (`|ny|`, orientation-agnostic), ≥3 fingertips below their knuckles (palm-down bowl, not palm-up cup), fingers fanned (`tip8↔tip20` vs `mcp5↔mcp17`), thumb spread, wrist not in the bottom `LOW_ZONE`
- **Bankai**: both hands above the bottom `LOW_ZONE`; each hand is a fist (≤ `BK_MAX_EXT` of index..pinky extended). Either the fists are stacked (index MCP of one beside the pinky MCP of the other, palm centres vertically aligned) or one fist's wrist is gripped by the other hand's palm centre (only the held hand must be a fist)

### 4. State machine
```
IDLE ──held 700ms──▶ ACTIVE ──no hold >1s──▶ CANCELLING ──600ms──▶ IDLE
                       │ held 5s
                       ▼
                    LEAVING ── click Leave ── camera stops ──▶ IDLE
```
Arming delay, gap tolerance, hysteresis (once active, the rule's `loose` test is enough to keep it held), and stale-result rejection keep detection flicker from causing false triggers or early cancels.

### Adding a gesture
Add a rule (same `id`) to `RULES` in `detector.js` and an effect to `FX` in `inject.js` (`draw`, `sound`, `defaultAnchor`, flags). It appears in the Gestures toggles automatically.

### 5. Effects
Canvas 2D compositing. Vanish = background plate masked to the person silhouette (`destination-in`), brightness-matched to the live frame to cancel camera auto-exposure, then the full plate once fully vanished. Void = expanding clip circle, seeded starfield, gradients. A local page overlay shows the countdown (only you see it).

---

## Lessons from hostile host pages

Things that broke during development and how they're handled. Useful for any extension that injects into big web apps:

- **Trusted Types**: Teams/Meet reject `innerHTML`. Build DOM with `createElement` / `textContent` only.
- **Timers killed at boot**: a `setInterval` created at `document_start` in the MAIN world never fired on Teams. All periodic work runs from the per-stream draw loop.
- **CSP blocks wasm**: run ML in an extension-origin iframe created by the isolated content script.
- **Multiple streams**: apps open several camera streams and stop some; track a `Set` of live streams.
- **Fail open**: any error returns the original camera/mic; each draw-loop stage has its own `try/catch`, errors are logged once.
- **Brittle selectors**: Leave button found via a fallback list (`#hangup-button`, `data-tid`, `aria-label`).

## Resource usage (estimates)

- ~200–300 MB extra RAM during a call (mostly the detector iframe with MediaPipe + models); near zero outside calls.
- CPU/GPU: each camera stream redrawn at 30 fps; detection ~10 fps on GPU (CPU fallback).
- Check with Chrome Task Manager (`Shift+Esc`): the `Subframe: chrome-extension://…` row is the detector.

## Troubleshooting

Open DevTools on the meeting tab, filter the console by `[TLFX]`, expand the `TLFX ●` pill.

| Symptom | Likely cause |
|---|---|
| No pill at all | Tab not refreshed after loading/reloading the extension |
| `patched: 0` after camera on | App didn't call `getUserMedia` through the patch; refresh before joining |
| `detector: no iframe` | Iframe not created yet (wait 4 s after camera on) or removed by the page |
| `sent` stuck at 0 | Frame sender not running; check `[TLFX] send error` |
| Gesture label stays `none` | Lighting/angle; enable `__tlfxDebug` and check landmark dots |
| Outline/shadow when vanished | Recapture background under current lighting |
| Others can't hear sounds | Mic muted, or app noise suppression set high; set it to Low/Off |
| Voice sounds wrong | `localStorage.setItem('tlfx-mixmic','0')` and refresh |
| `leave button not found` in console | App UI changed; add the new selector in `leaveMeeting()` |

## Limitations

- Web clients only. The Teams desktop app (WebView2) doesn't support extensions.
- Vanish needs a captured background; without it the fallback is a blur.
- Background is a still image while vanished.
- While muted, your voice is silenced but effect sounds may still reach the call (mute is forwarded to the real mic track; the effect bus is mixed after it).
- Selectors for Teams/Meet buttons can break when Microsoft/Google update their UI.

## Third-party

- [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) (`@mediapipe/tasks-vision@0.10.35`) and its models: Apache License 2.0.

Personal project. Not affiliated with Microsoft, Google, or any anime franchise.

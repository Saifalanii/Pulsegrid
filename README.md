# Pulsegrid

A neon arena survivor as an installable PWA. Canvas 2D, vanilla ES modules, **no build
step and no dependencies**. Every pixel and every sound is generated in code at runtime —
there is not one image or audio file in the repository.

## Running it

```bash
node serve.mjs
```

Then open `http://localhost:8080`. The script prints your LAN address too, which is how
you actually test the touch controls on a phone.

ES modules and service workers both need a real HTTP origin, so `file://` won't work.
Install prompts need `localhost` or HTTPS.

To regenerate the icon set (a pure-JS PNG encoder — SDF rendering plus Node's `zlib`):

```bash
node tools/make-icons.mjs
```

## Layout

```
index.html              shell; all menus/HUD are DOM, the arena is canvas
manifest.webmanifest    fullscreen, maskable icons, daily/practice shortcuts
sw.js                   offline shell cache (network-first on localhost — see below)
serve.mjs               zero-dependency static server
tools/make-icons.mjs    generates icons/*.png from signed distance fields
js/
  main.js               boot, fixed-timestep loop, state machine
  core/   math rng pool audio save input
  fx/     particles juice render face
  game/   palette defs daily run characters voice
  ui/     screens
```

## Things worth knowing

**The Daily Run is genuinely shared.** The simulation runs at a fixed 120Hz step so a
60Hz and a 144Hz phone integrate identically, and the RNG is split into three streams:

| stream | drives | advanced by |
| --- | --- | --- |
| `rng` | wave composition, spawn angles, elite schedule | the spawn timer only |
| `rngUpgrade` | level-up offers | one draw per level |
| `rngAux` | crits, drops, splitter fragments, elite summons | player actions |

The director's stream is never touched by anything the player does — including a full
enemy pool, which drops the spawn but still consumes its draws. The result: two players
on the same date get byte-identical waves and the same three augments at level *N*, and
differ only in how well they play. Cosmetic randomness (particle jitter, barks) uses
`Math.random` so it can't perturb a run.

Verified by simulating four wildly different players — including one that deliberately
saturates the enemy pool — and confirming identical director stream and elite schedule
with different kill counts.

**Rendering** is a fake-HDR pipeline: entities drawn additively with a saturated stroke
plus a near-white core, then a quarter-res blurred copy composited back for bloom, then
chromatic aberration / flash / vignette. Bloom alpha is deliberately low (0.52) — additive
bloom has no tone mapping, and at 0.78 a busy frame lifted the far corners from ~(12,7,5)
to ~(106,50,42) and the "near-black void" read was gone.

**Performance.** Everything hot lives in fixed-capacity pools; the update path allocates
nothing. Radial glows and enemy bullets use pre-rendered sprite caches rather than
per-call gradients and multi-pass strokes. Worst case measured (119 enemies, 250 enemy
bullets, 300 pickups, 950 particles — well past real play) is ~5.5ms render, ~7.6ms with
chromatic aberration engaged. **Caveat: measured in a non-compositing headless browser
pane, so these are software-raster figures and not a substitute for testing on a real
mid-range phone.** Quality auto-drops after sampling the first ~140 frames.

**The service worker is network-first on `localhost`** and cache-first everywhere else.
Cache-first in development happily serves the module you edited thirty seconds ago, and
you end up debugging a file the page isn't running. Note `SHELL` uses `addAll`, which is
atomic — one bad path fails the whole install, so keep the list in sync when adding files.

**Streaks are honest.** Miss a day and it resets to 1. No grace period, no freeze, no
"streak repair". Replaying the same day doesn't double-count, and milestones pay out once.

## Judgment calls

These were mine to make; all are cheap to change.

- **No Tone.js.** ~200KB of CDN dependency in an offline-first PWA, when every sound here
  is a short envelope on primitive oscillators plus one noise buffer. Raw Web Audio.
- **Dash instead of a fire button.** Firing is automatic with auto-aim at the nearest
  threat (elites weighted closer). A fire button on an auto-shooter is busywork; a dash is
  a real decision. Manual aim is available in Settings.
- **Arena is bounded** (1500×1500, shrinking under SHROUDED) rather than infinite, so the
  camera can frame the fight and there's no running away forever.
- **Tiers every 55s**, six of them. Background stays near-black and lightly saturated —
  it shares a canvas with the bloom, so a bright background greys the whole frame.
- **Shape is the primary threat read**, colour is secondary — hazard projectiles keep one
  warm hue across every tier because it's the most important read in the game. The
  colourblind setting collapses to a blue/orange axis.
- **Meta bonuses are modest** (~6% per tier). Progression should shorten the ramp, not
  trivialise it, or the daily stops being a fair comparison between players.
- **Faces stay screen-upright** while the hull rotates with aim. A face that rotates with
  the body reads as debris; one that stays level reads as a passenger.
- **Barks are bag-shuffled**, not randomly drawn — random selection on a 16-line pool
  repeats visibly about every fourth line, which is what makes reactive barks feel cheap.

## Characters

Weapons are cores, and each is somebody:

| core | weapon | temperament |
| --- | --- | --- |
| **NIM** | Pulse | Fires first. Thinks later, if at all. |
| **BURR** | Scatter | Panics loudly, in every direction at once. |
| **QUILL** | Lance | Waits. Then only needs the one shot. |

**VANTA**, custodian of the Grid, shows up on the daily brief and the results screen —
taunts a broken streak, grudgingly concedes at milestones.

## Not done

- No backend, so the leaderboard is local-only. A shared daily board is the obvious v2.
- Not yet profiled on real mid-range hardware (see the performance caveat above).
- Enemy bullets lost their per-instance spin when they moved to the sprite path.
- Voice lines are English-only and not externalised for translation.

## PWA fixes (installed-app testing round)

These were reported from the actual installed PWA, not the browser tab, and each had a
distinct root cause — noted here so they read as fixes, not workarounds:

- **Eyes washed out by glow.** The face was drawn inside the same `begin()/end()`
  bracket as the hull, and `end()` blurs the *entire* scene for bloom and adds it back
  on top — that full-frame blur doesn't know the eye sockets are meant to stay dark, so
  it smeared the surrounding hull glow straight over them. Fix: the face is now drawn in
  a separate pass, `Run.drawFaceOverlay()`, called from `main.js` *after* `r.end()` has
  already finished the bloom/chroma/vignette pipeline, via a new `Renderer.
  withWorldTransform()` that re-applies the same camera/shake/zoom transform so it still
  tracks the hull pixel-for-pixel — only the timing relative to bloom changed.
- **Countdown field clipped.** `.daily-meta`'s two columns are a flex row; flex items
  default to `min-width: auto`, so a wide sibling (a long score under "YOUR BEST TODAY")
  refused to shrink and pushed the countdown column past the row's edge. `.card` has
  `overflow: hidden`, so the overflow was invisible rather than visibly squished — it
  just read as "cut off". Fixed with `min-width: 0` on the flex children plus
  `text-overflow: ellipsis` on the values so long numbers truncate instead of forcing
  the layout wider.
- **Score crammed into the corner.** `.hud-top`'s padding was `env(safe-area-inset-*) +
  10-12px`. `display: "fullscreen"` in the manifest is a real known source of
  unreliable safe-area-inset reporting on several Android/iOS versions — when the inset
  reports 0, the score had almost nothing between it and the literal screen edge. Two
  changes: the padding now uses `max(safe-area, floor)` so there's a guaranteed minimum
  regardless of what the inset reports, and the manifest's primary `display` mode was
  changed to `standalone` (well-supported, reliable safe-area reporting) rather than
  `fullscreen` (experimental, spotty support) — see next point.
- **Daily Run button "missing".** No code path hides it — it's static markup, always
  first in the menu, above Practice Run. The likely explanation, given the other two
  bugs above, is the same one: `"display": "fullscreen"` has known viewport/safe-area
  bugs on some devices that can shift or occlude top content unpredictably. Manifest
  now requests `standalone` first; existing installs may need a reinstall to pick up
  the display-mode change; the fix itself is the same as the corner-spacing one.
- **Voice text unreadable at the bottom.** It was fixed to the bottom edge of the
  screen — structurally the least-attended part of the frame during combat. It's now a
  speech bubble re-anchored to the player's live screen position every frame
  (`UI.positionVoiceNear`, driven from the main render loop, clamped inward from the
  edges so it can't render partway off-screen near the arena boundary), with a tail
  pointing down at the character. `pointer-events: none` throughout, so it still can't
  steal a touch meant for the joystick or dash.
- **Silent in the installed PWA.** Root cause was twofold: (1) the unlock listener was
  bound to `window`, and iOS standalone PWAs have been observed not to reliably count a
  window-level listener as a valid user-gesture target for resuming `AudioContext`, even
  though the identical listener works in a normal Safari tab — moved to `document.body`
  plus `touchend`/`click` alternates. (2) `ctx.resume()` can resolve to `"running"` on
  iOS before the render thread has actually started producing audio, silently dropping
  gain automation scheduled in that same tick; a one-sample near-silent oscillator blip
  (`_primeOutput()`) now forces the graph to genuinely start before volume settings are
  applied, so they take effect immediately instead of needing a manual mute/unmute to
  "wake" the graph.

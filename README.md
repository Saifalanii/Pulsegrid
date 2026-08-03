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

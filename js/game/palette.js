// Biome palettes. Each depth tier is ~55s of survival; the arena cross-fades between
// them so a long run visibly escalates.
//
// Judgment calls on colour, flagged for feedback:
//  - Backgrounds are near-black but *tinted* with the tier hue at ~4% lightness. Pure
//    #000 makes the bloom look like it's floating on nothing.
//  - Enemy hue is always pushed ~40-70deg off the player/ally hue so friend/foe never
//    relies on hue alone.
//  - Hazard projectiles are locked to one warm hue across every tier. It's the single
//    most important read in the game, so it never changes meaning.
//  - `colorblind: true` collapses everything to a blue/orange axis, which survives
//    all three common CVD types. Shape still carries the primary signal regardless.

import { hslToRgb, lerpHue, lerp } from '../core/math.js';

export const TIERS = [
  { name: 'CYAN VERGE',     hue: 188, enemyHue: 322, bgHue: 200, accentHue: 168 },
  { name: 'MAGENTA FAULT',  hue: 316, enemyHue: 258, bgHue: 300, accentHue: 340 },
  { name: 'AMBER CORE',     hue: 38,  enemyHue: 350, bgHue: 26,  accentHue: 52 },
  { name: 'LIME RIFT',      hue: 92,  enemyHue: 178, bgHue: 110, accentHue: 74 },
  { name: 'VIOLET ABYSS',   hue: 268, enemyHue: 200, bgHue: 262, accentHue: 292 },
  { name: 'WHITE NULL',     hue: 210, enemyHue: 10,  bgHue: 220, accentHue: 190 },
];

// Locked, tier-independent reads.
export const HAZARD_RGB = [255, 92, 46];    // enemy projectiles
export const HEAL_RGB   = [126, 255, 168];  // health pickups
export const SHARD_RGB  = [255, 214, 92];   // meta currency
export const XP_RGB     = [140, 220, 255];  // xp motes

const CB = { hue: 205, enemyHue: 32, bgHue: 214, accentHue: 190 };

export class Palette {
  constructor() {
    this.tierIndex = 0;
    this.blend = 1;           // 0..1 progress of the cross-fade into tierIndex
    this.colorblind = false;
    this._prev = TIERS[0];
    this._cur = TIERS[0];
    this.compute();
  }

  setColorblind(on) { this.colorblind = on; this.compute(); }

  /** Begin a cross-fade to `i`. */
  goToTier(i) {
    this._prev = this._cur;
    this.tierIndex = Math.min(i, TIERS.length - 1);
    this._cur = TIERS[this.tierIndex];
    this.blend = 0;
  }

  update(dt) {
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 2.2); // 2.2s cross-fade
      this.compute();
    }
  }

  compute() {
    const t = this.blend;
    const a = this._prev, b = this._cur;
    let hue = lerpHue(a.hue, b.hue, t);
    let enemyHue = lerpHue(a.enemyHue, b.enemyHue, t);
    let bgHue = lerpHue(a.bgHue, b.bgHue, t);
    let accentHue = lerpHue(a.accentHue, b.accentHue, t);

    if (this.colorblind) {
      hue = CB.hue; enemyHue = CB.enemyHue; bgHue = CB.bgHue; accentHue = CB.accentHue;
    }

    this.hue = hue;
    this.enemyHue = enemyHue;

    this.primary = hslToRgb(hue, 100, 62);
    this.primaryDim = hslToRgb(hue, 90, 36);
    this.accent = hslToRgb(accentHue, 100, 68);
    this.enemy = hslToRgb(enemyHue, 92, 60);
    this.enemyDim = hslToRgb(enemyHue, 85, 34);
    this.enemyBright = hslToRgb(enemyHue, 100, 76);
    // Background stays very dark and only lightly saturated. It shares a canvas with the
    // bloom pass, so any brightness here gets blurred back over the whole frame — at 62%
    // saturation the warm tiers turned the arena muddy brown. Keep the void inky and let
    // the emissive shapes own the colour.
    this.bg = hslToRgb(bgHue, 42, 3.2);
    this.bgGrid = hslToRgb(bgHue, 65, 9);
    this.mote = hslToRgb(hue, 80, 55);

    this.css = {
      primary: rgbCss(this.primary),
      accent: rgbCss(this.accent),
      enemy: rgbCss(this.enemy),
      bg: rgbCss(this.bg),
    };
  }

  get tierName() { return this._cur.name; }
}

export const rgbCss = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
export const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Cosmetic trail colours, purchased with shards. */
export const TRAILS = {
  trail_cyan:   { name: 'Cyan',   rgb: [80, 230, 255] },
  trail_ember:  { name: 'Ember',  rgb: [255, 150, 60] },
  trail_prism:  { name: 'Prism',  rgb: [190, 130, 255], shift: true },
  trail_void:   { name: 'Void',   rgb: [235, 235, 255], dark: true },
  trail_toxic:  { name: 'Toxic',  rgb: [160, 255, 90] },
  trail_rose:   { name: 'Rose',   rgb: [255, 110, 180] },
};

/** Prism cycles hue over time; everything else is static. */
export function trailColor(id, time) {
  const t = TRAILS[id] || TRAILS.trail_cyan;
  if (t.shift) return hslToRgb((time * 60) % 360, 95, 68);
  return t.rgb;
}

export { lerp };

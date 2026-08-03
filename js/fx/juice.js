// Feel layer: screen shake, hit-stop, chromatic pulse, zoom punch, haptics.
//
// These are deliberately one small module because they're all the same idea — a short
// decaying scalar that other systems read. Keeping them together makes it easy to audit
// the "juice checklist" in one place.

import { clamp, TAU } from '../core/math.js';

export class Juice {
  constructor() {
    this.shake = 0;          // current amplitude in px
    this.shakeScale = 1;     // user accessibility setting, 0 disables entirely
    this.ox = 0; this.oy = 0; // camera offset applied by the renderer
    this.rot = 0;

    this.hitStop = 0;        // seconds of frozen simulation remaining
    this.chroma = 0;         // 0..1 RGB-split intensity
    this.zoom = 1;           // multiplicative camera punch
    this.zoomTarget = 1;
    this.flash = 0;          // full-screen white flash 0..1
    this.vignettePulse = 0;  // red damage vignette 0..1

    this.haptics = true;
    this._seed = Math.random() * 1000;
  }

  addShake(amount) {
    this.shake = Math.min(34, this.shake + amount * this.shakeScale);
  }

  /** Brief freeze-frame. Cumulative up to a cap so a chain of kills still resolves. */
  addHitStop(seconds) {
    this.hitStop = Math.min(0.14, this.hitStop + seconds);
  }

  addChroma(v) { this.chroma = clamp(this.chroma + v, 0, 1); }
  addFlash(v) { this.flash = clamp(this.flash + v, 0, 1); }
  punchZoom(v) { this.zoomTarget = 1 + v; }
  damageVignette(v) { this.vignettePulse = clamp(this.vignettePulse + v, 0, 1); }

  /** Vibration API. Silently no-ops where unsupported or disabled. */
  vibrate(pattern) {
    if (!this.haptics) return;
    if (typeof navigator.vibrate !== 'function') return;
    try { navigator.vibrate(pattern); } catch {}
  }

  /**
   * @param {number} dt real (unscaled) delta
   * @returns {number} how much of dt the simulation should actually consume
   */
  update(dt) {
    let simDt = dt;
    if (this.hitStop > 0) {
      const used = Math.min(this.hitStop, dt);
      this.hitStop -= used;
      // Not a hard zero — a sliver of motion keeps the freeze from looking like a stall.
      simDt = (dt - used) + used * 0.06;
    }

    // Decay. Rates tuned by feel: shake snaps off fast, chroma lingers a touch.
    const decay = (v, rate) => v * Math.exp(-rate * dt);
    this.shake = decay(this.shake, 11);
    if (this.shake < 0.05) this.shake = 0;
    this.chroma = decay(this.chroma, 7);
    this.flash = decay(this.flash, 13);
    this.vignettePulse = decay(this.vignettePulse, 3.2);

    this.zoomTarget += (1 - this.zoomTarget) * Math.min(1, dt * 7);
    this.zoom += (this.zoomTarget - this.zoom) * Math.min(1, dt * 16);

    // Two out-of-phase sines beat a random offset: it reads as an impact ringing out
    // rather than per-frame noise, and it never strobes a single pixel.
    if (this.shake > 0) {
      this._seed += dt * 47;
      const t = this._seed;
      this.ox = (Math.sin(t * 1.9) + Math.sin(t * 5.3) * 0.5) * this.shake * 0.6;
      this.oy = (Math.cos(t * 2.3) + Math.cos(t * 6.1) * 0.5) * this.shake * 0.6;
      this.rot = Math.sin(t * 1.3) * this.shake * 0.00045;
    } else {
      this.ox = this.oy = this.rot = 0;
    }

    return simDt;
  }

  reset() {
    this.shake = this.hitStop = this.chroma = this.flash = this.vignettePulse = 0;
    this.ox = this.oy = this.rot = 0;
    this.zoom = this.zoomTarget = 1;
  }

  // ---- Named presets, so callers describe events rather than tuning numbers inline ----

  smallHit() { this.addShake(1.4); this.vibrate(8); }

  kill(scale = 1) {
    this.addShake(2.6 * scale);
    this.addHitStop(0.022 * scale);
    this.addChroma(0.14 * scale);
    this.vibrate(12);
  }

  bigKill() {
    this.addShake(13);
    this.addHitStop(0.10);
    this.addChroma(0.6);
    this.addFlash(0.28);
    this.punchZoom(0.055);
    this.vibrate([0, 26, 30, 50]);
  }

  playerHurt() {
    this.addShake(15);
    this.addHitStop(0.075);
    this.addChroma(0.75);
    this.damageVignette(0.9);
    this.punchZoom(-0.04);
    this.vibrate([0, 45, 45, 70]);
  }

  levelUp() {
    this.addFlash(0.16);
    this.addChroma(0.3);
    this.punchZoom(0.04);
    this.vibrate([0, 18, 40, 18]);
  }

  dash() { this.addShake(2.2); this.punchZoom(-0.022); this.vibrate(10); }

  tierShift() {
    this.addFlash(0.22);
    this.addChroma(0.5);
    this.punchZoom(0.05);
    this.vibrate([0, 20, 60, 20, 60, 30]);
  }
}

export const juice = new Juice();
export { TAU };

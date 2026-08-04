// Pooled particle system. One flat pool, several "kinds" that differ only in how they
// integrate and draw — cheaper than separate systems and keeps the draw call batched
// under a single additive composite.

import { Pool } from '../core/pool.js';
import { TAU } from '../core/math.js';

export const P_SPARK = 0;   // stretched streak, fast, gravity-free
export const P_DOT = 1;     // round soft dot
export const P_RING = 2;    // expanding stroked ring
export const P_SHARD = 3;   // small rotating triangle, drifts
export const P_MOTE = 4;    // ambient background drifter, never expires
export const P_TEXT = 5;    // floating damage/score number

const make = () => ({
  kind: 0, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1,
  size: 1, endSize: 0, rot: 0, spin: 0, drag: 1, alpha: 1,
  depth: 0,                      // ambient motes only; 0 = near, 1 = far. See mote().
  r: 255, g: 255, b: 255, text: '', _idx: 0,
});

export class Particles {
  constructor(capacity = 900) {
    this.pool = new Pool(capacity, make);
    this.budget = capacity;
  }

  /** Quality scaler: 1 = full, 0.5 = half the particles per burst. */
  setBudget(scale) { this.budget = Math.floor(this.pool.capacity * scale); }

  get count() { return this.pool.active; }

  _emit() {
    // Ambient motes are cheap and re-seeded, so let bursts recycle them under pressure.
    return this.pool.active < this.budget ? this.pool.spawn() : this.pool.spawnOrRecycle();
  }

  spark(x, y, vx, vy, life, size, rgb, kind = P_SPARK) {
    const p = this._emit();
    if (!p) return null;
    p.kind = kind; p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = p.maxLife = life; p.size = size; p.endSize = 0;
    p.rot = 0; p.spin = 0; p.drag = 0.94; p.alpha = 1;
    p.r = rgb[0]; p.g = rgb[1]; p.b = rgb[2];
    return p;
  }

  /** Radial burst — the workhorse for enemy deaths and impacts. */
  burst(x, y, count, speed, rgb, opts = {}) {
    const n = Math.max(1, Math.round(count * (this.budget / this.pool.capacity)));
    const life = opts.life ?? 0.5;
    const size = opts.size ?? 3;
    const spread = opts.spread ?? TAU;
    const dir = opts.dir ?? 0;
    const kind = opts.kind ?? P_SPARK;
    for (let i = 0; i < n; i++) {
      const a = dir + (spread === TAU ? (i / n) * TAU + Math.random() * 0.4 : dir + (Math.random() - 0.5) * spread);
      const s = speed * (0.45 + Math.random() * 0.85);
      const p = this.spark(x, y, Math.cos(a) * s, Math.sin(a) * s,
                           life * (0.6 + Math.random() * 0.7), size * (0.6 + Math.random() * 0.8), rgb, kind);
      if (!p) return;
      if (opts.drag) p.drag = opts.drag;
      if (kind === P_SHARD) { p.rot = Math.random() * TAU; p.spin = (Math.random() - 0.5) * 14; }
    }
  }

  ring(x, y, size, endSize, life, rgb, width = 3) {
    const p = this._emit();
    if (!p) return;
    p.kind = P_RING; p.x = x; p.y = y; p.vx = 0; p.vy = 0;
    p.life = p.maxLife = life; p.size = size; p.endSize = endSize;
    p.rot = width; p.spin = 0; p.drag = 1; p.alpha = 1;
    p.r = rgb[0]; p.g = rgb[1]; p.b = rgb[2];
  }

  text(x, y, str, rgb, life = 0.75, size = 15) {
    const p = this._emit();
    if (!p) return;
    p.kind = P_TEXT; p.x = x; p.y = y;
    p.vx = (Math.random() - 0.5) * 22; p.vy = -62;
    p.life = p.maxLife = life; p.size = size; p.endSize = size;
    p.drag = 0.96; p.text = str;
    p.r = rgb[0]; p.g = rgb[1]; p.b = rgb[2];
  }

  /** Player trail — soft dot with a long fade, emitted on a distance interval. */
  trail(x, y, rgb, size = 5, life = 0.42) {
    const p = this._emit();
    if (!p) return;
    p.kind = P_DOT; p.x = x; p.y = y;
    p.vx = (Math.random() - 0.5) * 12; p.vy = (Math.random() - 0.5) * 12;
    p.life = p.maxLife = life; p.size = size; p.endSize = 0;
    p.drag = 0.9;
    p.r = rgb[0]; p.g = rgb[1]; p.b = rgb[2];
  }

  /**
   * Ambient background mote. Effectively infinite life; recycled under pressure.
   *
   * Each mote gets a `depth` in 0..1 (0 = right behind the action, 1 = far away) and
   * everything else is derived from it, so the field reads as layered space instead of
   * a flat starfield: distant motes are smaller, dimmer, drift slower, and — via the
   * renderer's parallax offset — track the camera less. Previously size and alpha were
   * independently random, which produced a uniform fog with no depth ordering at all.
   */
  mote(x, y, rgb) {
    const p = this._emit();
    if (!p) return;
    // Cubed so most motes land in the far field and only a few sit up close — a flat
    // distribution puts too many big bright dots near the player and reads as noise.
    const depth = Math.pow(Math.random(), 0.55);
    p.kind = P_MOTE; p.x = x; p.y = y; p.depth = depth;
    const near = 1 - depth;
    const a = Math.random() * TAU;
    const s = (2 + Math.random() * 7) * (0.25 + near * 0.95);
    p.vx = Math.cos(a) * s; p.vy = Math.sin(a) * s;
    p.life = p.maxLife = 9999;
    p.size = 0.45 + near * 2.0;
    p.alpha = 0.055 + near * 0.30;
    p.drag = 1;
    p.r = rgb[0]; p.g = rgb[1]; p.b = rgb[2];
  }

  update(dt, bounds) {
    const pool = this.pool;
    for (let i = pool.active - 1; i >= 0; i--) {
      const p = pool.items[i];
      p.life -= dt;
      if (p.life <= 0 && p.kind !== P_MOTE) { pool.releaseAt(i); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.drag !== 1) {
        const d = Math.pow(p.drag, dt * 60);
        p.vx *= d; p.vy *= d;
      }
      if (p.spin) p.rot += p.spin * dt;

      if (p.kind === P_MOTE && bounds) {
        // Wrap motes through the arena so the void always feels populated.
        const m = 40;
        if (p.x < bounds.x - m) p.x = bounds.x + bounds.w + m;
        else if (p.x > bounds.x + bounds.w + m) p.x = bounds.x - m;
        if (p.y < bounds.y - m) p.y = bounds.y + bounds.h + m;
        else if (p.y > bounds.y + bounds.h + m) p.y = bounds.y - m;
      }
    }
  }

  clear() { this.pool.clear(); }

  /** Removes only ambient motes — used on tier change so new-colour motes replace them. */
  clearMotes() {
    const pool = this.pool;
    for (let i = pool.active - 1; i >= 0; i--) {
      if (pool.items[i].kind === P_MOTE) pool.releaseAt(i);
    }
  }
}

// Expressive faces.
//
// Drawn as a layer on top of whatever body the caller already rendered — nothing here
// replaces existing rendering. Two eyes, each a dark socket punched out of the glowing
// hull with a bright pupil inside it. Dark-on-bright is the only thing that reads at
// 14px under heavy bloom; a bright-on-bright face just dissolves into the glow.
//
// The face is always screen-upright even when the hull spins. A face that rotates with
// the body reads as debris; a face that stays level reads as a passenger.
//
// State is a handful of scalars eased toward targets, so expressions blend instead of
// snapping — the same easing discipline as the rest of the juice layer.

import { TAU, clamp, damp } from '../core/math.js';

const VOID = 'rgba(3,6,11,0.94)';

/** Per-core eye geometry. Small numbers, big personality differences. */
export const EYE_STYLES = {
  // Wide, round, credulous.
  eager:  { w: 0.30, h: 0.38, gap: 0.34, y: -0.02, round: 0.45, tilt: 0,     pupil: 0.42 },
  // Narrow and shifty, set slightly wider apart.
  jittery:{ w: 0.26, h: 0.30, gap: 0.40, y: -0.02, round: 0.30, tilt: 0.10,  pupil: 0.34 },
  // Half-lidded and calm. Reads as bored competence.
  calm:   { w: 0.34, h: 0.22, gap: 0.33, y:  0.00, round: 0.50, tilt: -0.06, pupil: 0.40 },
  // The rival: tall, narrow, unimpressed.
  smug:   { w: 0.24, h: 0.34, gap: 0.36, y: -0.03, round: 0.35, tilt: -0.20, pupil: 0.36 },
};

export class Face {
  /**
   * @param {string} style key into EYE_STYLES
   * @param {object} opts { blinkEvery, pupilRgb }
   */
  constructor(style = 'eager', opts = {}) {
    this.style = EYE_STYLES[style] ? style : 'eager';
    this.pupilRgb = opts.pupilRgb || null;   // null = inherit body colour

    this.open = 1;        // 0 = shut, 1 = normal, >1 = widened
    this.openTarget = 1;
    this.squint = 0;      // 0..1, narrows and angles the inner corners
    this.squintTarget = 0;
    this.lookX = 0;       // -1..1 pupil offset
    this.lookY = 0;
    this.lookTargetX = 0;
    this.lookTargetY = 0;

    this._blinkT = this._nextBlinkDelay(opts.blinkEvery);
    this._blinkPhase = -1;                    // -1 = not blinking, else 0..1
    this._blinkEvery = opts.blinkEvery || [2.2, 6.5];
  }

  _nextBlinkDelay(range) {
    const [a, b] = range || [2.2, 6.5];
    return a + Math.random() * (b - a);
  }

  /** Immediate wide-eyed reaction. */
  startle(amount = 1) {
    this.open = 1 + 0.75 * amount;
    this.openTarget = 1 + 0.35 * amount;
    this._blinkPhase = -1;
    this._blinkT = Math.max(this._blinkT, 0.9);   // don't blink mid-flinch
  }

  /** Narrow the eyes — used while firing. Decays on its own. */
  focus(amount = 1) { this.squintTarget = Math.max(this.squintTarget, clamp(amount, 0, 1)); }

  /** Aim the gaze at a world point relative to the face's own position. */
  lookAt(dx, dy) {
    const d = Math.hypot(dx, dy);
    if (d < 0.001) { this.lookTargetX = 0; this.lookTargetY = 0; return; }
    // Saturates quickly: anything past ~120px is "over there", not "further over there".
    const k = Math.min(1, d / 120);
    this.lookTargetX = (dx / d) * k;
    this.lookTargetY = (dy / d) * k;
  }

  lookForward() { this.lookTargetX = 0; this.lookTargetY = 0; }

  update(dt) {
    // Blink cycle: fast close, slightly slower open.
    if (this._blinkPhase >= 0) {
      this._blinkPhase += dt / 0.13;
      if (this._blinkPhase >= 1) {
        this._blinkPhase = -1;
        this._blinkT = this._nextBlinkDelay(this._blinkEvery);
      }
    } else {
      this._blinkT -= dt;
      if (this._blinkT <= 0) this._blinkPhase = 0;
    }

    this.openTarget = damp(this.openTarget, 1, 3.5, dt);
    this.open = damp(this.open, this.openTarget, 14, dt);
    this.squintTarget = damp(this.squintTarget, 0, 6, dt);
    this.squint = damp(this.squint, this.squintTarget, 18, dt);
    this.lookX = damp(this.lookX, this.lookTargetX, 11, dt);
    this.lookY = damp(this.lookY, this.lookTargetY, 11, dt);
  }

  /** Current lid opening, 0..1+, including the blink. */
  get lid() {
    let v = this.open * (1 - this.squint * 0.62);
    if (this._blinkPhase >= 0) {
      // Triangle wave: 1 -> 0 -> 1 across the blink.
      const t = this._blinkPhase;
      v *= t < 0.5 ? 1 - t * 2 : (t - 0.5) * 2;
    }
    return Math.max(0, v);
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x,y centre of the face
   * @param {number} size overall face scale (roughly the body radius)
   * @param {number[]} pupilRgb bright colour for the pupils
   */
  draw(ctx, x, y, size, pupilRgb) {
    const s = EYE_STYLES[this.style];
    const lid = this.lid;
    const rgb = this.pupilRgb || pupilRgb || [255, 255, 255];

    const eyeW = s.w * size;
    const eyeH = s.h * size * lid;
    const gap = s.gap * size;
    const cy = y + s.y * size;

    // Sockets must be opaque over the glow, so this pass is source-over regardless of
    // the additive mode the entity pass is running in.
    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'source-over';

    for (let i = 0; i < 2; i++) {
      const dir = i === 0 ? -1 : 1;
      const ex = x + dir * gap;
      // Inner corners drop when squinting -> a focused, slightly mean look.
      const tilt = (s.tilt + this.squint * 0.34) * dir;

      ctx.save();
      ctx.translate(ex, cy);
      ctx.rotate(tilt);

      if (eyeH > 0.6) {
        ctx.fillStyle = VOID;
        roundedRect(ctx, -eyeW / 2, -eyeH / 2, eyeW, eyeH, Math.min(eyeW, eyeH) * s.round);
        ctx.fill();

        // Pupil: bright, offset by gaze, clamped inside the socket so it never escapes.
        const pr = Math.min(eyeW, eyeH) * s.pupil;
        if (pr > 0.4) {
          const maxX = Math.max(0, eyeW / 2 - pr - 0.6);
          const maxY = Math.max(0, eyeH / 2 - pr - 0.6);
          ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
          ctx.beginPath();
          ctx.arc(this.lookX * maxX, this.lookY * maxY, pr, 0, TAU);
          ctx.fill();
        }
      } else {
        // Fully shut: a dark lash line, so blinking doesn't make the face vanish.
        ctx.fillStyle = VOID;
        roundedRect(ctx, -eyeW / 2, -0.9, eyeW, 1.8, 0.9);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.globalCompositeOperation = prevOp;
  }
}

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, rr); return; }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ---------------------------------------------------------------- portraits
//
// Small self-contained canvases for the menu/brief/end screens. Each owns one Face and
// draws a simple glowing body behind it, reusing the same geometric language as the
// arena so the characters read as things that live in the game rather than UI art.

export class Portrait {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ sides:number, rgb:number[], eyeStyle:string, spin:number }} def
   */
  constructor(canvas, def) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.def = def;
    this.face = new Face(def.eyeStyle, { pupilRgb: def.pupilRgb });
    this.rot = 0;
    this.t = Math.random() * 10;
    this._sized = false;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || 72, h = rect.height || 72;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssW = w; this.cssH = h;
    this._sized = true;
  }

  /** Gaze wanders idly so portraits don't look like taxidermy. */
  update(dt) {
    this.t += dt;
    this.rot += (this.def.spin ?? 0.5) * dt;
    this.face.lookAt(Math.sin(this.t * 0.7) * 90, Math.cos(this.t * 0.53) * 60);
    this.face.update(dt);
  }

  draw() {
    if (!this._sized) this.resize();
    const ctx = this.ctx;
    const w = this.cssW, h = this.cssH;
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * 0.34;
    const rgb = this.def.rgb;

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    // Soft halo.
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 2.4);
    g.addColorStop(0, `rgba(${rgb},0.42)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Body: same stroke-then-white-core treatment as the arena entities.
    const breathe = 1 + Math.sin(this.t * 1.6) * 0.025;
    ctx.beginPath();
    const sides = this.def.sides;
    for (let i = 0; i < sides; i++) {
      const a = this.rot + (i / sides) * TAU - Math.PI / 2;
      const px = cx + Math.cos(a) * R * breathe, py = cy + Math.sin(a) * R * breathe;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(${rgb},0.30)`;
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(${rgb},0.95)`;
    ctx.stroke();
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();

    ctx.globalCompositeOperation = 'source-over';
    this.face.draw(ctx, cx, cy, R * 1.55, this.def.pupilRgb || [255, 255, 255]);
  }
}

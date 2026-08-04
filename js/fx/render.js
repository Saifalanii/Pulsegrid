// Canvas 2D renderer with a fake-HDR glow pipeline.
//
// Pipeline per frame:
//   1. clear scene canvas to the tinted void colour
//   2. background: parallax grid + arena boundary + ambient motes
//   3. entities & particles, all drawn with globalCompositeOperation = 'lighter'
//      Each shape is 2 passes: a saturated wide stroke, then a near-white thin core.
//      That's what sells "emissive" — the core reads as blown-out highlight.
//   4. downsample the scene to a quarter-res buffer, blur it, add it back on top.
//      This is the bloom. Quarter res makes the blur ~16x cheaper and nobody can tell.
//   5. post: chromatic aberration (only when juice.chroma is live), flash, vignettes
//
// `ctx.filter` is the fast path for the blur. Where it's missing (older WebKit) we fall
// back to a 5-tap offset accumulation, which is blurrier and cheaper — acceptable.

import { rgba, HAZARD_RGB } from '../game/palette.js';
import { TAU, clamp } from '../core/math.js';
import { P_SPARK, P_DOT, P_RING, P_SHARD, P_MOTE, P_TEXT } from './particles.js';

const MAX_DPR = 2;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    this.bloomCanvas = document.createElement('canvas');
    this.bloomCtx = this.bloomCanvas.getContext('2d');
    this.chromaCanvas = document.createElement('canvas');
    this.chromaCtx = this.chromaCanvas.getContext('2d');

    // Pre-rendered sprites, keyed by quantised colour. See _glowSprite / _polySprite.
    this._glowCache = new Map();
    this._polyCache = new Map();

    this.supportsFilter = typeof this.bloomCtx.filter === 'string';
    this.quality = 'high';   // high | low
    this.bloomDiv = 4;

    this.camX = 0; this.camY = 0;
    this.baseScale = 1;
    // Slow danger zoom, driven by updateCamera(). Kept as a multiplier on baseScale
    // rather than a separate transform so that viewW/viewH — and therefore the camera
    // clamping and the grid's draw extents — stay consistent with what's on screen.
    this.zoomBias = 1;
    this.w = 0; this.h = 0;      // css px
    this.dpr = 1;

    this.resize();
  }

  setQuality(q) {
    this.quality = q;
    this.bloomDiv = q === 'high' ? 4 : 6;
    this.resize();
  }

  resize() {
    // A resize event can fire while the viewport still reports 0 — mid orientation
    // change, or on a backgrounded tab. Without the clamp the canvas becomes 0x0 and
    // the next bloom pass throws InvalidStateError on drawImage with an empty source,
    // killing the render loop for good.
    const cssW = Math.max(1, window.innerWidth || 1);
    const cssH = Math.max(1, window.innerHeight || 1);
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality === 'low' ? 1.5 : MAX_DPR);
    this.w = cssW; this.h = cssH; this.dpr = dpr;

    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';

    const bw = Math.max(1, Math.round(this.canvas.width / this.bloomDiv));
    const bh = Math.max(1, Math.round(this.canvas.height / this.bloomDiv));
    this.bloomCanvas.width = bw; this.bloomCanvas.height = bh;
    this.chromaCanvas.width = bw; this.chromaCanvas.height = bh;

    // World-units-visible: keeps the player a consistent physical size across devices.
    const minDim = Math.min(cssW, cssH);
    this.baseScale = clamp(minDim / 480, 0.5, 1.7);

    this._vignette = null;
    this._dmgVignette = null;
  }

  /**
   * World -> screen, for placing DOM elements over the canvas (the voice speech-bubble
   * and its tail).
   *
   * Bug this fixes: this used to ignore juice's screen-shake offset, zoom-punch and
   * rotation, while the actual face/hull render pass (begin() / withWorldTransform())
   * applies all three. The DOM bubble and the canvas face were computed from two
   * different transforms that only agreed when juice was fully at rest — the instant
   * any shake kicked in (getting hit, a kill, even ordinary weapon recoil), the two
   * positions diverged. The bubble has a solid dark background, so when it drifted onto
   * the player it visually blotted out the eyes. Now it takes the same `juice` used for
   * begin()/withWorldTransform() and applies the identical transform, so the two can
   * never disagree.
   */
  worldToScreen(wx, wy, juice, out = {}) {
    const z = this.scale * juice.zoom;
    // Rotate the world offset by juice.rot before scaling — must match begin()'s
    // ctx.rotate(juice.rot) applied before ctx.scale(), or the two paths diverge again
    // the moment shake introduces any rotation.
    const dx = wx - this.camX, dy = wy - this.camY;
    const cos = Math.cos(juice.rot), sin = Math.sin(juice.rot);
    const rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
    out.x = rx * z + juice.ox + this.w / 2;
    out.y = ry * z + juice.oy + this.h / 2;
    return out;
  }

  /** Effective world->screen scale, including the slow danger zoom. */
  get scale() { return this.baseScale * this.zoomBias; }

  get viewW() { return this.w / this.scale; }
  get viewH() { return this.h / this.scale; }

  /**
   * Follow the player, clamped so the camera never shows outside the arena.
   *
   * @param {number} intensity 0..1 danger level; drives a slow zoom-in so the frame
   *   tightens as things get hairy. Separate from juice.zoom, which is the sharp
   *   per-impact punch — this is the slow one you feel rather than see.
   */
  updateCamera(targetX, targetY, arena, dt, lead = { x: 0, y: 0 }, intensity = 0) {
    const vw = this.viewW, vh = this.viewH;

    // Very slow lissajous drift. Amplitude is a few world units — far too small to
    // fight the player for control of the framing, but enough that a held-still camera
    // never looks frozen. Two incommensurate periods so it doesn't visibly loop.
    this._driftT = (this._driftT || 0) + dt;
    const dxDrift = Math.sin(this._driftT * 0.23) * 7 + Math.sin(this._driftT * 0.61) * 2.5;
    const dyDrift = Math.cos(this._driftT * 0.19) * 6 + Math.cos(this._driftT * 0.47) * 2.0;

    let tx = targetX + lead.x + dxDrift, ty = targetY + lead.y + dyDrift;

    if (arena.w > vw) tx = clamp(tx, arena.x + vw / 2, arena.x + arena.w - vw / 2);
    else tx = arena.x + arena.w / 2;
    if (arena.h > vh) ty = clamp(ty, arena.y + vh / 2, arena.y + arena.h - vh / 2);
    else ty = arena.y + arena.h / 2;

    const k = 1 - Math.exp(-9 * dt);
    this.camX += (tx - this.camX) * k;
    this.camY += (ty - this.camY) * k;

    // Danger zoom: up to +6% at full intensity, eased over ~2s so it never snaps.
    // Applied to `scale` via zoomBias, which resize() re-reads.
    const wantBias = 1 + intensity * 0.06;
    this.zoomBias += (wantBias - this.zoomBias) * (1 - Math.exp(-0.9 * dt));
  }

  snapCamera(x, y) { this.camX = x; this.camY = y; }

  // ------------------------------------------------------------------ frame

  /** Self-heal if a bogus resize left us sized to something the viewport isn't. */
  syncSize() {
    const w = Math.max(1, window.innerWidth || 1);
    const h = Math.max(1, window.innerHeight || 1);
    if (w !== this.w || h !== this.h) this.resize();
  }

  /**
   * Re-applies the exact camera/shake/zoom transform begin() used, without touching
   * the background or compositing state, then hands the context to `fn` and restores.
   *
   * Exists so a caller can draw something in world coordinates that lands in the
   * right place on screen but *after* end() has already run the bloom/chroma/vignette
   * pipeline — e.g. the player's face, which needs to track the hull exactly but must
   * not be smeared by the full-scene blur bloom does. Call after end(), not between
   * begin()/end(); this only sets the transform, it doesn't clear or composite.
   */
  withWorldTransform(juice, fn) {
    const ctx = this.ctx;
    ctx.save();
    this._applyWorldTransform(juice);
    fn(ctx);
    ctx.restore();
  }

  /**
   * Sets the camera/shake/zoom transform from scratch (resets any existing transform
   * first). Single source of truth — begin(), withWorldTransform() and the background
   * pass all route through here, so they can't drift apart the way worldToScreen()
   * once did.
   */
  _applyWorldTransform(juice) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const z = this.scale * juice.zoom;
    ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
    ctx.rotate(juice.rot);
    ctx.scale(z * this.dpr, z * this.dpr);
    ctx.translate(-this.camX + juice.ox / z, -this.camY + juice.oy / z);
  }

  begin(palette, juice) {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    // Stashed so drawBackground() can restore the world transform after its
    // screen-space ambient wash without needing juice threaded through every caller.
    this._lastJuice = juice;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.css.bg;
    ctx.fillRect(0, 0, width, height);

    this._applyWorldTransform(juice);
  }

  end(palette, juice) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    this._bloom(juice);
    if (this.quality === 'high' && juice.chroma > 0.015) this._chroma(juice);

    this._vignettes(palette, juice);

    if (juice.flash > 0.004) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,255,255,${juice.flash * 0.9})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  _bloom(juice) {
    const b = this.bloomCtx, bc = this.bloomCanvas;
    const bw = bc.width, bh = bc.height;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = 'source-over';
    b.globalAlpha = 1;
    b.clearRect(0, 0, bw, bh);

    if (this.supportsFilter) {
      b.filter = `blur(${this.quality === 'high' ? 3.2 : 2.2}px)`;
      b.drawImage(this.canvas, 0, 0, bw, bh);
      b.filter = 'none';
    } else {
      // 5-tap cross. Cheap, and after the 4x downsample it's close enough.
      b.globalAlpha = 0.28;
      const o = 1.4;
      b.drawImage(this.canvas, 0, 0, bw, bh);
      b.drawImage(this.canvas, -o, 0, bw, bh);
      b.drawImage(this.canvas, o, 0, bw, bh);
      b.drawImage(this.canvas, 0, -o, bw, bh);
      b.drawImage(this.canvas, 0, o, bw, bh);
      b.globalAlpha = 1;
    }

    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    // Additive bloom has no tone-mapping, so energy just accumulates. At 0.78 a busy
    // frame lifted the far corners from ~(12,7,5) to ~(106,50,42) — the whole void
    // washed to a flat haze and the "near-black arena" read was gone. 0.52 keeps the
    // cores blooming without the low-frequency spill.
    ctx.globalAlpha = this.quality === 'high' ? 0.52 : 0.44;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bc, 0, 0, this.canvas.width, this.canvas.height);
    // Second, wider pass gives the glow a long soft skirt. This is the pass that spreads
    // energy globally, so it stays very low.
    if (this.quality === 'high') {
      ctx.globalAlpha = 0.12;
      const g = this.canvas.width * 0.012;
      ctx.drawImage(bc, -g, -g, this.canvas.width + g * 2, this.canvas.height + g * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** RGB split, driven off the (already blurred) bloom buffer so it stays cheap. */
  _chroma(juice) {
    const c = this.chromaCtx, cc = this.chromaCanvas;
    const cw = cc.width, ch = cc.height;
    const ctx = this.ctx;
    const off = juice.chroma * this.canvas.width * 0.006;

    for (const [tint, dx] of [['#ff0000', off], ['#00ffff', -off]]) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 1;
      c.clearRect(0, 0, cw, ch);
      c.drawImage(this.bloomCanvas, 0, 0);
      c.globalCompositeOperation = 'multiply';
      c.fillStyle = tint;
      c.fillRect(0, 0, cw, ch);
      // Re-mask to the source alpha so the tint doesn't fill the empty void.
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(this.bloomCanvas, 0, 0);

      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = juice.chroma * 0.55;
      ctx.drawImage(cc, dx, 0, this.canvas.width, this.canvas.height);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _vignettes(palette, juice) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    if (!this._vignette) {
      // Reaches full strength inside the frame (0.62 of the long edge) rather than past
      // the corner, so the corners actually get the full darkening instead of ~65% of it.
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.22, W / 2, H / 2, Math.max(W, H) * 0.62);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.65, 'rgba(0,0,0,0.42)');
      g.addColorStop(1, 'rgba(0,0,0,0.88)');
      this._vignette = g;
    }
    ctx.fillStyle = this._vignette;
    ctx.fillRect(0, 0, W, H);

    if (juice.vignettePulse > 0.004) {
      // Built once and modulated with globalAlpha — creating this gradient per frame
      // meant allocating one on every frame of every hit reaction.
      if (!this._dmgVignette) {
        const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.18, W / 2, H / 2, Math.max(W, H) * 0.62);
        g.addColorStop(0, 'rgba(255,40,60,0)');
        g.addColorStop(1, 'rgba(255,30,55,0.62)');
        this._dmgVignette = g;
      }
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = juice.vignettePulse;
      ctx.fillStyle = this._dmgVignette;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ------------------------------------------------------------ background

  /**
   * Ambient floor light — a broad radial wash sitting under everything, so the void
   * isn't dead flat black.
   *
   * Drawn in *screen* space with a cached gradient. Cached because
   * createRadialGradient() allocates, and this covers the whole canvas every frame;
   * rebuilt only when the size or the tier hue changes, which is at most once every
   * 55 seconds rather than 60 times a second.
   */
  _ambientWash(palette) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const key = `${W}x${H}|${Math.round(palette.hue)}`;
    if (this._washKey !== key) {
      const g = ctx.createRadialGradient(W / 2, H * 0.46, 0, W / 2, H * 0.46, Math.max(W, H) * 0.62);
      g.addColorStop(0, rgba(palette.bgGrid, 0.20));
      g.addColorStop(0.45, rgba(palette.bgGrid, 0.085));
      g.addColorStop(1, rgba(palette.bgGrid, 0));
      this._wash = g;
      this._washKey = key;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = this._wash;
    ctx.fillRect(0, 0, W, H);
  }

  /**
   * Parallax depth grid.
   *
   * Judgment call, flagged: the brief asked for a tilted/receding perspective grid with
   * a horizon. A literal horizon can't work here — this is a top-down camera over a
   * bounded arena, and a vanishing point would put the grid in a different space from
   * the entities standing on it, so the floor would visibly slide against the enemies
   * walking on it. Instead this gets depth the way a top-down game honestly can: three
   * grid layers at different simulated depths, each parallaxing against the camera by a
   * different factor and fading with distance. Nearer layers are brighter, wider-spaced
   * and track the camera 1:1; deeper layers are dimmer, denser and lag behind. That
   * produces real motion parallax — the strongest depth cue available — without lying
   * about where the floor is.
   */
  _depthGrid(palette, time) {
    const ctx = this.ctx;
    const vw = this.viewW, vh = this.viewH;
    const pulse = 0.5 + Math.sin(time * 0.7) * 0.12;

    // [spacing, parallax factor, alpha, lineWidth]
    // parallax 1 = locked to the world; < 1 = drifts behind, reading as further away.
    const LAYERS = [
      [256, 1.00, 0.30 * 1.00, 1.6],
      [128, 0.72, 0.15 * pulse, 1.1],
      [64,  0.48, 0.09 * pulse, 0.8],
    ];

    for (const [step, par, alpha, lw] of LAYERS) {
      // Offset the layer's origin by the un-tracked fraction of camera motion.
      const ox = this.camX * (1 - par);
      const oy = this.camY * (1 - par);
      const l = this.camX - vw / 2 - 60, r = this.camX + vw / 2 + 60;
      const t = this.camY - vh / 2 - 60, b = this.camY + vh / 2 + 60;
      ctx.lineWidth = lw / this.scale;
      ctx.strokeStyle = rgba(palette.bgGrid, alpha);
      this._grid(ctx, l, t, r, b, step, ox, oy);
    }
  }

  drawBackground(palette, arena, time) {
    const ctx = this.ctx;

    // Screen-space wash first, then restore the world transform for the grid.
    this._ambientWash(palette);
    this._applyWorldTransform(this._lastJuice);

    ctx.globalCompositeOperation = 'lighter';
    this._depthGrid(palette, time);
    this._arenaBorder(ctx, palette, arena, time);
    ctx.globalCompositeOperation = 'source-over';
  }

  _grid(ctx, l, t, r, b, step, ox = 0, oy = 0) {
    ctx.beginPath();
    // Phase the lattice by the parallax offset, then snap to the step grid so the
    // number of lines drawn stays bounded regardless of how far the camera has moved.
    const px = ox % step, py = oy % step;
    const x0 = Math.floor((l - px) / step) * step + px;
    const y0 = Math.floor((t - py) / step) * step + py;
    for (let x = x0; x <= r; x += step) { ctx.moveTo(x, t); ctx.lineTo(x, b); }
    for (let y = y0; y <= b; y += step) { ctx.moveTo(l, y); ctx.lineTo(r, y); }
    ctx.stroke();
  }

  _arenaBorder(ctx, palette, a, time) {
    const p = 6 + Math.sin(time * 2.4) * 2.5;
    ctx.lineWidth = (2 + p * 0.35) / this.scale;
    ctx.strokeStyle = rgba(palette.primary, 0.16);
    ctx.strokeRect(a.x, a.y, a.w, a.h);
    ctx.lineWidth = 1.4 / this.scale;
    ctx.strokeStyle = rgba(palette.primary, 0.55);
    ctx.strokeRect(a.x, a.y, a.w, a.h);

    // Corner brackets — reads as "containment field" and helps orientation.
    const L = 70;
    ctx.lineWidth = 3.5 / this.scale;
    ctx.strokeStyle = rgba(palette.accent, 0.8);
    ctx.beginPath();
    for (const [cx, cy, sx, sy] of [
      [a.x, a.y, 1, 1], [a.x + a.w, a.y, -1, 1],
      [a.x, a.y + a.h, 1, -1], [a.x + a.w, a.y + a.h, -1, -1],
    ]) {
      ctx.moveTo(cx + sx * L, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + sy * L);
    }
    ctx.stroke();
  }

  // ------------------------------------------------------- shape primitives
  //
  // Every emissive shape goes through the same 2-pass treatment. `intensity` scales
  // the core brightness — used for flash-on-hit without allocating new colours.

  polyPath(ctx, x, y, r, sides, rot) {
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = rot + (i / sides) * TAU;
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /** Stroked emissive polygon. */
  glowPoly(x, y, r, sides, rot, rgb, width = 3, intensity = 1, fillAlpha = 0.08) {
    const ctx = this.ctx;
    this.polyPath(ctx, x, y, r, sides, rot);
    if (fillAlpha > 0) { ctx.fillStyle = rgba(rgb, fillAlpha * intensity); ctx.fill(); }
    ctx.lineJoin = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = rgba(rgb, 0.85 * intensity);
    ctx.stroke();
    ctx.lineWidth = width * 0.36;
    ctx.strokeStyle = `rgba(255,255,255,${0.85 * intensity})`;
    ctx.stroke();
  }

  glowCircle(x, y, r, rgb, width = 3, intensity = 1, fillAlpha = 0.08) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    if (fillAlpha > 0) { ctx.fillStyle = rgba(rgb, fillAlpha * intensity); ctx.fill(); }
    ctx.lineWidth = width;
    ctx.strokeStyle = rgba(rgb, 0.85 * intensity);
    ctx.stroke();
    ctx.lineWidth = width * 0.36;
    ctx.strokeStyle = `rgba(255,255,255,${0.85 * intensity})`;
    ctx.stroke();
  }

  /**
   * Pre-rendered soft radial glow, one sprite per colour.
   *
   * This used to build a fresh createRadialGradient on every call. With a few hundred
   * projectiles, pickups and orbs on screen that was ~600 gradient objects allocated and
   * thrown away every frame — the single biggest cost in the renderer and a direct
   * contradiction of the no-allocation-in-hot-loops rule.
   *
   * Colours are quantised to 5 bits per channel so the 2.2s tier cross-fade (which walks
   * the hue continuously) reuses sprites instead of minting a new one per frame. The
   * cache is cleared if it ever grows past a sane bound.
   */
  _glowSprite(rgb) {
    const key = ((rgb[0] >> 3) << 10) | ((rgb[1] >> 3) << 5) | (rgb[2] >> 3);
    let s = this._glowCache.get(key);
    if (s) return s;

    if (this._glowCache.size > 96) this._glowCache.clear();
    const S = 64;
    s = document.createElement('canvas');
    s.width = s.height = S;
    const c = s.getContext('2d');
    // Multi-stop falloff approximating inverse-square, replacing a near-linear 3-stop
    // ramp. A linear alpha ramp is exactly what reads as a flat halo pasted around the
    // shape: it holds too much brightness out at the rim, then stops abruptly. Real
    // light falls off steeply near the source and then trails a long way — which is
    // what these stops describe: steep to ~0.38, then a long low skirt to the edge.
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0.00, 'rgba(255,255,255,0.98)');
    g.addColorStop(0.12, 'rgba(255,255,255,0.70)');
    g.addColorStop(0.24, rgba(rgb, 0.76));
    g.addColorStop(0.38, rgba(rgb, 0.40));
    g.addColorStop(0.55, rgba(rgb, 0.17));
    g.addColorStop(0.74, rgba(rgb, 0.055));
    g.addColorStop(1.00, rgba(rgb, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
    this._glowCache.set(key, s);
    return s;
  }

  /**
   * Pre-rendered emissive polygon sprite (glow + saturated edge + white core baked in).
   *
   * For objects that appear in the hundreds and never change size — enemy bullets above
   * all — this collapses a fill plus two strokes plus a gradient orb into one drawImage.
   * Path stroking is the single most expensive thing in the entity pass, so trading
   * per-instance rotation for a static sprite is a good deal on the bullets; enemies
   * keep the real path renderer because their rotation is a readability cue.
   */
  _polySprite(sides, rgb) {
    const key = `${sides}:${(rgb[0] >> 3)},${(rgb[1] >> 3)},${(rgb[2] >> 3)}`;
    let s = this._polyCache.get(key);
    if (s) return s;
    if (this._polyCache.size > 48) this._polyCache.clear();

    const S = 64, c0 = S / 2, rad = S * 0.24;
    s = document.createElement('canvas');
    s.width = s.height = S;
    const c = s.getContext('2d');

    const g = c.createRadialGradient(c0, c0, 0, c0, c0, c0);
    g.addColorStop(0, rgba(rgb, 0.55));
    g.addColorStop(1, rgba(rgb, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);

    c.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = -Math.PI / 2 + (i / sides) * TAU;
      const px = c0 + Math.cos(a) * rad, py = c0 + Math.sin(a) * rad;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.closePath();
    c.fillStyle = rgba(rgb, 0.35);
    c.fill();
    c.lineJoin = 'round';
    c.lineWidth = 4;
    c.strokeStyle = rgba(rgb, 0.9);
    c.stroke();
    c.lineWidth = 1.6;
    c.strokeStyle = 'rgba(255,255,255,0.95)';
    c.stroke();

    this._polyCache.set(key, s);
    return s;
  }

  /** Draws a _polySprite centred at x,y with the given world radius. */
  spritePoly(x, y, r, sides, rgb, intensity = 1) {
    const s = this._polySprite(sides, rgb);
    const ctx = this.ctx;
    // The sprite's polygon radius is 0.24 of the sheet, so drawing the sheet at
    // r / 0.24 across makes `r` mean the same thing it does for glowPoly.
    const half = r / 0.48;
    if (intensity !== 1) ctx.globalAlpha = intensity;
    ctx.drawImage(s, x - half, y - half, half * 2, half * 2);
    if (intensity !== 1) ctx.globalAlpha = 1;
  }

  /** Soft filled orb — used for the player core, pickups, projectile heads. */
  glowOrb(x, y, r, rgb, intensity = 1) {
    const ctx = this.ctx;
    const s = this._glowSprite(rgb);
    if (intensity !== 1) ctx.globalAlpha = intensity;
    ctx.drawImage(s, x - r, y - r, r * 2, r * 2);
    if (intensity !== 1) ctx.globalAlpha = 1;
  }

  glowArc(x, y, r, from, to, rgb, width, intensity = 1) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, from, to);
    ctx.lineCap = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = rgba(rgb, 0.85 * intensity);
    ctx.stroke();
    ctx.lineWidth = width * 0.4;
    ctx.strokeStyle = `rgba(255,255,255,${0.8 * intensity})`;
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  /** Motion-stretched projectile: a capsule aligned to velocity. */
  glowStreak(x, y, dx, dy, len, width, rgb, intensity = 1) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.lineTo(0, 0);
    ctx.lineCap = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = rgba(rgb, 0.7 * intensity);
    ctx.stroke();
    ctx.lineWidth = width * 0.42;
    ctx.strokeStyle = `rgba(255,255,255,${0.9 * intensity})`;
    ctx.stroke();
    ctx.restore();
    ctx.lineCap = 'butt';
  }

  // ------------------------------------------------------------- particles

  drawParticles(particles) {
    const ctx = this.ctx;
    const pool = particles.pool;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    for (let i = 0; i < pool.active; i++) {
      const p = pool.items[i];
      const t = p.kind === P_MOTE ? 1 : p.life / p.maxLife;

      switch (p.kind) {
        case P_SPARK: {
          const a = t * t;
          const sp = Math.hypot(p.vx, p.vy);
          const stretch = Math.min(22, sp * 0.02);
          ctx.strokeStyle = `rgba(${p.r},${p.g},${p.b},${a})`;
          ctx.lineWidth = p.size * t;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - (p.vx / (sp || 1)) * stretch, p.y - (p.vy / (sp || 1)) * stretch);
          ctx.stroke();
          break;
        }
        case P_DOT: {
          const a = t * t * 0.9;
          const r = Math.max(0.4, p.size * t);
          ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${a})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
          break;
        }
        case P_MOTE: {
          // Parallax by depth: a far mote (depth -> 1) is pulled back toward the
          // camera centre, so it slides across the screen more slowly than the world
          // does. This is what actually sells the layering — size and alpha alone just
          // look like differently-sized dots on one plane.
          const par = p.depth * 0.55;
          const mx = p.x + (this.camX - p.x) * par;
          const my = p.y + (this.camY - p.y) * par;
          ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.alpha})`;
          ctx.beginPath(); ctx.arc(mx, my, p.size, 0, TAU); ctx.fill();
          break;
        }
        case P_RING: {
          const k = 1 - t;
          const r = p.size + (p.endSize - p.size) * (1 - Math.pow(1 - k, 3));
          ctx.strokeStyle = `rgba(${p.r},${p.g},${p.b},${t * 0.85})`;
          ctx.lineWidth = Math.max(0.5, p.rot * t);
          ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.5, r), 0, TAU); ctx.stroke();
          break;
        }
        case P_SHARD: {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          const s = p.size * t * 1.6;
          ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${t})`;
          ctx.beginPath();
          ctx.moveTo(0, -s); ctx.lineTo(s * 0.86, s * 0.5); ctx.lineTo(-s * 0.86, s * 0.5);
          ctx.closePath(); ctx.fill();
          ctx.restore();
          break;
        }
        case P_TEXT: {
          const a = Math.min(1, t * 2.2);
          ctx.font = `700 ${p.size}px "Rajdhani", system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${a})`;
          ctx.fillText(p.text, p.x, p.y);
          break;
        }
      }
    }
    ctx.lineCap = 'butt';
    ctx.globalCompositeOperation = 'source-over';
  }

  /** On-screen joystick ring, drawn in screen space after the world pass. */
  drawStick(visual, palette) {
    if (!visual) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(palette.primary, 0.28);
    ctx.beginPath(); ctx.arc(visual.ox, visual.oy, visual.r, 0, TAU); ctx.stroke();
    ctx.fillStyle = rgba(palette.primary, 0.05);
    ctx.fill();
    ctx.strokeStyle = rgba(palette.primary, 0.7);
    ctx.beginPath(); ctx.arc(visual.kx, visual.ky, 24, 0, TAU); ctx.stroke();
    ctx.fillStyle = rgba(palette.primary, 0.18);
    ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  set globalAlpha(v) { this.ctx.globalAlpha = v; }
}

export { HAZARD_RGB };

// The run simulation: entities, director, collision, scoring, drawing.
//
// Everything lives in fixed-capacity pools created once in the constructor. The update
// path allocates nothing — no closures, no temporary vectors, no array literals — so a
// four-minute run never triggers a GC pause.

import { Pool } from '../core/pool.js';
import { Rng } from '../core/rng.js';
import { clamp, TAU, damp, formatTime } from '../core/math.js';
import { Particles, P_SHARD, P_DOT } from '../fx/particles.js';
import { juice } from '../fx/juice.js';
import { audio } from '../core/audio.js';
import { save } from '../core/save.js';
import { Palette, HAZARD_RGB, HEAL_RGB, SHARD_RGB, XP_RGB, rgba, trailColor, TIERS } from './palette.js';
import { ENEMIES, WEAPONS, UPGRADES, ELITE_TIMES, MINIBOSS_TIMES, metaStats, xpForLevel } from './defs.js';
import { Face } from '../fx/face.js';
import { coreFor } from './characters.js';

const TIER_DURATION = 55;      // seconds per biome
// 120 on screen is already past the point of readability; the cap exists so a stalled
// player can't drive the frame time into the floor.
const MAX_ENEMIES = 120;
const MAX_BULLETS = 220;
const MAX_EBULLETS = 260;
const MAX_PICKUPS = 320;
const COMBO_WINDOW = 2.4;

let UID = 1;

// ------------------------------------------------------------------ factories

const mkEnemy = () => ({
  uid: 0, def: null, x: 0, y: 0, vx: 0, vy: 0, hp: 1, maxHp: 1, r: 10,
  rot: 0, spin: 0, flash: 0, state: 0, stateT: 0, shootT: 0, summonT: 0,
  phase: 0, spawnT: 0, elite: false, dmgScale: 1, speedScale: 1,
  split: false, shielded: false, parentUid: 0, sweepT: 0,
  // Lazily created the first time this slot holds a faced enemy, then kept forever.
  // Allocating per spawn would put object churn straight back into the hot path.
  face: null, _idx: 0,
});

const mkBullet = () => ({
  x: 0, y: 0, vx: 0, vy: 0, life: 0, dmg: 0, pierce: 0, size: 4,
  crit: false, h0: 0, h1: 0, h2: 0, h3: 0, hn: 0, _idx: 0,
});

const mkEBullet = () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, dmg: 0, r: 5, rot: 0, _idx: 0 });

const mkPickup = () => ({
  x: 0, y: 0, vx: 0, vy: 0, type: 0, value: 0, life: 0, r: 5, born: 0, _idx: 0,
});
const PK_XP = 0, PK_SHARD = 1, PK_HEAL = 2;

// ------------------------------------------------------------------ Run

export class Run {
  constructor(config) {
    this.cfg = config;
    this.mods = config.mods;

    // Three independent RNG streams, all derived from the one seed. Splitting them is
    // what makes the Daily Run genuinely shared:
    //
    //   rng        director only, consumed strictly on the spawn timer. Nothing the
    //              player does can advance it, so the wave composition, spawn angles
    //              and elite schedule are byte-identical for everyone that day.
    //   rngUpgrade level-up offers. Advanced once per level, so the choices at level N
    //              are the same for every player — builds compete on decisions, not luck.
    //   rngAux     player-driven rolls: crits, drops, splitter fragments, elite summons.
    //              Kept off the director stream so a good or bad player can't desync
    //              the wave pattern for themselves.
    //
    // Purely cosmetic randomness (particle jitter, trail scatter) stays on Math.random —
    // it can never affect the outcome, so it must never touch a seeded stream.
    this.rng = config.rng;
    this.rngUpgrade = new Rng(config.seed ^ 0x9e3779b9);
    this.rngAux = new Rng(config.seed ^ 0x85ebca6b);

    const meta = metaStats(save);
    this.meta = meta;

    const arenaSize = Math.round(1500 * this.mods.arenaScale);
    this.arena = { x: -arenaSize / 2, y: -arenaSize / 2, w: arenaSize, h: arenaSize };

    this.enemies = new Pool(MAX_ENEMIES, mkEnemy);
    this.bullets = new Pool(MAX_BULLETS, mkBullet);
    this.ebullets = new Pool(MAX_EBULLETS, mkEBullet);
    this.pickups = new Pool(MAX_PICKUPS, mkPickup);
    this.particles = new Particles(950);

    this.palette = new Palette();
    this.palette.setColorblind(save.data.settings.colorblind);

    const weapon = WEAPONS[save.data.equippedWeapon] || WEAPONS.weapon_pulse;
    this.weapon = weapon;
    this.trailId = save.data.equippedTrail;

    // Who you're playing as. Drives the face, the pupil colour and the voice flavour.
    this.core = coreFor(save.data.equippedWeapon);
    this.face = new Face(this.core.eyeStyle, { pupilRgb: this.core.pupilRgb });

    this.stats = {
      maxHp: Math.round((100 + meta.hp)),
      moveSpeed: 232 * meta.spd * this.mods.playerSpeed,
      dmgMul: meta.dmg * this.mods.playerDmg,
      rateMul: 1, speedMul: 1, rangeMul: 1, sizeMul: 1,
      count: weapon.count, spread: weapon.spread, pierce: weapon.pierce,
      magnet: 78 * meta.magnet,
      orbitals: 0, crit: 0.03, homing: 0,
      dashCd: 1.55, dashCharges: 1 + meta.dashCharges,
      thorns: 0, regen: 0, shardMul: meta.shard * this.mods.shardMul,
      xpMul: meta.xp * this.mods.xpMul,
      nova: this.mods.forceNova, shieldMax: 0, shieldRecharge: 0,
    };

    this.player = {
      x: 0, y: 0, vx: 0, vy: 0,
      hp: Math.round(this.stats.maxHp * this.mods.startHpMul),
      r: 14, aim: -Math.PI / 2, fireCd: 0,
      dashCd: 0, dashLeft: this.stats.dashCharges, dashT: 0, dashDx: 0, dashDy: 0,
      iframes: 0, shield: 0, shieldT: 0, regenAcc: 0,
      level: 1, xp: 0, xpNext: xpForLevel(1),
      alive: true, usedRevive: false, trailAcc: 0, hurtFlash: 0,
    };

    this.upgradeLevels = Object.create(null);
    this.time = 0;
    this.score = 0;
    this.kills = 0;
    this.runShards = 0;
    this.combo = 0;
    this.comboT = 0;
    this.bestCombo = 0;
    this.tier = 0;
    this.pendingLevelUps = 0;
    this.intensity = 0;
    this.over = false;
    this.orbitAngle = 0;
    this.orbitHitT = 0;
    this._aoeDepth = 0;

    // Director state
    this.spawnT = 0.9;
    this.eliteIdx = 0;
    this.minibossIdx = 0;
    this.eliteAlive = 0;

    this._seedMotes();
    this._recomputeDerived();
  }

  _seedMotes() {
    this.particles.clearMotes();
    const a = this.arena;
    for (let i = 0; i < 90; i++) {
      this.particles.mote(a.x + Math.random() * a.w, a.y + Math.random() * a.h, this.palette.mote);
    }
  }

  _recomputeDerived() {
    const w = this.weapon, s = this.stats;
    this.fireInterval = 1 / (w.rate * s.rateMul);
    this.bulletDmg = w.dmg * s.dmgMul;
    this.bulletSpeed = w.speed * s.speedMul;
    this.bulletRange = w.range * s.rangeMul;
    this.bulletSize = w.size * s.sizeMul;
  }

  // ---------------------------------------------------------------- upgrades

  /** Three distinct, non-maxed upgrades. Uses the run rng so the daily offers match. */
  rollUpgradeChoices(n = 3) {
    const avail = [], weights = [];
    for (const u of UPGRADES) {
      const lvl = this.upgradeLevels[u.id] || 0;
      if (lvl >= u.max) continue;
      avail.push(u);
      // Slight bias toward things already invested in, so builds converge.
      weights.push(u.weight * (lvl > 0 ? 1.25 : 1));
    }
    const out = [];
    for (let i = 0; i < n && avail.length; i++) {
      const pick = this.rngUpgrade.weighted(avail, weights);
      const idx = avail.indexOf(pick);
      avail.splice(idx, 1); weights.splice(idx, 1);
      const lvl = (this.upgradeLevels[pick.id] || 0) + 1;
      out.push({ def: pick, level: lvl, desc: pick.desc(lvl) });
    }
    return out;
  }

  applyUpgrade(choice) {
    const lvl = (this.upgradeLevels[choice.def.id] || 0) + 1;
    this.upgradeLevels[choice.def.id] = lvl;
    choice.def.apply(this.stats, this.player, lvl);
    if (choice.def.id === 'shield') { this.player.shield = this.stats.shieldMax; }
    if (choice.def.id === 'dashmaster' && lvl === 2) this.player.dashLeft += 1;
    this.player.hp = Math.min(this.player.hp, this.stats.maxHp);
    this._recomputeDerived();
  }

  // ---------------------------------------------------------------- update

  update(dt, input) {
    if (this.over) {
      // Keep the world alive behind the death screen — particles keep settling.
      this.particles.update(dt, this.arena);
      this.palette.update(dt);
      return;
    }

    this.time += dt;
    this._updateTier();
    this.palette.update(dt);

    this._updatePlayer(dt, input);
    this._director(dt);
    this._updateEnemies(dt);
    this._updateBullets(dt);
    this._updateEBullets(dt);
    this._updatePickups(dt);
    this._updateOrbitals(dt);
    this.particles.update(dt, this.arena);

    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) this.combo = 0;
    }

    this._updateIntensity(dt);
  }

  _updateTier() {
    const t = Math.min(TIERS.length - 1, Math.floor(this.time / TIER_DURATION));
    if (t !== this.tier) {
      this.tier = t;
      this.palette.goToTier(t);
      this._seedMotes();
      audio.tierShift();
      juice.tierShift();
      this.onTierChange?.(TIERS[t]);
      // Outward shockwave marks the transition in-world, not just in the UI.
      for (let i = 0; i < 3; i++) {
        this.particles.ring(this.player.x, this.player.y, 30 + i * 40, 420 + i * 160,
                            1.1 + i * 0.25, this.palette.primary, 5 - i);
      }
    }
  }

  /** Danger heuristic -> music intensity + HUD tension. */
  _updateIntensity(dt) {
    const p = this.player;
    let near = 0;
    for (let i = 0; i < this.enemies.active; i++) {
      const e = this.enemies.items[i];
      const dx = e.x - p.x, dy = e.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 340 * 340) near += e.elite ? 5 : 1;
    }
    const hpFactor = 1 - p.hp / this.stats.maxHp;
    const target = clamp(
      this.time / 300 * 0.45 + near / 26 * 0.35 + hpFactor * 0.25 + (this.eliteAlive ? 0.2 : 0),
      0, 1
    );
    this.intensity = damp(this.intensity, target, 1.4, dt);
    audio.setIntensity(this.intensity);
  }

  // ---------------------------------------------------------------- player

  _updatePlayer(dt, input) {
    const p = this.player, s = this.stats;
    if (!p.alive) return;

    p.iframes = Math.max(0, p.iframes - dt);
    p.hurtFlash = Math.max(0, p.hurtFlash - dt * 4);
    p.dashCd = Math.max(0, p.dashCd - dt);

    if (p.dashCd === 0 && p.dashLeft < s.dashCharges) {
      p.dashLeft++;
      if (p.dashLeft < s.dashCharges) p.dashCd = s.dashCd;
    }

    // --- dash ---
    if (input.consumeDash() && p.dashLeft > 0 && p.dashT <= 0) {
      let dx = input.moveX, dy = input.moveY;
      if (dx === 0 && dy === 0) { dx = Math.cos(p.aim); dy = Math.sin(p.aim); }
      const len = Math.hypot(dx, dy) || 1;
      p.dashDx = dx / len; p.dashDy = dy / len;
      p.dashT = 0.19;
      p.iframes = Math.max(p.iframes, 0.30);
      p.dashLeft--;
      if (p.dashCd === 0) p.dashCd = s.dashCd;
      audio.dash();
      juice.dash();
      const trail = trailColor(this.trailId, this.time);
      this.particles.burst(p.x, p.y, 16, 300, trail, { life: 0.34, size: 3.4, dir: Math.atan2(-p.dashDy, -p.dashDx), spread: 1.5 });
      this.particles.ring(p.x, p.y, 12, 68, 0.32, trail, 3);
    }

    if (p.dashT > 0) {
      p.dashT -= dt;
      const dashSpeed = s.moveSpeed * 3.6;
      p.vx = p.dashDx * dashSpeed;
      p.vy = p.dashDy * dashSpeed;
    } else {
      const tvx = input.moveX * s.moveSpeed;
      const tvy = input.moveY * s.moveSpeed;
      p.vx = damp(p.vx, tvx, 16, dt);
      p.vy = damp(p.vy, tvy, 16, dt);
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const a = this.arena, m = p.r;
    if (p.x < a.x + m) { p.x = a.x + m; p.vx *= -0.25; }
    if (p.x > a.x + a.w - m) { p.x = a.x + a.w - m; p.vx *= -0.25; }
    if (p.y < a.y + m) { p.y = a.y + m; p.vy *= -0.25; }
    if (p.y > a.y + a.h - m) { p.y = a.y + a.h - m; p.vy *= -0.25; }

    // --- trail (distance-based so it doesn't thin out when standing still) ---
    const speed = Math.hypot(p.vx, p.vy);
    p.trailAcc += speed * dt;
    const trailStep = 9;
    const trailRgb = trailColor(this.trailId, this.time);
    while (p.trailAcc > trailStep) {
      p.trailAcc -= trailStep;
      this.particles.trail(p.x - p.vx * 0.02, p.y - p.vy * 0.02, trailRgb,
                           4.5 + Math.min(3, speed / 220), p.dashT > 0 ? 0.55 : 0.4);
    }

    // --- aim ---
    const target = this._findAimTarget();
    let desiredAim = p.aim;
    if (input.manualAim && input.aimMag > 0.1) {
      desiredAim = Math.atan2(input.aimY, input.aimX);
    } else if (target) {
      // Lead the target so fast movers don't require the player to compensate.
      const tof = Math.hypot(target.x - p.x, target.y - p.y) / this.bulletSpeed;
      desiredAim = Math.atan2(target.y + target.vy * tof - p.y, target.x + target.vx * tof - p.x);
    } else if (speed > 20) {
      desiredAim = Math.atan2(p.vy, p.vx);
    }
    // Smoothed turret rotation — instant snapping looks robotic under bloom.
    let d = ((desiredAim - p.aim + Math.PI * 3) % TAU) - Math.PI;
    p.aim += d * Math.min(1, dt * 22);

    // --- fire ---
    p.fireCd -= dt;
    const wantsFire = save.data.settings.autoFire ? !!target : (input.firing && !!target);
    if (p.fireCd <= 0 && wantsFire) {
      p.fireCd = this.fireInterval;
      this._fire();
    }

    // --- face ---
    // Purely reactive: reads the state the player update already produced rather than
    // adding any of its own. Look at whatever is about to hurt you; if nothing is,
    // look where you're going.
    if (target) {
      this.face.lookAt(target.x - p.x, target.y - p.y);
    } else if (speed > 30) {
      this.face.lookAt(p.vx * 0.35, p.vy * 0.35);
    } else {
      this.face.lookForward();
    }
    // Squint while the trigger is down — fireCd counts down from fireInterval, so a
    // fresh shot is a full-strength squint that eases off between slow shots.
    if (wantsFire) this.face.focus(0.55 + 0.45 * clamp(p.fireCd / this.fireInterval, 0, 1));
    if (p.dashT > 0) this.face.focus(1);
    this.face.update(dt);

    // --- shield / regen ---
    if (s.shieldMax > 0 && p.shield < s.shieldMax) {
      p.shieldT -= dt;
      if (p.shieldT <= 0) {
        p.shield = s.shieldMax;
        this.particles.ring(p.x, p.y, 16, 46, 0.5, this.palette.accent, 3);
        audio.pickup();
      }
    }
    if (s.regen > 0 && p.hp < s.maxHp) {
      p.regenAcc += s.regen * dt;
      while (p.regenAcc >= 1) {
        p.regenAcc -= 1;
        p.hp = Math.min(s.maxHp, p.hp + 1);
      }
    }
  }

  /** Nearest enemy inside weapon range; elites get a distance discount so they're prioritised. */
  _findAimTarget() {
    const p = this.player;
    let best = null, bestD = Infinity;
    const maxD = this.bulletRange * 1.25;
    for (let i = 0; i < this.enemies.active; i++) {
      const e = this.enemies.items[i];
      if (e.spawnT > 0) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      let d2 = dx * dx + dy * dy;
      if (e.elite) d2 *= 0.45;
      if (d2 < bestD && d2 < maxD * maxD) { bestD = d2; best = e; }
    }
    return best;
  }

  _fire() {
    const p = this.player, s = this.stats;
    const n = s.count;
    const spread = s.spread;
    for (let i = 0; i < n; i++) {
      const b = this.bullets.spawn();
      if (!b) break;
      const off = n === 1 ? 0 : (i / (n - 1) - 0.5) * spread * 2;
      const a = p.aim + off + (this.rngAux.next() - 0.5) * 0.02;
      const crit = this.rngAux.next() < s.crit;
      b.x = p.x + Math.cos(a) * (p.r + 4);
      b.y = p.y + Math.sin(a) * (p.r + 4);
      b.vx = Math.cos(a) * this.bulletSpeed;
      b.vy = Math.sin(a) * this.bulletSpeed;
      b.life = this.bulletRange / this.bulletSpeed;
      b.dmg = this.bulletDmg * (crit ? 2.2 : 1);
      b.crit = crit;
      b.pierce = s.pierce;
      b.size = this.bulletSize * (crit ? 1.25 : 1);
      b.hn = 0;
    }
    // Muzzle flash + recoil: small, but it's what makes the weapon feel connected.
    const mx = p.x + Math.cos(p.aim) * (p.r + 6);
    const my = p.y + Math.sin(p.aim) * (p.r + 6);
    this.particles.burst(mx, my, 4, 210, this.palette.accent,
                         { life: 0.14, size: 2.4, dir: p.aim, spread: 0.7 });
    p.vx -= Math.cos(p.aim) * 26;
    p.vy -= Math.sin(p.aim) * 26;
    audio.shoot(1 + (this.tier * 0.04));
    juice.addShake(0.35);
  }

  damagePlayer(amount, sourceX, sourceY) {
    const p = this.player;
    if (!p.alive || p.iframes > 0) return;

    if (p.shield > 0) {
      p.shield--;
      p.shieldT = this.stats.shieldRecharge;
      p.iframes = 0.55;
      this.face.startle(0.5);
      this.particles.ring(p.x, p.y, 18, 78, 0.42, this.palette.accent, 4);
      this.particles.burst(p.x, p.y, 14, 240, this.palette.accent, { life: 0.35, size: 3 });
      audio.pickup();
      juice.addShake(5); juice.addChroma(0.3);
      return;
    }

    p.hp -= amount;
    p.iframes = 0.85;
    p.hurtFlash = 1;
    this.face.startle(1);
    audio.playerHurt();
    juice.playerHurt();
    this.particles.burst(p.x, p.y, 22, 260, HAZARD_RGB, { life: 0.5, size: 3.6 });
    this.particles.ring(p.x, p.y, 14, 96, 0.45, HAZARD_RGB, 4);
    this.particles.text(p.x, p.y - 26, `-${Math.round(amount)}`, HAZARD_RGB, 0.8, 18);

    if (this.stats.thorns > 0) this._shockwave(p.x, p.y, 170 * this.stats.thorns, 26 * this.stats.thorns);
    this.onHurt?.();

    // Getting hit breaks your combo. Aggression should carry risk.
    this.combo = 0; this.comboT = 0;

    if (p.hp <= 0) {
      if (this.meta.revive && !p.usedRevive) {
        p.usedRevive = true;
        p.hp = Math.round(this.stats.maxHp * 0.45);
        p.iframes = 2.2;
        this._shockwave(p.x, p.y, 340, 90);
        audio.levelUp();
        juice.bigKill();
        this.particles.ring(p.x, p.y, 20, 360, 0.9, this.palette.accent, 7);
        this.onRevive?.();
      } else {
        p.hp = 0;
        p.alive = false;
        this.over = true;
        this.particles.burst(p.x, p.y, 90, 460, this.palette.primary, { life: 1.3, size: 5 });
        this.particles.ring(p.x, p.y, 16, 460, 1.3, this.palette.primary, 8);
        juice.bigKill();
        audio.gameOver();
        this.onGameOver?.();
      }
    }
  }

  _shockwave(x, y, radius, dmg) {
    this.particles.ring(x, y, 10, radius, 0.5, this.palette.accent, 6);
    this._areaDamage(x, y, radius, dmg, 0, 340);
    juice.addShake(6);
  }

  /**
   * Damage every enemy in a radius.
   *
   * Two hazards this has to handle. First, killing inside the loop calls releaseAt,
   * which swap-removes and reorders the pool underneath us — so the index is re-clamped
   * every iteration. Second, a kill can trigger Deathbloom, which calls back into here;
   * without `_aoeDepth` that recurses until the stack blows (guaranteed, not theoretical,
   * once the VOLATILE mutator forces novas on). Two levels of chain reaction is plenty
   * of spectacle; beyond that it just stops.
   */
  _areaDamage(x, y, radius, dmg, excludeUid = 0, knockback = 0) {
    if (this._aoeDepth >= 2) return;
    this._aoeDepth = (this._aoeDepth || 0) + 1;
    const r2 = radius * radius;
    for (let i = this.enemies.active - 1; i >= 0; i--) {
      if (i >= this.enemies.active) { i = this.enemies.active; continue; }
      const e = this.enemies.items[i];
      if (!e || e.uid === excludeUid || e.spawnT > 0) continue;
      const dx = e.x - x, dy = e.y - y;
      if (dx * dx + dy * dy >= r2) continue;
      if (knockback) {
        const l = Math.hypot(dx, dy) || 1;
        const push = knockback / (1 + l / 90);
        e.vx += (dx / l) * push; e.vy += (dy / l) * push;
      }
      this._hurtEnemy(e, i, dmg, false);
    }
    this._aoeDepth--;
  }

  // ---------------------------------------------------------------- director

  _director(dt) {
    const m = this.mods;

    // Spawn cadence ramps from ~1.3s down to ~0.26s over five minutes.
    const t = this.time;
    const base = Math.max(0.26, 1.35 - t * 0.0036);
    const interval = base / m.spawnRate;

    this.spawnT -= dt;
    // Deliberately NOT gated on enemy count. The pool cap is enforced inside
    // _spawnEnemy, which still consumes its RNG draws when it drops a spawn, so a
    // saturated arena costs you the enemy without shifting the shared wave pattern.
    if (this.spawnT <= 0) {
      this.spawnT = interval * (0.82 + this.rng.next() * 0.36);
      const groupSize = 1 + Math.floor(t / 70) + (this.rng.next() < 0.22 ? 2 : 0);
      const type = this._pickEnemyType();
      const def = ENEMIES[type];
      // Pack types override the director's group size — a Mite arriving alone isn't a
      // swarm, it's a rounding error. Drawn from the wave stream so the pack size is
      // part of the shared daily pattern.
      const n = def.packMin
        ? def.packMin + Math.floor(this.rng.next() * (def.packMax - def.packMin + 1))
        : groupSize;
      // Groups of one type read much better than a random soup.
      for (let i = 0; i < n; i++) this._spawnEnemy(type, i, n, null, null, this.rng);
    }

    // Minibosses on their own schedule, offset from the elite one so the two never
    // stack. Also on the wave stream: a shared daily must include the same events.
    while (this.minibossIdx < MINIBOSS_TIMES.length &&
           t >= MINIBOSS_TIMES[this.minibossIdx] / m.eliteRate) {
      this.minibossIdx++;
      this._spawnMiniboss();
    }

    // Elites on a schedule, compressed by the GAUNTLET mutator.
    while (this.eliteIdx < ELITE_TIMES.length && t >= ELITE_TIMES[this.eliteIdx] / m.eliteRate) {
      this.eliteIdx++;
      this._spawnElite();
    }
  }

  _pickEnemyType() {
    const keys = [], weights = [];
    for (const k in ENEMIES) {
      const d = ENEMIES[k];
      if (d.weight <= 0 || this.time < d.minTime) continue;
      keys.push(k);
      // Late-game bias toward heavier archetypes.
      const ramp = d.minTime > 0 ? 1 + Math.min(1.6, (this.time - d.minTime) / 120) : 1;
      weights.push(d.weight * ramp);
    }
    return this.rng.weighted(keys, weights);
  }

  /** Spawn just outside the visible viewport but clamped inside the arena. */
  _spawnPos(index, total, rng, spreadRad = 0.55) {
    const p = this.player;
    const a = this.arena;
    const baseAngle = rng.angle();
    const ang = total > 1 ? baseAngle + (index / total - 0.5) * spreadRad : baseAngle;
    const dist = 480 + rng.next() * 130;
    let x = p.x + Math.cos(ang) * dist;
    let y = p.y + Math.sin(ang) * dist;
    x = clamp(x, a.x + 24, a.x + a.w - 24);
    y = clamp(y, a.y + 24, a.y + a.h - 24);
    return { x, y };
  }

  /** @param {Rng} rng director spawns pass the wave stream; everything else passes rngAux. */
  _spawnEnemy(typeKey, index = 0, total = 1, atX = null, atY = null, rng = this.rngAux) {
    const def = ENEMIES[typeKey];

    // Every random draw happens up front, unconditionally — before the pool check.
    //
    // This ordering is load-bearing for the Daily Run. If a full enemy pool could skip
    // these draws, then a player who kills slowly would advance the director's stream
    // differently from a player who kills fast, and the two would stop sharing a run.
    // Dropping the enemy when the pool is full is fine; letting that drop change the
    // stream is not.
    const pos = atX != null ? { x: atX, y: atY } : this._spawnPos(index, total, rng);
    const rot = rng.angle();
    const shootT = def.shootEvery ? def.shootEvery * (0.5 + rng.next() * 0.7) : 0;
    const phase = rng.angle();

    const e = this.enemies.spawn();
    if (!e) return null;

    const tMin = this.time / 60;
    const hpScale = (1 + tMin * 0.36) * this.mods.enemyHp;
    const spdScale = (1 + tMin * 0.045) * this.mods.enemySpeed;

    e.uid = UID++;
    e.def = def;
    e.x = pos.x; e.y = pos.y;
    e.vx = e.vy = 0;
    e.maxHp = e.hp = def.hp * hpScale;
    e.r = def.r;
    e.rot = rot;
    e.spin = def.spin;
    e.flash = 0;

    // Face: reuse this slot's instance if it already has one of the right style.
    if (def.face) {
      if (!e.face || e.face.style !== def.face) e.face = new Face(def.face);
      e.face.lookForward();
    }
    e.state = 0; e.stateT = 0;
    e.shootT = shootT;
    e.summonT = def.summonEvery || 0;
    e.phase = phase;
    e.spawnT = 0.42;                 // telegraph window, immune and non-colliding
    e.elite = !!def.elite;
    e.dmgScale = (1 + tMin * 0.14) * this.mods.enemyDmg;
    e.speedScale = spdScale;
    // Miniboss phase state, reset per spawn since pool slots are reused.
    e.split = false;
    e.shielded = false;
    e.parentUid = 0;
    e.sweepT = def.sweepEvery || 0;

    // Spawn telegraph: a contracting ring so nothing ever appears on top of you unseen.
    this.particles.ring(e.x, e.y, e.r * 4.5, e.r * 1.1, 0.42, this.palette.enemyBright, 2.5);
    return e;
  }

  /**
   * Guarantee a pool slot for a scheduled event enemy by evicting the most distant
   * ordinary enemy.
   *
   * Without this, a saturated pool silently swallows the spawn — which is survivable
   * for a trash mob and completely wrong for a miniboss, the one thing in the run
   * that's supposed to be an event. Observed in testing: the Tessellator never
   * appeared at all because 120 Mites had taken every slot.
   *
   * Evicts by distance from the player so nothing vanishes on screen, skips elites so
   * one event can't eat another, and consumes no RNG — the wave stream is untouched,
   * so this can't desync the shared daily.
   */
  _makeRoomForEvent() {
    if (this.enemies.active < MAX_ENEMIES) return true;
    const p = this.player;
    let worstIdx = -1, worstD = -1;
    for (let i = 0; i < this.enemies.active; i++) {
      const e = this.enemies.items[i];
      if (e.elite || e.parentUid) continue;      // never evict an event or its parts
      const dx = e.x - p.x, dy = e.y - p.y;
      const d = dx * dx + dy * dy;
      if (d > worstD) { worstD = d; worstIdx = i; }
    }
    if (worstIdx < 0) return false;
    this.enemies.releaseAt(worstIdx);
    return true;
  }

  _spawnMiniboss() {
    const def = ENEMIES.tessellator;
    this._makeRoomForEvent();
    const e = this._spawnEnemy('tessellator', 0, 1, null, null, this.rng);
    if (!e) return;
    const tMin = this.time / 60;
    e.maxHp = e.hp = def.hp * (1 + tMin * 0.42) * this.mods.enemyHp;
    e.spawnT = 1.6;                    // long telegraph — this is meant to be an event
    this.eliteAlive++;
    this.particles.ring(e.x, e.y, 40, 420, 1.4, HAZARD_RGB, 8);
    juice.addShake(12);
    juice.addFlash(0.18);
    audio.tierShift();
    this.onMinibossSpawn?.(def);
  }

  _spawnElite() {
    this._makeRoomForEvent();
    const e = this._spawnEnemy('warden', 0, 1, null, null, this.rng);
    if (!e) return;
    const tMin = this.time / 60;
    e.maxHp = e.hp = ENEMIES.warden.hp * (1 + tMin * 0.55) * this.mods.enemyHp;
    e.spawnT = 1.1;
    this.eliteAlive++;
    audio.tierShift();
    juice.addShake(9);
    this.particles.ring(e.x, e.y, 30, 300, 1.0, HAZARD_RGB, 6);
    this.onEliteSpawn?.();
  }

  // ---------------------------------------------------------------- enemies

  _updateEnemies(dt) {
    const p = this.player;
    const pool = this.enemies;

    for (let i = pool.active - 1; i >= 0; i--) {
      // Contact damage below can trigger Backlash, whose shockwave may kill several
      // enemies in one call — re-clamp before touching items[i].
      if (i >= pool.active) { i = pool.active; continue; }
      const e = pool.items[i];
      const def = e.def;

      if (e.spawnT > 0) { e.spawnT -= dt; e.rot += e.spin * dt * 3; continue; }

      e.flash = Math.max(0, e.flash - dt * 6);
      e.rot += e.spin * dt;

      if (e.face) {
        // Always watching you. Startle on taking a hit; narrow the eyes while winding
        // up an attack, so the tell is on the face as well as the body.
        e.face.lookAt(p.x - e.x, p.y - e.y);
        if (e.flash > 0.6) e.face.startle(0.7);
        if (e.state === 1 || (def.shootEvery && e.shootT < 0.35)) e.face.focus(1);
        e.face.update(dt);
      }

      const dx = p.x - e.x, dy = p.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      const nx = dx / d, ny = dy / d;
      const speed = def.speed * e.speedScale;

      switch (def.behavior) {
        case 'chase':
          e.vx = damp(e.vx, nx * speed, 4, dt);
          e.vy = damp(e.vy, ny * speed, 4, dt);
          break;

        case 'weave': {
          // Perpendicular sine offset — hard to lead, easy to read.
          e.phase += dt * 3.4;
          const px = -ny, py = nx;
          const w = Math.sin(e.phase) * speed * 0.85;
          e.vx = damp(e.vx, nx * speed + px * w, 5, dt);
          e.vy = damp(e.vy, ny * speed + py * w, 5, dt);
          break;
        }

        case 'charge': {
          e.stateT -= dt;
          if (e.state === 0) {              // approach
            e.vx = damp(e.vx, nx * speed, 3, dt);
            e.vy = damp(e.vy, ny * speed, 3, dt);
            if (d < 320) { e.state = 1; e.stateT = def.windup; }
          } else if (e.state === 1) {       // wind up (visibly braking)
            e.vx = damp(e.vx, 0, 8, dt);
            e.vy = damp(e.vy, 0, 8, dt);
            e.spin = 14;
            if (e.stateT <= 0) {
              e.state = 2; e.stateT = def.chargeTime;
              e.vx = nx * def.chargeSpeed * this.mods.enemySpeed;
              e.vy = ny * def.chargeSpeed * this.mods.enemySpeed;
              this.particles.burst(e.x, e.y, 8, 160, this.palette.enemyBright, { life: 0.3, size: 2.5 });
            }
          } else if (e.state === 2) {       // committed dash — no steering
            if (e.stateT <= 0) { e.state = 3; e.stateT = def.restTime; e.spin = def.spin; }
          } else {                          // rest
            e.vx = damp(e.vx, 0, 5, dt);
            e.vy = damp(e.vy, 0, 5, dt);
            if (e.stateT <= 0) e.state = 0;
          }
          break;
        }

        case 'orbit': {
          // Spiral in to orbitRadius, then circle.
          const want = def.orbitRadius;
          const radial = (d - want) * 1.6;
          const tang = speed;
          const px = -ny, py = nx;
          e.vx = damp(e.vx, nx * clamp(radial, -speed, speed) + px * tang, 4, dt);
          e.vy = damp(e.vy, ny * clamp(radial, -speed, speed) + py * tang, 4, dt);
          this._enemyShoot(e, dt, def, nx, ny, 1);
          break;
        }

        case 'standoff': {
          const want = def.standoffRange;
          const err = d - want;
          const move = clamp(err * 1.2, -speed, speed);
          e.vx = damp(e.vx, nx * move, 3, dt);
          e.vy = damp(e.vy, ny * move, 3, dt);
          this._enemyShoot(e, dt, def, nx, ny, def.burst || 1);
          break;
        }

        case 'swarm': {
          // Heads for the player but with a wandering perpendicular wobble whose phase
          // and rate differ per individual. A pack therefore arrives as a spreading
          // cloud instead of a single stacked column, and can't be led like one target.
          e.phase += dt * (5.5 + (e.uid % 7) * 0.6);
          const px = -ny, py = nx;
          const wob = Math.sin(e.phase) * speed * 0.75;
          e.vx = damp(e.vx, nx * speed + px * wob, 7, dt);
          e.vy = damp(e.vy, ny * speed + py * wob, 7, dt);
          break;
        }

        case 'lunge': {
          // Deliberately generous tells: a long wind-up where it stops dead and spins
          // up, then a committed dash it cannot steer out of. Always dodgeable.
          e.stateT -= dt;
          if (e.state === 0) {
            e.vx = damp(e.vx, nx * speed, 2.5, dt);
            e.vy = damp(e.vy, ny * speed, 2.5, dt);
            if (d < def.lungeRange) { e.state = 1; e.stateT = def.windup; }
          } else if (e.state === 1) {
            e.vx = damp(e.vx, 0, 9, dt);
            e.vy = damp(e.vy, 0, 9, dt);
            e.spin = 11;
            if (e.stateT <= 0) {
              e.state = 2; e.stateT = def.lungeTime;
              e.vx = nx * def.lungeSpeed * this.mods.enemySpeed;
              e.vy = ny * def.lungeSpeed * this.mods.enemySpeed;
              this.particles.burst(e.x, e.y, 14, 240, HAZARD_RGB, { life: 0.4, size: 3.4 });
              juice.addShake(2.5);
            }
          } else if (e.state === 2) {
            if (e.stateT <= 0) { e.state = 3; e.stateT = def.restTime; e.spin = def.spin; }
          } else {
            e.vx = damp(e.vx, 0, 4, dt);
            e.vy = damp(e.vy, 0, 4, dt);
            if (e.stateT <= 0) e.state = 0;
          }
          break;
        }

        case 'orbitParent': {
          // Tessera ride a circle around their Tessellator. If the parent is somehow
          // gone (killed by a nova in the same frame), they release and charge instead
          // of freezing in place around nothing.
          const par = this._findByUid(e.parentUid);
          if (!par) {
            e.def = ENEMIES.shardling;   // becomes an ordinary chaser
            e.parentUid = 0;
            break;
          }
          e.phase += dt * def.orbitRate;
          const tx = par.x + Math.cos(e.phase) * def.orbitDist;
          const ty = par.y + Math.sin(e.phase) * def.orbitDist;
          // Positioned rather than steered: these are parts of a machine, not chasers.
          e.vx = (tx - e.x) * 9;
          e.vy = (ty - e.y) * 9;
          break;
        }
      }

      if (def.miniboss) this._minibossBehavior(e, dt, def, nx, ny);
      else if (e.elite) this._eliteBehavior(e, dt, def, nx, ny);

      e.x += e.vx * dt;
      e.y += e.vy * dt;

      // Soft arena containment (enemies can hug the wall but not leave).
      const a = this.arena;
      e.x = clamp(e.x, a.x + e.r, a.x + a.w - e.r);
      e.y = clamp(e.y, a.y + e.r, a.y + a.h - e.r);

      // Separation against a short window of neighbours. Not a true O(n^2) pass — 14
      // comparisons is enough to keep a swarm from collapsing into one bright blob,
      // and the pool's swap-remove churn shuffles who compares against whom over time.
      // The push radius is deliberately wider than the collision radius: chasers all
      // converge on the same point, so they need to repel before they actually overlap
      // or the crowd fuses into one unreadable mass.
      for (let j = i - 1; j >= 0 && j > i - 15; j--) {
        const o = pool.items[j];
        const ox = e.x - o.x, oy = e.y - o.y;
        const rr = (e.r + o.r) * 1.35;
        const od2 = ox * ox + oy * oy;
        if (od2 > 0.01 && od2 < rr * rr) {
          const od = Math.sqrt(od2);
          const push = (rr - od) / od * 70;
          e.vx += ox * push * dt * 6; e.vy += oy * push * dt * 6;
          o.vx -= ox * push * dt * 6; o.vy -= oy * push * dt * 6;
        }
      }

      // Contact damage.
      const rr = e.r + p.r;
      if (p.alive && dx * dx + dy * dy < rr * rr) {
        this.damagePlayer(def.dmg * e.dmgScale, e.x, e.y);
        // Knock the attacker back so contact isn't a death sentence in a crowd.
        e.vx -= nx * 260; e.vy -= ny * 260;
      }
    }
  }

  _eliteBehavior(e, dt, def, nx, ny) {
    e.shootT -= dt;
    if (e.shootT <= 0) {
      e.shootT = def.shootEvery;
      const base = Math.atan2(ny, nx) + this.rngAux.float(0, 0.5);
      for (let k = 0; k < def.radialCount; k++) {
        const a = base + (k / def.radialCount) * TAU;
        this._spawnEBullet(e.x + Math.cos(a) * e.r, e.y + Math.sin(a) * e.r,
                           Math.cos(a) * def.bulletSpeed, Math.sin(a) * def.bulletSpeed,
                           def.bulletDmg * e.dmgScale);
      }
      this.particles.ring(e.x, e.y, e.r, e.r * 3.4, 0.5, HAZARD_RGB, 4);
      juice.addShake(3.5);
    }
    e.summonT -= dt;
    if (e.summonT <= 0) {
      e.summonT = def.summonEvery;
      for (let k = 0; k < def.summonCount; k++) {
        const a = this.rngAux.angle();
        this._spawnEnemy(def.summon, 0, 1, e.x + Math.cos(a) * 70, e.y + Math.sin(a) * 70);
      }
    }
  }

  /** Linear scan by uid. Only ever called for the handful of Tessera on screen. */
  _findByUid(uid) {
    if (!uid) return null;
    for (let i = 0; i < this.enemies.active; i++) {
      if (this.enemies.items[i].uid === uid) return this.enemies.items[i];
    }
    return null;
  }

  /**
   * Tessellator. Two phases:
   *   1. Standoff shooting (handled by the normal 'standoff' case) plus a telegraphed
   *      radial sweep on a slower cycle.
   *   2. At splitAt health it fractures — three Tessera peel off and orbit it, and it
   *      armours itself until they're dead. Ignoring the segments is a losing play.
   */
  _minibossBehavior(e, dt, def, nx, ny) {
    // --- phase change ---
    if (!e.split && e.hp <= e.maxHp * def.splitAt) {
      e.split = true;
      e.shielded = true;
      const orbit = ENEMIES[def.segment].orbitDist;
      for (let k = 0; k < def.segmentCount; k++) {
        const a = (k / def.segmentCount) * TAU;
        // Same reasoning as the boss itself — a segment lost to a full pool would
        // quietly weaken the phase. (If they all fail the shield simply drops on the
        // next frame, so the worst case degrades gracefully rather than soft-locking.)
        this._makeRoomForEvent();
        const seg = this._spawnEnemy(def.segment, 0, 1,
          e.x + Math.cos(a) * orbit, e.y + Math.sin(a) * orbit, this.rngAux);
        if (seg) {
          seg.parentUid = e.uid;
          seg.phase = a;
          seg.spawnT = 0.3;
        }
      }
      this.particles.ring(e.x, e.y, e.r, e.r * 7, 0.8, HAZARD_RGB, 6);
      this.particles.burst(e.x, e.y, 40, 330, HAZARD_RGB, { life: 0.8, size: 4 });
      audio.bigDeath();
      juice.bigKill();
      this.onMinibossSplit?.(def);
    }

    // Shield drops the moment the last segment dies.
    if (e.shielded) {
      let alive = false;
      for (let i = 0; i < this.enemies.active; i++) {
        if (this.enemies.items[i].parentUid === e.uid) { alive = true; break; }
      }
      if (!alive) {
        e.shielded = false;
        this.particles.ring(e.x, e.y, e.r * 3, e.r, 0.5, this.palette.accent, 5);
        audio.levelUp();
      }
    }

    // --- telegraphed radial sweep ---
    e.sweepT -= dt;
    if (e.sweepT <= 0 && e.state !== 9) {
      e.state = 9;                       // winding up; the draw pass shows the tell
      e.stateT = def.sweepWindup;
    }
    if (e.state === 9) {
      e.stateT -= dt;
      e.vx = damp(e.vx, 0, 7, dt);
      e.vy = damp(e.vy, 0, 7, dt);
      if (e.stateT <= 0) {
        e.state = 0;
        e.sweepT = def.sweepEvery;
        const base = this.rngAux.angle();
        for (let k = 0; k < def.sweepCount; k++) {
          const a = base + (k / def.sweepCount) * TAU;
          this._spawnEBullet(e.x + Math.cos(a) * e.r, e.y + Math.sin(a) * e.r,
                             Math.cos(a) * def.sweepSpeed, Math.sin(a) * def.sweepSpeed,
                             def.sweepDmg * e.dmgScale);
        }
        this.particles.ring(e.x, e.y, e.r, e.r * 5, 0.6, HAZARD_RGB, 5);
        juice.addShake(7);
      }
    }
  }

  _enemyShoot(e, dt, def, nx, ny, burst) {
    e.shootT -= dt;
    if (e.shootT > 0) return;
    e.shootT = def.shootEvery;
    const base = Math.atan2(ny, nx);
    for (let k = 0; k < burst; k++) {
      const a = base + (burst > 1 ? (k / (burst - 1) - 0.5) * 0.34 : 0);
      this._spawnEBullet(e.x + Math.cos(a) * e.r, e.y + Math.sin(a) * e.r,
                         Math.cos(a) * def.bulletSpeed, Math.sin(a) * def.bulletSpeed,
                         def.bulletDmg * e.dmgScale);
    }
    this.particles.burst(e.x, e.y, 3, 90, HAZARD_RGB, { life: 0.2, size: 2, dir: base, spread: 0.5 });
  }

  _spawnEBullet(x, y, vx, vy, dmg) {
    const b = this.ebullets.spawn();
    if (!b) return;
    b.x = x; b.y = y; b.vx = vx; b.vy = vy;
    b.life = 6; b.dmg = dmg; b.r = 6; b.rot = Math.atan2(vy, vx);
  }

  _hurtEnemy(e, index, dmg, isCrit) {
    const def = e.def;
    let effective = def.armor ? Math.max(dmg * 0.25, dmg - def.armor) : dmg;
    // Miniboss armours itself while its segments live — see _minibossBehavior.
    if (e.shielded) {
      effective *= def.shieldedDamageMul ?? 0.15;
      // Visibly bounce off, or the reduction just reads as the game ignoring your hits.
      if (Math.random() < 0.4) {
        this.particles.spark(e.x, e.y, (Math.random() - 0.5) * 180, (Math.random() - 0.5) * 180,
                             0.25, 2.5, this.palette.accent);
      }
    }
    e.hp -= effective;
    e.flash = 1;

    if (e.hp <= 0) {
      this._killEnemy(e, index, isCrit);
      return true;
    }
    audio.hit();
    juice.smallHit();
    return false;
  }

  _killEnemy(e, index, isCrit) {
    const def = e.def;
    const sizeScale = e.elite ? 2.4 : clamp(e.r / 14, 0.6, 1.6);

    // Combo: kills inside the window stack a multiplier, capped at x5.
    this.combo = Math.min(50, this.combo + 1);
    this.comboT = COMBO_WINDOW;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const comboMul = 1 + Math.min(4, this.combo * 0.08);

    const gained = Math.round(def.score * comboMul * this.mods.scoreMul);
    this.score += gained;
    this.kills++;

    const rgb = e.elite ? HAZARD_RGB : this.palette.enemy;
    this.particles.burst(e.x, e.y, e.elite ? 70 : 14, e.elite ? 420 : 240, rgb,
                         { life: e.elite ? 1.0 : 0.5, size: e.elite ? 5 : 3.2 });
    this.particles.burst(e.x, e.y, e.elite ? 24 : 5, e.elite ? 260 : 150, this.palette.enemyBright,
                         { life: 0.7, size: 3, kind: P_SHARD });
    this.particles.ring(e.x, e.y, e.r, e.r * (e.elite ? 9 : 4.2), e.elite ? 0.9 : 0.4, rgb, e.elite ? 7 : 3);

    if (e.elite) {
      audio.bigDeath();
      juice.bigKill();
      this.eliteAlive = Math.max(0, this.eliteAlive - 1);
      this.onEliteKilled?.();
    } else {
      audio.enemyDeath(sizeScale);
      juice.kill(sizeScale);
    }
    if (isCrit) this.particles.text(e.x, e.y - e.r - 8, 'CRIT', SHARD_RGB, 0.6, 14);

    // Drops. XP always; shards and heals on a roll (heals suppressed by BRITTLE).
    const xpVal = Math.max(1, Math.round(def.xp * this.stats.xpMul));
    const motes = e.elite ? 12 : Math.min(4, 1 + Math.floor(def.xp / 2));
    for (let k = 0; k < motes; k++) {
      this._spawnPickup(e.x, e.y, PK_XP, Math.max(1, Math.round(xpVal / motes)));
    }
    const shardRoll = this.rngAux.next();
    const shardChance = e.elite ? 1 : 0.11 + Math.min(0.1, this.time / 3000);
    if (shardRoll < shardChance) {
      const n = e.elite ? 8 : 1;
      for (let k = 0; k < n; k++) {
        this._spawnPickup(e.x, e.y, PK_SHARD, Math.max(1, Math.round((e.elite ? 6 : 3) * this.stats.shardMul)));
      }
    }
    if (!this.mods.noHealing && !e.elite && this.rngAux.next() < 0.022 && this.player.hp < this.stats.maxHp * 0.75) {
      this._spawnPickup(e.x, e.y, PK_HEAL, 16);
    } else if (!this.mods.noHealing && e.elite) {
      this._spawnPickup(e.x, e.y, PK_HEAL, 34);
    }

    // Splitters fragment.
    if (def.splitInto) {
      for (let k = 0; k < def.splitCount; k++) {
        const a = (k / def.splitCount) * TAU + this.rngAux.angle();
        const c = this._spawnEnemy(def.splitInto, 0, 1, e.x + Math.cos(a) * 22, e.y + Math.sin(a) * 22);
        if (c) { c.spawnT = 0.16; c.vx = Math.cos(a) * 200; c.vy = Math.sin(a) * 200; }
      }
    }

    // Deathbloom.
    if (this.stats.nova > 0) {
      this._novaAt(e.x, e.y, 88 + this.stats.nova * 34, this.bulletDmg * (0.8 + this.stats.nova * 0.5), e.uid);
    }

    this.enemies.releaseAt(index);
    this.onKill?.(gained, this.combo);
  }

  _novaAt(x, y, radius, dmg, excludeUid) {
    this.particles.ring(x, y, 6, radius, 0.34, this.palette.accent, 4);
    this._areaDamage(x, y, radius, dmg, excludeUid, 0);
  }

  // ---------------------------------------------------------------- bullets

  _updateBullets(dt) {
    const pool = this.bullets;
    const s = this.stats;

    for (let i = pool.active - 1; i >= 0; i--) {
      const b = pool.items[i];
      b.life -= dt;
      if (b.life <= 0) { pool.releaseAt(i); continue; }

      if (s.homing > 0) {
        const t = this._nearestEnemyTo(b.x, b.y, 300);
        if (t) {
          const want = Math.atan2(t.y - b.y, t.x - b.x);
          const cur = Math.atan2(b.vy, b.vx);
          let d = ((want - cur + Math.PI * 3) % TAU) - Math.PI;
          const na = cur + clamp(d, -s.homing * dt, s.homing * dt);
          const sp = Math.hypot(b.vx, b.vy);
          b.vx = Math.cos(na) * sp; b.vy = Math.sin(na) * sp;
        }
      }

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      const a = this.arena;
      if (b.x < a.x || b.x > a.x + a.w || b.y < a.y || b.y > a.y + a.h) { pool.releaseAt(i); continue; }

      // Collide against enemies.
      let consumed = false;
      for (let j = this.enemies.active - 1; j >= 0; j--) {
        if (j >= this.enemies.active) { j = this.enemies.active; continue; }
        const e = this.enemies.items[j];
        if (e.spawnT > 0) continue;
        if (b.hn > 0 && (b.h0 === e.uid || b.h1 === e.uid || b.h2 === e.uid || b.h3 === e.uid)) continue;
        const dx = e.x - b.x, dy = e.y - b.y;
        const rr = e.r + b.size;
        if (dx * dx + dy * dy > rr * rr) continue;

        const died = this._hurtEnemy(e, j, b.dmg, b.crit);
        if (!died) {
          this.particles.burst(b.x, b.y, 4, 170, this.palette.accent,
                               { life: 0.2, size: 2.4, dir: Math.atan2(-b.vy, -b.vx), spread: 1.6 });
          // Nudge survivors so heavy hits read as impacts.
          const l = Math.hypot(b.vx, b.vy) || 1;
          e.vx += (b.vx / l) * 40; e.vy += (b.vy / l) * 40;
        }

        if (b.pierce > 0) {
          b.pierce--;
          // Remember up to four victims so a pierce shot can't re-hit the same body.
          const slot = b.hn++ & 3;
          if (slot === 0) b.h0 = e.uid; else if (slot === 1) b.h1 = e.uid;
          else if (slot === 2) b.h2 = e.uid; else b.h3 = e.uid;
        } else {
          pool.releaseAt(i);
          consumed = true;
        }
        break;
      }
      if (consumed) continue;
    }
  }

  _nearestEnemyTo(x, y, maxDist) {
    let best = null, bd = maxDist * maxDist;
    for (let i = 0; i < this.enemies.active; i++) {
      const e = this.enemies.items[i];
      if (e.spawnT > 0) continue;
      const dx = e.x - x, dy = e.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = e; }
    }
    return best;
  }

  _updateEBullets(dt) {
    const pool = this.ebullets;
    const p = this.player;
    for (let i = pool.active - 1; i >= 0; i--) {
      const b = pool.items[i];
      b.life -= dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const a = this.arena;
      if (b.life <= 0 || b.x < a.x - 40 || b.x > a.x + a.w + 40 || b.y < a.y - 40 || b.y > a.y + a.h + 40) {
        pool.releaseAt(i); continue;
      }
      if (!p.alive) continue;
      const dx = p.x - b.x, dy = p.y - b.y;
      const rr = p.r + b.r;
      if (dx * dx + dy * dy < rr * rr) {
        this.damagePlayer(b.dmg, b.x, b.y);
        this.particles.burst(b.x, b.y, 8, 180, HAZARD_RGB, { life: 0.3, size: 2.6 });
        pool.releaseAt(i);
      }
    }
  }

  // ---------------------------------------------------------------- pickups

  _spawnPickup(x, y, type, value) {
    const pk = this.pickups.spawn();
    if (!pk) return;
    const a = this.rngAux.angle();
    const s = 60 + this.rngAux.next() * 130;
    pk.x = x; pk.y = y;
    pk.vx = Math.cos(a) * s; pk.vy = Math.sin(a) * s;
    pk.type = type; pk.value = value;
    pk.life = type === PK_XP ? 22 : 40;
    pk.r = type === PK_XP ? 4.5 : 7;
    pk.born = this.time;
  }

  _updatePickups(dt) {
    const pool = this.pickups;
    const p = this.player;
    const magnet = this.stats.magnet;
    const magnet2 = magnet * magnet;

    for (let i = pool.active - 1; i >= 0; i--) {
      const pk = pool.items[i];
      pk.life -= dt;
      if (pk.life <= 0) { pool.releaseAt(i); continue; }

      const dx = p.x - pk.x, dy = p.y - pk.y;
      const d2 = dx * dx + dy * dy;

      if (d2 < magnet2 && p.alive) {
        // Accelerating attraction — slow start, fast snap, very satisfying.
        const d = Math.sqrt(d2) || 1;
        const pull = 340 * (1 - d / magnet) + 220;
        pk.vx += (dx / d) * pull * dt * 6;
        pk.vy += (dy / d) * pull * dt * 6;
      } else {
        pk.vx *= Math.pow(0.9, dt * 60);
        pk.vy *= Math.pow(0.9, dt * 60);
      }

      pk.x += pk.vx * dt;
      pk.y += pk.vy * dt;

      const rr = p.r + pk.r + 4;
      if (d2 < rr * rr && p.alive) {
        this._collect(pk);
        pool.releaseAt(i);
      }
    }
  }

  _collect(pk) {
    const p = this.player;
    if (pk.type === PK_XP) {
      p.xp += pk.value;
      audio.pickup();
      this.particles.trail(pk.x, pk.y, XP_RGB, 4, 0.25);
      while (p.xp >= p.xpNext) {
        p.xp -= p.xpNext;
        p.level++;
        p.xpNext = xpForLevel(p.level);
        this.pendingLevelUps += this.mods.doubleUpgrade ? 2 : 1;
        this.particles.ring(p.x, p.y, 16, 210, 0.7, this.palette.accent, 5);
        this.particles.burst(p.x, p.y, 26, 300, this.palette.accent, { life: 0.7, size: 3.4 });
        audio.levelUp();
        juice.levelUp();
        this.onLevelUp?.();
      }
    } else if (pk.type === PK_SHARD) {
      this.runShards += pk.value;
      this.score += pk.value * 2;
      audio.shard();
      this.particles.text(pk.x, pk.y - 12, `+${pk.value}`, SHARD_RGB, 0.6, 13);
    } else {
      p.hp = Math.min(this.stats.maxHp, p.hp + pk.value);
      audio.pickup();
      this.particles.ring(p.x, p.y, 10, 54, 0.4, HEAL_RGB, 3);
      this.particles.text(p.x, p.y - 26, `+${pk.value}`, HEAL_RGB, 0.8, 16);
      juice.vibrate(14);
    }
  }

  // ---------------------------------------------------------------- orbitals

  _updateOrbitals(dt) {
    const n = this.stats.orbitals;
    if (n <= 0) return;
    const p = this.player;
    this.orbitAngle += dt * 2.3;
    this.orbitHitT -= dt;
    const radius = 62 + n * 4;

    if (this.orbitHitT <= 0) {
      const dmg = this.bulletDmg * 0.85;
      for (let k = 0; k < n; k++) {
        const a = this.orbitAngle + (k / n) * TAU;
        const ox = p.x + Math.cos(a) * radius;
        const oy = p.y + Math.sin(a) * radius;
        for (let i = this.enemies.active - 1; i >= 0; i--) {
          // A kill here can chain into Deathbloom and remove several enemies at once,
          // so the index has to be re-clamped rather than trusted.
          if (i >= this.enemies.active) { i = this.enemies.active; continue; }
          const e = this.enemies.items[i];
          if (e.spawnT > 0) continue;
          const dx = e.x - ox, dy = e.y - oy;
          const rr = e.r + 9;
          if (dx * dx + dy * dy < rr * rr) {
            this._hurtEnemy(e, i, dmg, false);
            this.particles.burst(ox, oy, 4, 140, this.palette.accent, { life: 0.22, size: 2.2 });
            this.orbitHitT = 0.28;
          }
        }
      }
    }
    if (Math.random() < dt * 26) {
      const a = this.orbitAngle + Math.random() * TAU;
      this.particles.trail(p.x + Math.cos(a) * radius, p.y + Math.sin(a) * radius,
                           this.palette.accent, 3, 0.28);
    }
  }

  // ---------------------------------------------------------------- drawing

  draw(r) {
    const ctx = r.ctx;
    const pal = this.palette;

    r.drawBackground(pal, this.arena, this.time);

    ctx.globalCompositeOperation = 'lighter';

    this._drawPickups(r);
    this._drawEnemies(r);
    this._drawEBullets(r);
    this._drawBullets(r);
    this._drawPlayer(r);

    ctx.globalCompositeOperation = 'source-over';
    r.drawParticles(this.particles);
  }

  _drawEnemies(r) {
    const ctx = r.ctx;
    const pal = this.palette;
    for (let i = 0; i < this.enemies.active; i++) {
      const e = this.enemies.items[i];
      const def = e.def;

      if (e.spawnT > 0) {
        // Telegraph: pulsing outline that resolves into the real silhouette.
        const t = 1 - e.spawnT / (e.elite ? 1.1 : 0.42);
        const alpha = 0.25 + t * 0.5;
        ctx.globalAlpha = alpha;
        const rr = e.r * (2.6 - t * 1.6);
        if (def.shape === 0) r.glowCircle(e.x, e.y, rr, pal.enemyBright, 2, 0.7, 0);
        else r.glowPoly(e.x, e.y, rr, def.shape, e.rot, pal.enemyBright, 2, 0.7, 0);
        ctx.globalAlpha = 1;
        continue;
      }

      const hpFrac = clamp(e.hp / e.maxHp, 0, 1);
      const intensity = 1 + e.flash * 1.6;
      const rgb = e.flash > 0.5 ? [255, 255, 255] : (e.elite ? HAZARD_RGB : pal.enemy);
      const wobble = e.elite ? 1 + Math.sin(this.time * 4) * 0.03 : 1;
      const rr = e.r * wobble;

      if (def.shape === 0) {
        r.glowCircle(e.x, e.y, rr, rgb, 3, intensity, 0.10);
        r.glowCircle(e.x, e.y, rr * 0.5, rgb, 2, intensity, 0);
      } else {
        r.glowPoly(e.x, e.y, rr, def.shape, e.rot, rgb, e.elite ? 5 : 3, intensity, 0.10);
        if (e.elite || def.shape >= 6) {
          r.glowPoly(e.x, e.y, rr * 0.55, def.shape, -e.rot * 1.4, rgb, 2, intensity * 0.8, 0);
        }
      }

      // Charge wind-up tell.
      if (def.behavior === 'charge' && e.state === 1) {
        const t = 1 - e.stateT / def.windup;
        r.glowCircle(e.x, e.y, e.r + 6 + t * 14, HAZARD_RGB, 1.5, 0.9, 0);
      }

      // Maw lunge tell: a contracting ring plus a line showing exactly where it will
      // go. The line is the important half — a ring alone says "something", a line
      // says "not here".
      if (def.behavior === 'lunge' && e.state === 1) {
        const t = 1 - e.stateT / def.windup;
        r.glowCircle(e.x, e.y, e.r + 26 - t * 20, HAZARD_RGB, 2 + t * 2, 1, 0);
        const dx = this.player.x - e.x, dy = this.player.y - e.y;
        const l = Math.hypot(dx, dy) || 1;
        ctx.globalAlpha = 0.30 + t * 0.45;
        r.glowStreak(e.x + (dx / l) * (e.r + 8 + t * 220), e.y + (dy / l) * (e.r + 8 + t * 220),
                     dx, dy, 40 + t * 190, 3, HAZARD_RGB, 1);
        ctx.globalAlpha = 1;
      }

      // Miniboss radial-sweep wind-up: an expanding ring of tick marks so you can
      // read both that it's coming and how long you have.
      if (e.state === 9 && def.sweepWindup) {
        const t = 1 - e.stateT / def.sweepWindup;
        r.glowCircle(e.x, e.y, e.r + 10 + t * 90, HAZARD_RGB, 1.5 + t * 2.5, 1, 0);
        const ticks = 12;
        ctx.globalAlpha = 0.5 + t * 0.5;
        for (let k = 0; k < ticks; k++) {
          const a = (k / ticks) * TAU + this.time * 0.6;
          const rr2 = e.r + 10 + t * 90;
          r.glowOrb(e.x + Math.cos(a) * rr2, e.y + Math.sin(a) * rr2, 3 + t * 3, HAZARD_RGB, 1);
        }
        ctx.globalAlpha = 1;
      }

      // Miniboss shield: a counter-rotating hex cage, so "you can't hurt this yet"
      // is legible without reading a health bar that isn't moving.
      if (e.shielded) {
        const pulse = 1 + Math.sin(this.time * 6) * 0.06;
        r.glowPoly(e.x, e.y, (e.r + 16) * pulse, 6, -e.rot * 2.2, this.palette.accent, 2.4, 1, 0.05);
        r.glowPoly(e.x, e.y, (e.r + 22) * pulse, 6, e.rot * 1.6, this.palette.accent, 1.2, 0.7, 0);
      }

      // Tessera tether — makes the parent/segment relationship explicit.
      if (e.parentUid) {
        const par = this._findByUid(e.parentUid);
        if (par) {
          ctx.globalAlpha = 0.28;
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = rgba(HAZARD_RGB, 0.8);
          ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(par.x, par.y); ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // Health arc for anything meaningfully tanky.
      if (e.maxHp > 40 && hpFrac < 0.999) {
        const hr = rr + 9;
        ctx.globalAlpha = 0.85;
        r.glowArc(e.x, e.y, hr, -Math.PI / 2, -Math.PI / 2 + TAU * hpFrac,
                  e.elite ? HAZARD_RGB : pal.accent, e.elite ? 4 : 2.4, 1);
        ctx.globalAlpha = 1;
      }
    }
  }

  _drawBullets(r) {
    const pal = this.palette;
    for (let i = 0; i < this.bullets.active; i++) {
      const b = this.bullets.items[i];
      const rgb = b.crit ? SHARD_RGB : pal.accent;
      const sp = Math.hypot(b.vx, b.vy) || 1;
      r.glowStreak(b.x, b.y, b.vx, b.vy, Math.min(26, sp * 0.028), b.size * 1.7, rgb, 1);
      r.glowOrb(b.x, b.y, b.size * 2.1, rgb, 0.9);
    }
  }

  _drawEBullets(r) {
    // Diamonds, always the same warm hue — the one read that never changes meaning.
    // These are the most numerous drawn object in a late run (250+), so they use the
    // pre-rendered sprite path: one drawImage each instead of a fill, two strokes and
    // a gradient orb. The trade is losing per-bullet spin, which nobody can see on a
    // 12px diamond moving at 200px/s.
    for (let i = 0; i < this.ebullets.active; i++) {
      const b = this.ebullets.items[i];
      r.spritePoly(b.x, b.y, b.r * 1.5, 4, HAZARD_RGB, 1);
    }
  }

  _drawPickups(r) {
    const ctx = r.ctx;
    for (let i = 0; i < this.pickups.active; i++) {
      const pk = this.pickups.items[i];
      // Blink out over the last 2 seconds so expiry is never a surprise.
      if (pk.life < 2 && Math.floor(pk.life * 8) % 2 === 0) continue;
      const bob = Math.sin((this.time - pk.born) * 5 + pk.x * 0.05) * 0.16 + 1;

      if (pk.type === PK_XP) {
        r.glowOrb(pk.x, pk.y, pk.r * 2.6 * bob, XP_RGB, 0.85);
      } else if (pk.type === PK_SHARD) {
        r.glowPoly(pk.x, pk.y, pk.r * bob, 3, this.time * 2.4, SHARD_RGB, 2.4, 1, 0.35);
        r.glowOrb(pk.x, pk.y, pk.r * 2.4, SHARD_RGB, 0.55);
      } else {
        const s = pk.r * bob;
        ctx.lineWidth = 3;
        ctx.strokeStyle = rgba(HEAL_RGB, 0.9);
        ctx.beginPath();
        ctx.moveTo(pk.x - s, pk.y); ctx.lineTo(pk.x + s, pk.y);
        ctx.moveTo(pk.x, pk.y - s); ctx.lineTo(pk.x, pk.y + s);
        ctx.stroke();
        r.glowOrb(pk.x, pk.y, s * 2.6, HEAL_RGB, 0.7);
      }
    }
  }

  /** Shared by the hull pass and the face overlay so they blink in lockstep. */
  _playerVisible() {
    const p = this.player;
    if (!p.alive) return false;
    // Invulnerability blink — skip frames rather than fade, so it's unmistakable.
    if (p.iframes > 0 && Math.floor(p.iframes * 18) % 2 === 0 && p.dashT <= 0) return false;
    return true;
  }

  _drawPlayer(r) {
    if (!this._playerVisible()) return;
    const p = this.player;
    const pal = this.palette;
    const trail = trailColor(this.trailId, this.time);
    const hurt = p.hurtFlash;
    const body = hurt > 0.1 ? [255, 210, 210] : trail;

    // Orbitals first so they sit behind the hull.
    const n = this.stats.orbitals;
    if (n > 0) {
      const radius = 62 + n * 4;
      for (let k = 0; k < n; k++) {
        const a = this.orbitAngle + (k / n) * TAU;
        const ox = p.x + Math.cos(a) * radius, oy = p.y + Math.sin(a) * radius;
        r.glowPoly(ox, oy, 8, 3, this.time * 5 + k, pal.accent, 2.2, 1, 0.3);
        r.glowOrb(ox, oy, 15, pal.accent, 0.5);
      }
    }

    // Outer ring rotates opposite the hull — cheap way to read as "powered".
    r.glowCircle(p.x, p.y, p.r + 7, body, 1.6, 0.55, 0);
    r.glowPoly(p.x, p.y, p.r, 3, p.aim, body, 3.4, 1 + hurt, 0.16);
    r.glowOrb(p.x, p.y, p.r * 2.4, body, 0.8 + hurt * 0.4);

    // Face is NOT drawn here — see drawFaceOverlay(). This pass still runs inside
    // begin()/end(), and end() blurs the whole scene for bloom and adds it straight
    // back on top. That blur doesn't know or care that the eye sockets are dark; it
    // just smears the surrounding bright hull glow over them, and the sockets lose
    // all contrast. Drawing the face in a separate pass *after* the bloom composite
    // is what actually fixes it — not a layering trick within this pass.

    // Aim indicator: a short spur, not a laser sight — keeps the screen clean.
    const ax = p.x + Math.cos(p.aim) * (p.r + 16);
    const ay = p.y + Math.sin(p.aim) * (p.r + 16);
    r.glowOrb(ax, ay, 7, pal.accent, 0.55);

    if (p.shield > 0) {
      const pulse = 1 + Math.sin(this.time * 5) * 0.05;
      r.glowCircle(p.x, p.y, (p.r + 15) * pulse, pal.accent, 2.2, 0.85, 0.05);
    }

    // Dash charge pips orbit below the player.
    if (this.stats.dashCharges > 1 || p.dashLeft < this.stats.dashCharges) {
      for (let k = 0; k < this.stats.dashCharges; k++) {
        const a = Math.PI / 2 + (k - (this.stats.dashCharges - 1) / 2) * 0.36;
        const px = p.x + Math.cos(a) * (p.r + 20);
        const py = p.y + Math.sin(a) * (p.r + 20);
        const ready = k < p.dashLeft;
        r.glowOrb(px, py, ready ? 5 : 3, ready ? pal.accent : pal.primaryDim, ready ? 0.9 : 0.35);
      }
    }
  }

  /**
   * Draws the face in a pass of its own, called from main.js AFTER r.end() has already
   * run the bloom/chroma/vignette pipeline. The hull is drawn during the normal
   * begin()/end() bracket like everything else and gets bloomed like everything else;
   * the face is deliberately excluded from that so the dark eye sockets keep their
   * contrast instead of being smeared over by the blurred hull glow sitting behind them.
   *
   * Uses the exact same camera/shake/zoom transform the entity pass used (via
   * Renderer.withWorldTransform), so the face still tracks the hull pixel-for-pixel —
   * this only changes *when* it's drawn relative to bloom, not where.
   */
  drawFaceOverlay(r) {
    const p = this.player;
    const showPlayer = this._playerVisible();

    // One transform push for every face in the scene — player and enemies alike — so
    // the post-bloom pass costs a single save/restore rather than one per character.
    r.withWorldTransform(juice, (ctx) => {
      // Measured at ~81us per face: each one is a source-over pass with two rounded-rect
      // fills and two arc fills, which breaks the batched additive entity pass. That's
      // fine at the 10-15 faced enemies real play produces (~1ms), but the cap bounds a
      // pathological spawn from spending the whole frame budget on eyeballs. Elites are
      // exempt — losing a miniboss's face to a crowd of Bulwarks would be backwards.
      let budget = 20;
      for (let i = 0; i < this.enemies.active; i++) {
        const e = this.enemies.items[i];
        if (!e.face || e.spawnT > 0) continue;
        if (!e.elite && budget <= 0) continue;
        // Cull off-screen faces: the sockets are opaque fills, and at 100+ enemies the
        // ones outside the view are pure waste.
        if (!r.inView(e.x, e.y, e.r * 3)) continue;
        if (!e.elite) budget--;
        e.face.draw(ctx, e.x, e.y, e.r * 1.55, e.elite ? HAZARD_RGB : this.palette.enemyBright);
      }
      if (showPlayer) {
        this.face.draw(ctx, p.x, p.y + p.r * 0.06, p.r * 1.9, this.core.pupilRgb);
      }
    });
  }

  // ---------------------------------------------------------------- results

  results() {
    return {
      isDaily: this.cfg.isDaily,
      date: this.cfg.dateKey,
      mutator: this.cfg.mutator,
      score: this.score,
      time: this.time,
      timeStr: formatTime(this.time),
      kills: this.kills,
      level: this.player.level,
      shards: Math.round(this.runShards),
      bestCombo: this.bestCombo,
      tier: this.tier,
      tierName: TIERS[this.tier].name,
    };
  }
}

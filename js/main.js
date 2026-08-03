// Bootstrap, fixed-timestep loop, state machine.
//
// Simulation runs at a fixed 120 steps/sec with an accumulator, rendering once per rAF.
// A fixed step is what makes the Daily Run reproducible: floating-point integration with
// a variable dt would diverge between a 60Hz and a 120Hz phone within seconds, and two
// players would get different runs from the same seed.

import { save } from './core/save.js';
import { audio } from './core/audio.js';
import { Input } from './core/input.js';
import { Renderer } from './fx/render.js';
import { juice } from './fx/juice.js';
import { Run } from './game/run.js';
import { makeRunConfig } from './game/daily.js';
import { UI } from './ui/screens.js';
import { todayKey } from './core/rng.js';
import { voice } from './game/voice.js';
import { coreFor } from './game/characters.js';

const STEP = 1 / 120;
const MAX_FRAME = 0.25;   // never simulate more than a quarter second after a tab stall

const S_MENU = 'menu', S_PLAYING = 'playing', S_LEVELUP = 'levelup',
      S_PAUSED = 'paused', S_OVER = 'over';

class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.renderer = new Renderer(this.canvas);
    this.input = new Input(this.canvas, {
      leftHanded: save.data.settings.leftHanded,
      manualAim: !save.data.settings.autoFire,
    });
    this.ui = new UI(this);

    this.run = null;
    this.state = S_MENU;
    this.lastMode = 'daily';
    this.pendingConfig = null;
    this.acc = 0;
    this.lastT = 0;
    this.fpsSamples = [];
    this.autoQualityChecked = false;
    this.deferredInstall = null;

    this._applySettings();
    this._bindLifecycle();
    this._bindInstall();

    // Menu background: an idle run nobody plays, purely so the title screen isn't static.
    this._startAmbient();

    // First launch gets the framing before the menu — it's one screen, once, and it's
    // the only place the daily loop is given a reason.
    if (!save.data.seenTutorial) this.ui.showAbout();
    else this.ui.show('menu');
    this.ui.setHudVisible(false);

    this.lastT = performance.now();
    requestAnimationFrame((t) => this._frame(t));
  }

  // ------------------------------------------------------------ setup

  _applySettings() {
    const s = save.data.settings;
    audio.muted = s.muted;
    audio.sfxVol = s.sfxVolume;
    audio.musicVol = s.musicVolume;
    juice.shakeScale = s.screenShake;
    juice.haptics = s.haptics;
    this.setQuality(s.quality);
  }

  setQuality(q) {
    this.qualityMode = q;
    const effective = q === 'auto' ? (this._autoQuality || 'high') : q;
    this.renderer.setQuality(effective);
    if (this.run) this.run.particles.setBudget(effective === 'high' ? 1 : 0.55);
    if (this.ambient) this.ambient.particles.setBudget(effective === 'high' ? 1 : 0.55);
  }

  setColorblind(v) {
    if (this.run) this.run.palette.setColorblind(v);
    if (this.ambient) this.ambient.palette.setColorblind(v);
  }

  _bindLifecycle() {
    window.addEventListener('resize', () => this.renderer.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.renderer.resize(), 220));

    // Auto-pause when the app is backgrounded. Nothing is more annoying than dying to
    // a phone call.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.state === S_PLAYING) this.pause();
        audio.stopMusic(0.3);
      }
    });

    // Audio unlock on the first real gesture, anywhere.
    const unlock = async () => {
      const ok = await audio.unlock();
      if (ok) {
        audio.setMuted(save.data.settings.muted);
        audio.setSfxVolume(save.data.settings.sfxVolume);
        audio.setMusicVolume(save.data.settings.musicVolume);
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
      }
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        if (this.state === S_PLAYING) this.pause();
        else if (this.state === S_PAUSED) this.resume();
      }
      if (e.code === 'KeyP' && this.state === S_PLAYING) this.pause();
      // Number keys pick upgrades — makes desktop testing far faster.
      if (this.state === S_LEVELUP && /^Digit[123]$/.test(e.code)) {
        const cards = document.querySelectorAll('#upgrade-cards .up-card');
        cards[+e.code.slice(5) - 1]?.click();
      }
    });

    window.addEventListener('beforeunload', () => save.saveNow());
  }

  _bindInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstall = e;
      this.ui.showInstallButton(true);
    });
    window.addEventListener('appinstalled', () => {
      this.deferredInstall = null;
      this.ui.showInstallButton(false);
      this.ui.toast('Pulsegrid installed.');
    });
  }

  async promptInstall() {
    if (!this.deferredInstall) {
      this.ui.toast('Use your browser menu → Add to Home Screen.');
      return;
    }
    this.deferredInstall.prompt();
    await this.deferredInstall.userChoice;
    this.deferredInstall = null;
    this.ui.showInstallButton(false);
  }

  // ------------------------------------------------------------ ambient

  /** A live but unplayed arena behind the menus. Enemies spawn, drift, and die to nothing. */
  _startAmbient() {
    const cfg = makeRunConfig('practice');
    this.ambient = new Run(cfg);
    this.ambient.player.alive = false;   // no shooting, no collision damage
    this.ambient.stats.magnet = 0;
    this.renderer.snapCamera(0, 0);
  }

  // ------------------------------------------------------------ flow

  openBrief(mode) {
    this.lastMode = mode;
    this.pendingConfig = makeRunConfig(mode, todayKey());
    this.ui.showBrief(this.pendingConfig);
  }

  beginRun() {
    const cfg = this.pendingConfig || makeRunConfig(this.lastMode, todayKey());
    this.pendingConfig = null;

    this.run = new Run(cfg);
    this.run.particles.setBudget(this.renderer.quality === 'high' ? 1 : 0.55);

    const core = coreFor(save.data.equippedWeapon);
    voice.setCore(core.id);
    const say = (kind) => this.ui.say(core.name, voice.player(kind), kind);

    this.run.onLevelUp = () => { this._queueLevelUp(); say('levelUp'); };
    this.run.onGameOver = () => this._endRun();
    this.run.onTierChange = (tier) => { this.ui.banner(tier.name); say('tierShift'); };
    this.run.onEliteSpawn = () => this.ui.banner('WARDEN INBOUND');
    this.run.onEliteKilled = () => say('eliteKill');
    this.run.onRevive = () => { this.ui.banner('SECOND CORE'); say('nearDeath'); };
    this.run.onHurt = () => {
      // Below a quarter integrity the character stops joking about the hit and starts
      // commenting on being nearly dead — same trigger, different register.
      say(this.run.player.hp / this.run.stats.maxHp <= 0.25 ? 'nearDeath' : 'hurt');
    };
    this._say = say;

    this.renderer.snapCamera(this.run.player.x, this.run.player.y);
    juice.reset();
    this.ui.resetHudCache();
    this.ui.hideAll();
    this.ui.hideVoice();
    this.ui.setHudVisible(true);
    this.state = S_PLAYING;
    this.acc = 0;

    audio.unlock().then(() => audio.startMusic());
    this.ui.banner(cfg.isDaily ? (cfg.mutator?.name || 'DAILY') : 'PRACTICE');
  }

  _queueLevelUp() {
    // Deferred: the death of the enemy that dropped the last mote should finish
    // resolving before the game freezes for a menu.
    if (this.state === S_PLAYING) this._pendingLevelUpCheck = true;
  }

  _openLevelUp() {
    const run = this.run;
    if (run.pendingLevelUps <= 0) return;
    const choices = run.rollUpgradeChoices(3);
    if (!choices.length) { run.pendingLevelUps = 0; return; }
    this.state = S_LEVELUP;
    this.ui.showUpgrades(choices, run.player.level, (choice) => {
      run.applyUpgrade(choice);
      run.pendingLevelUps--;
      this.ui.hideAll();
      if (run.pendingLevelUps > 0) {
        // FAMINE hands out two per level; chain the menus.
        setTimeout(() => this._openLevelUp(), 60);
      } else {
        this.state = S_PLAYING;
        this.ui.setHudVisible(true);
      }
    });
  }

  pause() {
    if (this.state !== S_PLAYING) return;
    this.state = S_PAUSED;
    this.ui.showPause(this.run);
    audio.setIntensity(0.1);
  }

  resume() {
    if (this.state !== S_PAUSED) return;
    this.ui.hideAll();
    this.ui.setHudVisible(true);
    this.state = S_PLAYING;
    this.acc = 0;
    this.lastT = performance.now();
  }

  abandon() {
    if (!this.run) return;
    // Abandoning still banks the shards you actually collected — it's not a punishment
    // mechanic, and hiding the exit behind a loss would just teach people to alt-tab.
    this._endRun(true);
  }

  _endRun(abandoned = false) {
    if (this.state === S_OVER) return;
    const run = this.run;
    this.state = S_OVER;
    run.over = true;
    audio.stopMusic(1.4);

    const res = run.results();
    let streakResult = null;

    // Snapshot the records BEFORE recordRun folds this run into them. Otherwise the
    // results screen compares the run against itself and every new best reads
    // "+0 over your best" / "yesterday: —".
    // (Yesterday's entry needs no snapshot — recordRun only ever touches today's.)
    const priorBest = res.isDaily ? save.data.bestDailyScore : save.data.bestPracticeScore;
    const priorToday = res.isDaily ? save.dailyScore(res.date) : null;

    if (res.isDaily && !abandoned) {
      streakResult = save.commitDaily(res.date);
      if (streakResult.milestone) {
        setTimeout(() => audio.milestone(), 700);
      }
    }
    save.recordRun({
      isDaily: res.isDaily && !abandoned,
      date: res.date,
      score: res.score, wave: res.tier, time: res.time,
      kills: res.kills, shards: res.shards,
    });

    // Let the death explosion breathe before the results screen slides in.
    setTimeout(() => {
      this.ui.setHudVisible(false);
      this.ui.hideVoice();
      this.ui.showGameOver(res, streakResult, { priorBest, priorToday });
      if (!abandoned && res.score > 0) audio.runComplete(res.score > priorBest);
    }, abandoned ? 120 : 1100);
  }

  // ------------------------------------------------------------ loop

  _frame(now) {
    requestAnimationFrame((t) => this._frame(t));

    let dt = (now - this.lastT) / 1000;
    this.lastT = now;
    if (!(dt > 0)) return;
    if (dt > MAX_FRAME) dt = MAX_FRAME;

    this._trackFps(dt);

    audio.update(dt);
    const simDt = juice.update(dt);

    const active = this.state === S_PLAYING ? this.run
                 : (this.state === S_PAUSED || this.state === S_LEVELUP || this.state === S_OVER) ? this.run
                 : this.ambient;

    if (this.state === S_PLAYING && this.run) {
      this.input.update();
      this.acc += simDt;
      let steps = 0;
      while (this.acc >= STEP && steps < 8) {
        this.run.update(STEP, this.input);
        this.acc -= STEP;
        steps++;
        if (this.run.over) break;
      }
      // If we blew the step budget (very slow device), drop the backlog rather than
      // spiralling — better to lose a little time than to stutter forever.
      if (steps >= 8) this.acc = 0;

      this.ui.updateHud(this.run);

      if (this._pendingLevelUpCheck && this.run.pendingLevelUps > 0 && !this.run.over) {
        this._pendingLevelUpCheck = false;
        this._openLevelUp();
      }
    } else if (this.state === S_OVER && this.run) {
      this.run.update(simDt, this.input);
    } else if (active === this.ambient) {
      this.input.update();
      this._updateAmbient(simDt);
    }

    this.ui.updatePortraits(dt);
    this._render(active, dt);
  }

  _updateAmbient(dt) {
    const a = this.ambient;
    // Drive the "player" on a slow lissajous so the camera drifts and the arena breathes.
    const t = performance.now() / 1000;
    a.player.x = Math.cos(t * 0.17) * 340;
    a.player.y = Math.sin(t * 0.23) * 300;
    a.update(dt, { moveX: 0, moveY: 0, moveMag: 0, aimMag: 0, firing: false,
                   manualAim: false, consumeDash: () => false });
    // Cull anything that crowds the camera, so the menu never looks besieged.
    for (let i = a.enemies.active - 1; i >= 0; i--) {
      const e = a.enemies.items[i];
      const dx = e.x - a.player.x, dy = e.y - a.player.y;
      if (dx * dx + dy * dy < 210 * 210) a.enemies.releaseAt(i);
    }
    a.time = Math.min(a.time, 40);   // hold the ambient arena at an easy difficulty
  }

  _render(active, dt) {
    if (!active) return;
    const r = this.renderer;
    r.syncSize();
    const pal = active.palette;

    r.updateCamera(active.player.x, active.player.y, active.arena, dt, {
      x: active.player.vx * 0.09, y: active.player.vy * 0.09,
    });

    r.begin(pal, juice);
    active.draw(r);
    r.end(pal, juice);

    if (this.state === S_PLAYING) r.drawStick(this.input.stickVisual(), pal);

    // Keep the CSS palette in step with the arena.
    this.ui.setHue(pal.hue, pal.colorblind ? pal.hue : pal.hue + 20);
  }

  _trackFps(dt) {
    if (this.qualityMode !== 'auto' || this.autoQualityChecked) return;
    this.fpsSamples.push(dt);
    // Ignore the first ~40 frames (module eval, first paint, audio graph construction).
    if (this.fpsSamples.length < 140) return;
    const recent = this.fpsSamples.slice(40);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    this.autoQualityChecked = true;
    this.fpsSamples.length = 0;
    if (avg > 1 / 48) {
      this._autoQuality = 'low';
      this.setQuality('auto');
      console.info(`[pulsegrid] auto quality -> low (avg ${(1 / avg).toFixed(1)} fps)`);
    } else {
      this._autoQuality = 'high';
    }
  }
}

// ------------------------------------------------------------------ boot

function boot() {
  window.game = new Game();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[pulsegrid] sw failed', e));
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

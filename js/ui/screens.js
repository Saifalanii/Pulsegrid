// DOM UI: screens, HUD, shop, settings, records.
//
// Kept out of the render loop entirely. The HUD only touches the DOM when a value
// actually changes (cached in `this._last`), because layout thrash on a mid-range phone
// is the fastest way to lose the 60fps target.

import { save, MILESTONES } from '../core/save.js';
import { audio } from '../core/audio.js';
import { juice } from '../fx/juice.js';
import { SHOP, WEAPONS, STREAK_LOCKED } from '../game/defs.js';
import { TRAILS } from '../game/palette.js';
import { mutatorFor, msUntilTomorrow, formatCountdown, MUTATORS } from '../game/daily.js';
import { todayKey, dayOffsetKey } from '../core/rng.js';
import { formatTime, clamp } from '../core/math.js';
import { Portrait } from '../fx/face.js';
import { CORES, RIVAL, STAKES, TRAIL_BLURBS, coreFor } from '../game/characters.js';
import { voice } from '../game/voice.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const SCREENS = ['menu', 'brief', 'levelup', 'pause', 'gameover', 'shop', 'settings', 'stats', 'about'];

/** Voice priorities — a louder line interrupts a quieter one, never the reverse. */
const V_PRIORITY = { chatter: 0, hurt: 1, levelUp: 1, tierShift: 1, eliteKill: 2, nearDeath: 3, death: 4, milestone: 4 };

/** Upgrade card glyphs — same geometric language as the enemies. */
function shapeSvg(sides, color) {
  if (sides === 0) {
    return `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="${color}" stroke-width="2.2"/><circle cx="12" cy="12" r="3" fill="${color}"/></svg>`;
  }
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + (i / sides) * Math.PI * 2;
    pts.push(`${(12 + Math.cos(a) * 9).toFixed(2)},${(12 + Math.sin(a) * 9).toFixed(2)}`);
  }
  return `<svg viewBox="0 0 24 24" fill="none"><polygon points="${pts.join(' ')}" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" fill="${color}22"/></svg>`;
}

export class UI {
  constructor(game) {
    this.game = game;
    this.current = null;
    this._last = {};
    this._countdownTimer = 0;
    this._toastTimer = 0;
    this.hud = $('hud');

    // Voice ticker state.
    this._voiceUntil = 0;
    this._voicePriority = -1;
    this._voiceCooldown = 0;

    // Portraits are created lazily and only ticked while their screen is visible.
    this.portraits = {};

    this._bind();
  }

  // ------------------------------------------------------------ voice

  /**
   * Show a line in the in-run ticker.
   * @param {string} who speaker label
   * @param {string} line
   * @param {string} kind priority bucket, see V_PRIORITY
   * @param {boolean} isRival tints the chip
   */
  say(who, line, kind = 'chatter', isRival = false) {
    if (!line) return;
    const now = performance.now();
    const pri = V_PRIORITY[kind] ?? 0;

    // A quieter line can't stomp a louder one that's still on screen, and ordinary
    // chatter is rate-limited so a busy fight doesn't turn into a wall of text.
    if (now < this._voiceUntil && pri < this._voicePriority) return;
    if (pri <= 1 && now < this._voiceCooldown) return;

    const box = $('voice');
    $('voice-who').textContent = who;
    $('voice-line').textContent = line;
    box.classList.toggle('rival', isRival);
    box.classList.add('show');

    const dur = 1500 + Math.min(2200, line.length * 46);
    this._voiceUntil = now + dur;
    this._voicePriority = pri;
    this._voiceCooldown = now + (pri <= 1 ? 4200 : 1200);
    clearTimeout(this._voiceTimer);
    this._voiceTimer = setTimeout(() => {
      box.classList.remove('show');
      this._voicePriority = -1;
    }, dur);
  }

  /** Cheap enough to poll every frame; avoids a style write when there's nothing shown. */
  voiceVisible() { return this._voicePriority >= 0; }

  hideVoice() {
    clearTimeout(this._voiceTimer);
    $('voice').classList.remove('show');
    this._voiceUntil = 0;
    this._voicePriority = -1;
  }

  /**
   * Re-anchors the speech bubble to the player's current on-screen position. Called
   * once per frame from the main loop while a run is active — the player moves
   * constantly, so this can't be set once in say() and left alone, or the bubble
   * would drift away from the character within a second.
   *
   * Clamped inward from the true edges (roughly half the bubble's own max-width/height)
   * so it can't render partway off-screen when the player is near the arena boundary —
   * the same class of bug as the countdown-clipping fix elsewhere, avoided up front
   * instead of relying on the browser to do something sensible with an off-screen box.
   *
   * @param {number} sx screen-space (css px) x
   * @param {number} sy screen-space (css px) y
   */
  positionVoiceNear(sx, sy) {
    const marginX = 178;   // ~half of .voice's max-width (340px) plus a little air
    const marginTop = 90;  // bubble height + tail + HUD score/time row it must clear
    const marginBottom = 70;
    const x = clamp(sx, marginX, Math.max(marginX, window.innerWidth - marginX));
    const y = clamp(sy, marginTop, Math.max(marginTop, window.innerHeight - marginBottom));
    const box = $('voice');
    box.style.left = x + 'px';
    box.style.top = y + 'px';
  }

  // ------------------------------------------------------------ portraits

  /** @returns {Portrait|null} */
  portrait(canvasId, def) {
    let p = this.portraits[canvasId];
    const el = $(canvasId);
    if (!el) return null;
    if (!p || p.canvas !== el) {
      p = new Portrait(el, def);
      this.portraits[canvasId] = p;
    } else {
      p.def = def;
    }
    return p;
  }

  /** Called from the main loop; only the visible screen's portraits cost anything. */
  updatePortraits(dt) {
    const screen = this.current;
    const ids = screen === 'brief' ? ['brief-rival-face']
              : screen === 'gameover' ? ['go-core-face', 'go-rival-face']
              : screen === 'about' ? ['about-core-face', 'about-rival-face']
              : null;
    if (!ids) return;
    for (const id of ids) {
      const p = this.portraits[id];
      if (p) { p.update(dt); p.draw(); }
    }
  }

  // ------------------------------------------------------------ navigation

  show(name) {
    for (const s of SCREENS) {
      const node = $(s);
      if (s === name) {
        node.classList.remove('hidden', 'leaving');
        // Force a reflow so the entry animation replays on repeat visits.
        void node.offsetWidth;
      } else if (!node.classList.contains('hidden')) {
        node.classList.add('hidden');
      }
    }
    this.current = name || null;
    if (name === 'menu') this.refreshMenu();
    if (name === 'shop') this.buildShop();
    if (name === 'settings') this.buildSettings();
    if (name === 'stats') this.buildRecords();
  }

  hideAll() { this.show(null); }

  setHudVisible(v) {
    this.hud.classList.toggle('hidden', !v);
    this.hud.setAttribute('aria-hidden', String(!v));
  }

  /** Cross-fade the whole interface to the current biome hue. */
  setHue(hue, accentHue) {
    document.documentElement.style.setProperty('--hue', hue.toFixed(1));
    document.documentElement.style.setProperty('--accent-hue', accentHue.toFixed(1));
  }

  toast(msg, ms = 2400) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    void t.offsetWidth;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.classList.add('hidden'), 300);
    }, ms);
  }

  banner(text) {
    const b = $('hud-banner');
    b.textContent = text;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
  }

  // ------------------------------------------------------------ bindings

  _bind() {
    const g = this.game;
    const click = (id, fn) => {
      const node = $(id);
      if (!node) return;
      node.addEventListener('click', (e) => {
        e.preventDefault();
        audio.uiClick();
        juice.vibrate(8);
        fn(e);
      });
    };

    click('btn-daily', () => g.openBrief('daily'));
    click('btn-practice', () => g.openBrief('practice'));
    click('btn-begin', () => g.beginRun());
    click('btn-brief-back', () => { audio.uiBack(); this.show('menu'); });

    click('btn-pause', () => g.pause());
    click('btn-resume', () => g.resume());
    click('btn-quit', () => g.abandon());
    click('btn-pause-settings', () => { this._settingsReturn = 'pause'; this.show('settings'); });

    // After a Daily, "again" can only mean Practice — the attempt is spent. Falling
    // through to openBrief('daily') would just bounce off its guard with a toast,
    // which reads as a broken button rather than a deliberate rule.
    click('btn-again', () => g.openBrief(g.lastMode === 'daily' && save.dailyLocked() ? 'practice' : g.lastMode));
    click('btn-menu', () => this.show('menu'));
    click('btn-go-shop', () => { this._shopReturn = 'gameover'; this.show('shop'); });

    click('btn-shop', () => { this._shopReturn = 'menu'; this.show('shop'); });
    click('btn-shop-back', () => { audio.uiBack(); this.show(this._shopReturn || 'menu'); });
    click('btn-settings', () => { this._settingsReturn = 'menu'; this.show('settings'); });
    click('btn-settings-back', () => { audio.uiBack(); this.show(this._settingsReturn || 'menu'); });
    click('btn-stats', () => this.show('stats'));
    click('btn-stats-back', () => { audio.uiBack(); this.show('menu'); });
    click('btn-about', () => this.showAbout());
    click('btn-about-ok', () => {
      save.data.seenTutorial = true;
      save.saveNow();
      this.show('menu');
    });
    click('btn-install', () => g.promptInstall());

    click('btn-reset', () => {
      if (this._resetArmed) {
        save.reset();
        this.toast('Progress erased.');
        this._resetArmed = false;
        this.buildSettings();
        this.show('menu');
      } else {
        this._resetArmed = true;
        $('btn-reset').textContent = 'TAP AGAIN TO CONFIRM';
        setTimeout(() => {
          this._resetArmed = false;
          const b = $('btn-reset');
          if (b) b.textContent = 'ERASE ALL PROGRESS';
        }, 4000);
      }
    });
  }

  // ------------------------------------------------------------ menu

  refreshMenu() {
    const today = todayKey();
    const mut = mutatorFor(today);
    $('daily-date').textContent = today;
    $('daily-mutator').textContent = mut.name;
    $('daily-mutator-desc').textContent = mut.desc;
    $('menu-shards').textContent = save.data.shards.toLocaleString();

    // --- daily lock ---
    // Three states, not two: unplayed, played-and-finished (we have a score to show),
    // and spent-without-a-score (started then quit, or force-quit mid-run). The last
    // one still consumes the attempt, so it needs its own copy rather than falling
    // through to "—" and looking like a bug.
    const todayRun = save.dailyScore(today);
    const locked = save.dailyLocked(today);
    const btn = $('btn-daily');
    const label = $('daily-best-label');

    $('daily-best').textContent = todayRun ? todayRun.score.toLocaleString() : (locked ? 'NO SCORE' : '—');
    if (label) label.textContent = locked ? "TODAY'S RESULT" : 'YOUR BEST TODAY';

    btn.disabled = locked;
    btn.classList.toggle('done', locked);
    btn.textContent = locked ? 'DAILY COMPLETE' : 'PLAY DAILY';

    if (!locked) {
      $('daily-note').textContent = 'Everyone gets this exact run today. One attempt.';
    } else if (todayRun) {
      $('daily-note').textContent =
        `Survived ${formatTime(todayRun.time)} · ${todayRun.kills} kills. Next Daily unlocks in the countdown above.`;
    } else {
      $('daily-note').textContent =
        'Attempt used. Practice runs are unlimited — the Daily returns tomorrow.';
    }

    // Streak block.
    const st = save.streakStatus(today);
    const flame = $('streak-flame');
    $('streak-count').textContent = st.streak;
    flame.classList.toggle('cold', st.streak === 0);
    const sub = $('streak-sub');
    sub.className = 'streak-sub';
    if (st.playedToday) {
      sub.textContent = `Locked in for today. Come back tomorrow to reach ${st.streak + 1}.`;
    } else if (st.atRisk) {
      sub.textContent = `Play today or the ${st.streak}-day streak resets to zero.`;
      sub.classList.add('warn');
    } else if (st.broken) {
      const lost = save.data.streak;
      sub.textContent = `You missed a day. The ${lost}-day streak is gone.`;
      sub.classList.add('bad');
    } else if (st.streak === 0) {
      sub.textContent = 'Play today’s daily to begin.';
    }

    // Milestones.
    const ms = $('milestones');
    ms.innerHTML = '';
    const nextM = MILESTONES.find((m) => m.days > st.streak);
    for (const m of MILESTONES) {
      const done = save.data.claimedMilestones.includes(m.days);
      const node = el('div', 'milestone' + (done ? ' done' : (nextM && nextM.days === m.days ? ' next' : '')));
      node.innerHTML = `<span class="d">${m.days}</span>${done ? 'CLAIMED' : `◆${m.shards}`}`;
      node.title = `${m.label} — ${m.shards} shards${m.unlockName ? ' + ' + m.unlockName : ''}`;
      ms.appendChild(node);
    }

    this._startCountdown();
  }

  _startCountdown() {
    clearInterval(this._countdownTimer);
    const tick = () => {
      const node = $('daily-countdown');
      if (!node) return;
      node.textContent = formatCountdown(msUntilTomorrow());
    };
    tick();
    this._countdownTimer = setInterval(tick, 1000);
  }

  showInstallButton(show) {
    $('btn-install').classList.toggle('hidden', !show);
  }

  // ------------------------------------------------------------ brief

  showBrief(cfg) {
    $('brief-mode').textContent = cfg.isDaily ? 'DAILY RUN' : 'PRACTICE RUN';
    $('brief-date').textContent = cfg.isDaily
      ? `${cfg.dateKey}  •  SEED ${cfg.seed.toString(16).toUpperCase()}`
      : 'Unseeded. Does not count toward your streak.';

    if (cfg.mutator) {
      $('brief-mutator').textContent = cfg.mutator.name;
      $('brief-mutator-desc').textContent = cfg.mutator.desc;
    } else {
      $('brief-mutator').textContent = 'NO MUTATOR';
      $('brief-mutator-desc').textContent = 'Standard rules. Practice freely — nothing is at stake.';
    }

    const core = coreFor(save.data.equippedWeapon);
    const trail = TRAILS[save.data.equippedTrail] || TRAILS.trail_cyan;
    $('brief-loadout').innerHTML =
      `<div>CORE<b>${core.name}</b></div>` +
      `<div>TRAIL<b>${trail.name}</b></div>` +
      `<div>SHARDS<b>◆ ${save.data.shards.toLocaleString()}</b></div>`;

    // The rival only shows up for the Daily — that's the run they care about.
    const rivalBlock = $('brief-rival');
    if (cfg.isDaily) {
      rivalBlock.classList.remove('hidden');
      $('brief-rival-line').textContent = voice.rival('dailyStart');
      this.portrait('brief-rival-face', RIVAL)?.resize();
    } else {
      rivalBlock.classList.add('hidden');
    }

    this.show('brief');
  }

  showAbout() {
    const core = coreFor(save.data.equippedWeapon);
    $('about-core-name').textContent = core.name;
    $('about-core-role').textContent = core.role;
    $('about-line').textContent = STAKES.line;
    $('about-line2').textContent = STAKES.line2.replace('Nim', core.name);
    $('about-signoff').textContent = STAKES.signoff;
    this.show('about');
    this.portrait('about-core-face', core)?.resize();
    this.portrait('about-rival-face', RIVAL)?.resize();
  }

  // ------------------------------------------------------------ HUD

  updateHud(run) {
    const L = this._last;
    const p = run.player, s = run.stats;

    const score = Math.round(run.score);
    if (score !== L.score) {
      const node = $('hud-score');
      node.textContent = score.toLocaleString();
      if (score > (L.score || 0)) {
        node.classList.remove('bump'); void node.offsetWidth; node.classList.add('bump');
      }
      L.score = score;
    }

    const combo = run.combo;
    if (combo !== L.combo) {
      const node = $('hud-combo');
      if (combo >= 3) {
        node.textContent = `x${(1 + Math.min(4, combo * 0.08)).toFixed(2)}  ${combo} CHAIN`;
        node.classList.add('on');
        node.classList.remove('bump'); void node.offsetWidth; node.classList.add('bump');
      } else {
        node.classList.remove('on');
      }
      L.combo = combo;
    }

    const t = Math.floor(run.time);
    if (t !== L.time) { $('hud-time').textContent = formatTime(run.time); L.time = t; }

    if (run.tier !== L.tier) { $('hud-tier').textContent = run.palette.tierName; L.tier = run.tier; }

    const sh = Math.round(run.runShards);
    if (sh !== L.shards) { $('hud-shard-n').textContent = sh; L.shards = sh; }

    const hpPct = Math.max(0, p.hp / s.maxHp);
    const hpKey = Math.round(hpPct * 100);
    if (hpKey !== L.hp) {
      const fill = $('hp-fill');
      fill.style.width = (hpPct * 100).toFixed(1) + '%';
      fill.classList.toggle('low', hpPct <= 0.3);
      $('hp-text').textContent = `${Math.max(0, Math.ceil(p.hp))} / ${Math.round(s.maxHp)}`;
      L.hp = hpKey;
    }

    const xpPct = p.xp / p.xpNext;
    const xpKey = Math.round(xpPct * 100);
    if (xpKey !== L.xp) { $('xp-fill').style.width = (xpPct * 100).toFixed(1) + '%'; L.xp = xpKey; }
    if (p.level !== L.level) { $('hud-level').textContent = `LV ${p.level}`; L.level = p.level; }
  }

  resetHudCache() { this._last = {}; }

  // ------------------------------------------------------------ level up

  showUpgrades(choices, level, onPick) {
    $('lvl-n').textContent = level;
    const wrap = $('upgrade-cards');
    wrap.innerHTML = '';
    const color = getComputedStyle(document.documentElement).getPropertyValue('--c').trim() || '#3ee';

    choices.forEach((c) => {
      const card = el('button', 'up-card');
      card.type = 'button';
      card.innerHTML =
        `<div class="up-icon">${shapeSvg(c.def.icon, color)}</div>` +
        `<div class="up-body">` +
        `<div class="up-name">${c.def.name}</div>` +
        `<div class="up-desc">${c.desc}</div>` +
        (c.level === 1 ? '<div class="up-new">NEW AUGMENT</div>' : '') +
        `</div>`;
      card.addEventListener('click', (e) => {
        e.preventDefault();
        audio.uiClick();
        juice.vibrate(12);
        onPick(c);
      });
      wrap.appendChild(card);
    });
    this.show('levelup');
  }

  // ------------------------------------------------------------ pause

  showPause(run) {
    $('pause-stats').innerHTML =
      row('SCORE', Math.round(run.score).toLocaleString()) +
      row('TIME', formatTime(run.time)) +
      row('KILLS', run.kills) +
      row('SHARDS', '◆ ' + Math.round(run.runShards));
    this.show('pause');
    function row(k, v) { return `<div><span class="k">${k}</span><span class="v">${v}</span></div>`; }
  }

  // ------------------------------------------------------------ game over

  /**
   * @param {object} snapshot records captured before this run was written to the save,
   *   so the comparisons aren't measured against a best that already includes this run.
   */
  showGameOver(res, streakResult, snapshot = {}) {
    $('go-mode').textContent = res.isDaily ? `DAILY RUN — ${res.date}` : 'PRACTICE RUN';
    $('go-score').textContent = res.score.toLocaleString();

    // Label the retry button for what it will actually do (see its click handler).
    $('btn-again').textContent =
      (res.isDaily && save.dailyLocked()) ? 'PRACTICE RUN' : 'RUN AGAIN';

    const prevBest = snapshot.priorBest ?? (res.isDaily ? save.data.bestDailyScore : save.data.bestPracticeScore);
    const isBest = res.score > 0 && res.score >= prevBest;
    $('go-title').textContent = isBest ? 'NEW PERSONAL BEST' : 'RUN ENDED';

    const delta = $('go-delta');
    delta.className = 'score-delta';
    if (isBest && prevBest > 0) {
      delta.textContent = `+${(res.score - prevBest).toLocaleString()} OVER YOUR BEST`;
      delta.classList.add('best');
    } else if (prevBest > 0) {
      const d = prevBest - res.score;
      delta.textContent = `${d.toLocaleString()} SHORT OF YOUR BEST (${prevBest.toLocaleString()})`;
      delta.classList.add('down');
    } else {
      delta.textContent = 'FIRST RECORD SET';
      delta.classList.add('up');
    }

    $('go-stats').innerHTML =
      cell('SURVIVED', res.timeStr) +
      cell('KILLS', res.kills.toLocaleString()) +
      cell('LEVEL', res.level) +
      cell('BEST CHAIN', 'x' + res.bestCombo) +
      cell('DEPTH', res.tierName) +
      cell('MUTATOR', res.mutator ? res.mutator.name : 'NONE');

    // Comparisons: personal best, yesterday's daily, today's earlier attempt.
    const cmp = $('go-compare');
    cmp.innerHTML = '';
    const yesterday = save.dailyScore(dayOffsetKey(-1));

    cmp.appendChild(cmpRow('Personal best', prevBest || 0, res.score));
    if (res.isDaily) {
      cmp.appendChild(cmpRow("Yesterday's daily", yesterday ? yesterday.score : null, res.score));
      const bestToday = snapshot.priorToday;
      if (bestToday && bestToday.score !== res.score) {
        cmp.appendChild(cmpRow('Your best today', bestToday.score, res.score));
      }
    }
    cmp.appendChild(cmpRow('Longest survival', save.data.bestTime ? formatTime(save.data.bestTime) : null, null, res.timeStr));

    $('go-shards').textContent = res.shards.toLocaleString();

    // Streak.
    const sNode = $('go-streak');
    sNode.className = 'streak-result';
    if (!res.isDaily) {
      sNode.innerHTML = `<span class="note">Practice runs don’t affect your ${save.data.streak}-day streak. Play the Daily to extend it.</span>`;
    } else if (streakResult?.milestone) {
      sNode.classList.add('gain');
      const m = streakResult.milestone;
      sNode.innerHTML = `<span class="big">${streakResult.streak}-DAY STREAK</span>` +
        `${m.label} reached — <b>◆${m.shards}</b> bonus shards` +
        (m.unlockName ? `<span class="note">Unlocked: ${m.unlockName}</span>` : '');
    } else if (streakResult?.extended) {
      sNode.classList.add('gain');
      const next = MILESTONES.find((m) => m.days > streakResult.streak);
      sNode.innerHTML = `<span class="big">${streakResult.streak}-DAY STREAK</span>` +
        (next ? `<span class="note">${next.days - streakResult.streak} more day${next.days - streakResult.streak > 1 ? 's' : ''} to ◆${next.shards}</span>` : '');
    } else if (streakResult?.reset) {
      sNode.classList.add('lost');
      sNode.innerHTML = `<span class="big">STREAK RESET</span>You missed a day, so it’s back to 1.` +
        `<span class="note">Streaks only survive if you play every day.</span>`;
    } else {
      sNode.innerHTML = `<span class="big">${save.data.streak}-DAY STREAK</span>` +
        `<span class="note">Already counted today. Return tomorrow to extend it.</span>`;
    }

    // --- characters ---
    const core = coreFor(save.data.equippedWeapon);
    $('go-core-who').textContent = core.name;
    // A milestone outranks dying: the run ended, but the streak is the story.
    $('go-core-line').textContent = voice.player(streakResult?.milestone ? 'milestone' : 'death');
    this.portrait('go-core-face', core)?.resize();

    const rivalBlock = $('go-rival');
    if (res.isDaily) {
      rivalBlock.classList.remove('hidden');
      // The rival's line responds to the streak first, then to the run itself.
      let line;
      if (streakResult?.milestone) line = voice.rivalMilestone(streakResult.milestone.days);
      else if (streakResult?.reset) line = voice.rival('streakBroken');
      else line = voice.rivalVerdict(res.score, prevBest, res.time);
      $('go-rival-line').textContent = line;
      this.portrait('go-rival-face', RIVAL)?.resize();
    } else {
      rivalBlock.classList.add('hidden');
    }

    this.show('gameover');

    function cell(k, v) { return `<div><span class="k">${k}</span><span class="v">${v}</span></div>`; }
    function cmpRow(label, prev, now, nowStr) {
      const n = el('div', 'compare-row');
      if (prev == null) {
        n.innerHTML = `<span class="k">${label}</span><span class="v">—</span>`;
        return n;
      }
      if (nowStr != null) {
        n.innerHTML = `<span class="k">${label}</span><span class="v">${prev}</span>`;
        return n;
      }
      const win = now >= prev;
      n.className = 'compare-row ' + (win ? 'win' : 'lose');
      const diff = now - prev;
      n.innerHTML = `<span class="k">${label}</span><span class="v">${prev.toLocaleString()} ` +
        `<small>(${diff >= 0 ? '+' : ''}${diff.toLocaleString()})</small></span>`;
      return n;
    }
  }

  // ------------------------------------------------------------ shop

  buildShop() {
    $('shop-shards').textContent = save.data.shards.toLocaleString();
    const list = $('shop-list');
    list.innerHTML = '';

    const groups = {};
    for (const item of SHOP) (groups[item.cat] ||= []).push(item);

    // Streak-locked trails appear alongside purchasable ones so the reward is visible.
    for (const id in STREAK_LOCKED) {
      (groups.Trails ||= []).push({ id, cat: 'Trails', name: TRAILS[id].name + ' Trail',
                                    cost: null, streakReq: STREAK_LOCKED[id], desc: 'Streak reward' });
    }
    // Default trail is always owned; list it so the equip toggle makes sense.
    groups.Trails.unshift({ id: 'trail_cyan', cat: 'Trails', name: 'Cyan Trail', cost: 0, desc: 'Standard issue' });
    groups.Weapons.unshift({ id: 'weapon_pulse', cat: 'Weapons', name: CORES.weapon_pulse.name, cost: 0 });

    // Cores and trails are characters and wardrobe, not line items — swap the generic
    // labels for names and personality blurbs.
    for (const item of groups.Weapons) {
      const core = CORES[item.id];
      if (!core) continue;
      item.name = core.name;
      item.desc = `<em>${core.blurb}</em><br>${WEAPONS[item.id].desc}`;
      item.core = core;
    }
    for (const item of groups.Trails) {
      if (TRAIL_BLURBS[item.id]) item.desc = TRAIL_BLURBS[item.id];
    }

    for (const cat of ['Weapons', 'Passives', 'Trails']) {
      const items = groups[cat];
      if (!items) continue;
      const group = el('div', 'shop-group');
      group.appendChild(el('h3', null, cat.toUpperCase()));
      for (const item of items) group.appendChild(this._shopItem(item));
      list.appendChild(group);
    }
  }

  _shopItem(item) {
    const owned = save.has(item.id);
    const isWeapon = item.id.startsWith('weapon_');
    const isTrail = item.id.startsWith('trail_');
    const equipped = (isWeapon && save.data.equippedWeapon === item.id) ||
                     (isTrail && save.data.equippedTrail === item.id);
    const reqMet = !item.req || save.has(item.req);
    const streakLocked = item.streakReq && !owned;

    const node = el('div', 'shop-item' + (equipped ? ' equipped' : owned ? ' owned' : '') +
                            (!reqMet || streakLocked ? ' locked' : ''));

    if (isTrail) {
      const t = TRAILS[item.id];
      const dot = el('div', 'trail-dot');
      dot.style.background = `rgb(${t.rgb.join(',')})`;
      dot.style.boxShadow = `0 0 12px rgb(${t.rgb.join(',')})`;
      node.appendChild(dot);
    }

    if (item.core) {
      // A live portrait beats a swatch: you can see who you're buying.
      const c = el('canvas', 'portrait');
      c.id = 'shop-face-' + item.id;
      c.width = c.height = 72;
      node.appendChild(c);
      const p = new Portrait(c, item.core);
      p.resize();
      p.update(Math.random() * 3);
      p.draw();
    }

    const info = el('div', 'shop-info');
    info.innerHTML = `<div class="shop-name">${item.name}</div>` +
                     (item.core ? `<div class="core-line"><span class="core-tag">${item.core.role.toUpperCase()}</span></div>` : '') +
                     `<div class="shop-desc">${item.desc}</div>`;
    node.appendChild(info);

    let action;
    if (streakLocked) {
      action = el('div', 'shop-action locked-tag', item.streakReq.toUpperCase());
    } else if (equipped) {
      action = el('div', 'shop-action equipped-tag', 'EQUIPPED');
    } else if (owned) {
      if (isWeapon || isTrail) {
        action = el('button', 'shop-action', 'EQUIP');
        action.addEventListener('click', () => {
          if (isWeapon) save.data.equippedWeapon = item.id;
          else save.data.equippedTrail = item.id;
          save.saveNow();
          audio.uiClick(); juice.vibrate(10);
          this.buildShop();
        });
      } else {
        action = el('div', 'shop-action equipped-tag', 'OWNED');
      }
    } else if (!reqMet) {
      const prev = SHOP.find((s) => s.id === item.req);
      action = el('div', 'shop-action locked-tag', `NEEDS ${prev ? prev.name.toUpperCase() : '—'}`);
    } else {
      const afford = save.data.shards >= item.cost;
      action = el('button', 'shop-action buy' + (afford ? '' : ' cant'), `◆ ${item.cost.toLocaleString()}`);
      action.addEventListener('click', () => {
        if (!save.spendShards(item.cost)) { this.toast('Not enough shards.'); audio.uiBack(); return; }
        save.unlock(item.id);
        if (item.id.startsWith('weapon_')) save.data.equippedWeapon = item.id;
        if (item.id.startsWith('trail_')) save.data.equippedTrail = item.id;
        save.saveNow();
        audio.milestone();
        juice.vibrate([0, 20, 40, 20]);
        this.toast(`${item.name} unlocked.`);
        this.buildShop();
      });
    }
    node.appendChild(action);
    return node;
  }

  // ------------------------------------------------------------ settings

  buildSettings() {
    const list = $('settings-list');
    list.innerHTML = '';
    const s = save.data.settings;
    const g = this.game;

    const addToggle = (label, sub, key, onChange) => {
      const row = el('div', 'setting');
      row.innerHTML = `<div><div class="setting-label">${label}</div><div class="setting-sub">${sub}</div></div>`;
      const sw = el('div', 'switch' + (s[key] ? ' on' : ''));
      sw.setAttribute('role', 'switch');
      sw.setAttribute('tabindex', '0');
      sw.setAttribute('aria-checked', String(!!s[key]));
      sw.setAttribute('aria-label', label);
      const flip = () => {
        s[key] = !s[key];
        sw.classList.toggle('on', s[key]);
        sw.setAttribute('aria-checked', String(s[key]));
        save.save();
        audio.uiClick();
        juice.vibrate(8);
        onChange?.(s[key]);
      };
      sw.addEventListener('click', flip);
      sw.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
      const ctl = el('div', 'setting-ctl'); ctl.appendChild(sw);
      row.appendChild(ctl);
      list.appendChild(row);
    };

    const addSlider = (label, sub, key, min, max, step, onChange) => {
      const row = el('div', 'setting');
      row.innerHTML = `<div><div class="setting-label">${label}</div><div class="setting-sub">${sub}</div></div>`;
      const input = el('input');
      input.type = 'range'; input.min = min; input.max = max; input.step = step;
      input.value = s[key];
      input.setAttribute('aria-label', label);
      input.addEventListener('input', () => {
        s[key] = parseFloat(input.value);
        save.save();
        onChange?.(s[key]);
      });
      const ctl = el('div', 'setting-ctl'); ctl.appendChild(input);
      row.appendChild(ctl);
      list.appendChild(row);
    };

    const addSeg = (label, sub, key, options, onChange) => {
      const row = el('div', 'setting');
      row.innerHTML = `<div><div class="setting-label">${label}</div><div class="setting-sub">${sub}</div></div>`;
      const seg = el('div', 'seg');
      options.forEach(([val, text]) => {
        const b = el('button', s[key] === val ? 'on' : '', text);
        b.addEventListener('click', () => {
          s[key] = val;
          save.save();
          audio.uiClick();
          [...seg.children].forEach((c) => c.classList.remove('on'));
          b.classList.add('on');
          onChange?.(val);
        });
        seg.appendChild(b);
      });
      const ctl = el('div', 'setting-ctl'); ctl.appendChild(seg);
      row.appendChild(ctl);
      list.appendChild(row);
    };

    addToggle('Mute all audio', 'Silences music and effects.', 'muted', (v) => audio.setMuted(v));
    addSlider('Music volume', 'Adaptive layers scale with danger.', 'musicVolume', 0, 1, 0.05, (v) => audio.setMusicVolume(v));
    addSlider('Effects volume', 'Weapons, impacts, pickups.', 'sfxVolume', 0, 1, 0.05, (v) => audio.setSfxVolume(v));
    addSlider('Screen shake', 'Set to zero if motion bothers you.', 'screenShake', 0, 1.5, 0.1, (v) => { juice.shakeScale = v; });
    addToggle('Haptics', 'Vibration on impacts, where supported.', 'haptics', (v) => { juice.haptics = v; });
    addToggle('Colourblind palette', 'Blue/orange only. Shapes still carry threat information.', 'colorblind', (v) => g.setColorblind(v));
    addToggle('Left-handed', 'Puts the movement stick on the right.', 'leftHanded', (v) => g.input.setOptions({ leftHanded: v }));
    addToggle('Auto-fire', 'Off means you fire only while touching the right side.', 'autoFire');
    addSeg('Quality', 'Lower this if the frame rate dips.', 'quality',
           [['auto', 'AUTO'], ['high', 'HIGH'], ['low', 'LOW']], (v) => g.setQuality(v));

    const b = $('btn-reset');
    if (b) b.textContent = 'ERASE ALL PROGRESS';
    this._resetArmed = false;
  }

  // ------------------------------------------------------------ records

  buildRecords() {
    const d = save.data;
    $('records-grid').innerHTML =
      cell('BEST DAILY', d.bestDailyScore.toLocaleString()) +
      cell('BEST PRACTICE', d.bestPracticeScore.toLocaleString()) +
      cell('LONGEST RUN', formatTime(d.bestTime)) +
      cell('CURRENT STREAK', d.streak) +
      cell('BEST STREAK', d.bestStreak) +
      cell('TOTAL RUNS', d.totalRuns.toLocaleString()) +
      cell('TOTAL KILLS', d.totalKills.toLocaleString()) +
      cell('SHARDS EARNED', '◆ ' + d.totalShardsEarned.toLocaleString());

    const hist = $('daily-history');
    hist.innerHTML = '';
    const keys = Object.keys(d.dailyScores).sort().reverse().slice(0, 30);
    if (!keys.length) {
      hist.appendChild(el('div', 'empty', 'No daily runs recorded yet.'));
      return;
    }
    for (const k of keys) {
      const r = d.dailyScores[k];
      const mut = mutatorFor(k);
      const row = el('div', 'hist-row');
      row.innerHTML =
        `<div><div class="hist-date">${k}</div><div class="hist-mut">${mut.name}</div></div>` +
        `<div style="text-align:right"><div class="hist-score">${r.score.toLocaleString()}</div>` +
        `<div class="hist-date">${formatTime(r.time)} · ${r.kills} kills</div></div>`;
      hist.appendChild(row);
    }
    function cell(k, v) { return `<div><span class="k">${k}</span><span class="v">${v}</span></div>`; }
  }
}

export { MUTATORS };

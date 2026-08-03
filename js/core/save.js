// Persistent save. localStorage, not IndexedDB: the whole payload is a couple of KB of
// scalars, and synchronous reads mean no async dance on boot.

import { todayKey, daysBetween } from './rng.js';

const KEY = 'pulsegrid.save.v1';

const DEFAULTS = {
  version: 1,
  shards: 0,
  totalShardsEarned: 0,

  // Streak
  streak: 0,
  bestStreak: 0,
  lastDailyDate: null,     // YYYY-MM-DD of the last completed daily
  claimedMilestones: [],   // e.g. [3, 7]

  // Daily history: { 'YYYY-MM-DD': { score, wave, time, kills } }
  dailyScores: {},
  bestDailyScore: 0,
  bestPracticeScore: 0,
  bestTime: 0,
  totalRuns: 0,
  totalKills: 0,

  // Meta unlocks
  unlocked: ['weapon_pulse', 'trail_cyan'],
  equippedWeapon: 'weapon_pulse',
  equippedTrail: 'trail_cyan',

  settings: {
    muted: false,
    sfxVolume: 0.85,
    musicVolume: 0.55,
    haptics: true,
    screenShake: 1,
    colorblind: false,
    quality: 'auto',       // auto | high | low
    leftHanded: false,
    autoFire: true,
  },

  seenTutorial: false,
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(patch)) {
    const bv = base[k], pv = patch[k];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && pv && typeof pv === 'object' && !Array.isArray(pv)) {
      out[k] = deepMerge(bv, pv);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out;
}

class SaveStore {
  constructor() {
    this.data = this.load();
    this._writeTimer = 0;
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULTS);
      const parsed = JSON.parse(raw);
      // Merge over defaults so new fields added in later versions appear on old saves.
      return deepMerge(DEFAULTS, parsed);
    } catch (e) {
      console.warn('[pulsegrid] save unreadable, starting fresh', e);
      return structuredClone(DEFAULTS);
    }
  }

  /** Debounced — called from settings toggles that can fire rapidly (sliders). */
  save() {
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => this.saveNow(), 250);
  }

  saveNow() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (e) {
      console.warn('[pulsegrid] save failed (private mode / quota?)', e);
    }
  }

  reset() {
    this.data = structuredClone(DEFAULTS);
    this.saveNow();
  }

  // ------------------------------------------------------------ shards

  addShards(n) {
    this.data.shards += n;
    this.data.totalShardsEarned += n;
    this.save();
  }

  spendShards(n) {
    if (this.data.shards < n) return false;
    this.data.shards -= n;
    this.save();
    return true;
  }

  has(id) { return this.data.unlocked.includes(id); }

  unlock(id) {
    if (!this.has(id)) {
      this.data.unlocked.push(id);
      this.save();
    }
  }

  // ------------------------------------------------------------ streak

  /**
   * Streak state without mutating anything — for showing "play today to keep your streak".
   * @returns {{ streak: number, playedToday: boolean, atRisk: boolean, broken: boolean }}
   */
  streakStatus(today = todayKey()) {
    const last = this.data.lastDailyDate;
    if (!last) return { streak: 0, playedToday: false, atRisk: false, broken: false };
    const gap = daysBetween(last, today);
    return {
      streak: gap <= 1 ? this.data.streak : 0,
      playedToday: gap === 0,
      atRisk: gap === 1,          // played yesterday, today still open
      broken: gap > 1 && this.data.streak > 0,
    };
  }

  /**
   * Commit a completed daily run. Missing a day resets to 1 — no grace period, no
   * streak freeze. The brief asked for that to be honest, and a streak you can't
   * actually lose isn't a streak.
   * @returns {{ streak: number, extended: boolean, reset: boolean, milestone: number|null }}
   */
  commitDaily(today = todayKey()) {
    const last = this.data.lastDailyDate;
    let extended = false, reset = false;

    if (last === today) {
      // Replaying today's daily doesn't double-count.
      return { streak: this.data.streak, extended: false, reset: false, milestone: null };
    }
    if (last && daysBetween(last, today) === 1) {
      this.data.streak += 1;
      extended = true;
    } else {
      reset = last != null && this.data.streak > 1;
      this.data.streak = 1;
    }
    this.data.lastDailyDate = today;
    this.data.bestStreak = Math.max(this.data.bestStreak, this.data.streak);

    const milestone = MILESTONES.find(
      (m) => m.days === this.data.streak && !this.data.claimedMilestones.includes(m.days)
    );
    if (milestone) {
      this.data.claimedMilestones.push(milestone.days);
      this.data.shards += milestone.shards;
      this.data.totalShardsEarned += milestone.shards;
      if (milestone.unlock) this.unlock(milestone.unlock);
    }

    this.saveNow();
    return { streak: this.data.streak, extended, reset, milestone: milestone || null };
  }

  recordRun({ isDaily, date, score, wave, time, kills, shards }) {
    const d = this.data;
    d.totalRuns++;
    d.totalKills += kills;
    d.bestTime = Math.max(d.bestTime, time);
    if (isDaily) {
      const prev = d.dailyScores[date];
      if (!prev || score > prev.score) d.dailyScores[date] = { score, wave, time, kills };
      d.bestDailyScore = Math.max(d.bestDailyScore, score);
      // Keep history bounded; 60 days is plenty for the compare-to-yesterday screen.
      const keys = Object.keys(d.dailyScores).sort();
      while (keys.length > 60) delete d.dailyScores[keys.shift()];
    } else {
      d.bestPracticeScore = Math.max(d.bestPracticeScore, score);
    }
    d.shards += shards;
    d.totalShardsEarned += shards;
    this.saveNow();
  }

  bestScore() { return Math.max(this.data.bestDailyScore, this.data.bestPracticeScore); }
  dailyScore(dateKey) { return this.data.dailyScores[dateKey] || null; }
}

export const MILESTONES = [
  { days: 3,  shards: 150,  label: '3-day streak',  unlock: 'trail_ember',  unlockName: 'Ember Trail' },
  { days: 7,  shards: 400,  label: '7-day streak',  unlock: 'trail_prism',  unlockName: 'Prism Trail' },
  { days: 14, shards: 900,  label: '14-day streak', unlock: 'weapon_lance', unlockName: 'Lance (free)' },
  { days: 30, shards: 2500, label: '30-day streak', unlock: 'trail_void',   unlockName: 'Void Trail' },
];

export const save = new SaveStore();

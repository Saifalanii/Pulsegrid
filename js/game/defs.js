// All tunable game data in one place.
//
// Numbers here are judgment calls, tuned by playing. The shape of the difficulty curve
// matters more than any individual value: a run should be comfortable for ~45s, tense
// by 2:00, and genuinely lethal past 4:00, landing most runs in the 3-6 minute window.

// ---------------------------------------------------------------- enemies
//
// `shape` maps to a polygon side count; 0 means circle/ring. Silhouette is the primary
// threat read — colour is secondary, so the game stays legible for colourblind players
// and under heavy bloom.

export const ENEMIES = {
  drifter: {
    name: 'Drifter', shape: 3, r: 13, hp: 11, speed: 62, dmg: 8,
    xp: 1, score: 10, behavior: 'chase', spin: 1.2, weight: 100, minTime: 0,
  },
  weaver: {
    name: 'Weaver', shape: 3, r: 12, hp: 15, speed: 118, dmg: 9,
    xp: 2, score: 18, behavior: 'weave', spin: 3.0, weight: 55, minTime: 25,
  },
  sprinter: {
    name: 'Sprinter', shape: 3, r: 11, hp: 9, speed: 78, dmg: 12,
    xp: 2, score: 22, behavior: 'charge', spin: 5.0, weight: 45, minTime: 45,
    chargeSpeed: 430, windup: 0.55, chargeTime: 0.85, restTime: 0.9,
  },
  splitter: {
    name: 'Splitter', shape: 5, r: 20, hp: 30, speed: 56, dmg: 11,
    xp: 3, score: 34, behavior: 'chase', spin: -1.0, weight: 38, minTime: 60,
    splitInto: 'shardling', splitCount: 3,
  },
  shardling: {
    name: 'Shardling', shape: 4, r: 9, hp: 6, speed: 142, dmg: 6,
    xp: 1, score: 8, behavior: 'chase', spin: 6.0, weight: 0, minTime: 0, // spawned only
  },
  orbiter: {
    name: 'Orbiter', shape: 0, r: 16, hp: 26, speed: 96, dmg: 10,
    xp: 3, score: 30, behavior: 'orbit', spin: 2.0, weight: 34, minTime: 80,
    orbitRadius: 220, shootEvery: 2.1, bulletSpeed: 190, bulletDmg: 10,
  },
  bulwark: {
    name: 'Bulwark', shape: 6, r: 27, hp: 78, speed: 42, dmg: 17,
    xp: 5, score: 55, behavior: 'chase', spin: -0.7, weight: 30, minTime: 100,
    armor: 2,
  },
  lancer: {
    name: 'Lancer', shape: 8, r: 21, hp: 46, speed: 26, dmg: 13,
    xp: 4, score: 44, behavior: 'standoff', spin: 1.4, weight: 26, minTime: 130,
    standoffRange: 330, shootEvery: 1.55, burst: 3, bulletSpeed: 260, bulletDmg: 11,
  },
  warden: {
    name: 'Warden', shape: 6, r: 44, hp: 620, speed: 46, dmg: 24,
    xp: 40, score: 600, behavior: 'chase', spin: 0.55, weight: 0, minTime: 0,
    elite: true, shootEvery: 2.6, radialCount: 12, bulletSpeed: 175, bulletDmg: 14,
    summon: 'drifter', summonCount: 4, summonEvery: 6.5,
  },
};

/** Elites arrive on a timer, not a wave counter, so the pressure is predictable. */
export const ELITE_TIMES = [95, 190, 285, 375, 460, 540];

// ---------------------------------------------------------------- weapons

export const WEAPONS = {
  weapon_pulse: {
    name: 'Pulse', desc: 'Balanced rapid-fire. Reliable at every range.',
    cost: 0, dmg: 10, rate: 5.4, speed: 640, count: 1, spread: 0.05,
    size: 5, pierce: 0, range: 560,
  },
  weapon_scatter: {
    name: 'Scatter', desc: 'Three-shot cone. Shreds crowds, weak at distance.',
    cost: 650, dmg: 6.5, rate: 3.3, speed: 540, count: 3, spread: 0.38,
    size: 4.4, pierce: 0, range: 400,
  },
  weapon_lance: {
    name: 'Lance', desc: 'Slow piercing spear. Punches through whole lines.',
    cost: 1300, dmg: 27, rate: 1.85, speed: 950, count: 1, spread: 0.01,
    size: 7, pierce: 2, range: 780,
  },
};

// ------------------------------------------------------- in-run upgrades
//
// Offered three at a time on level-up. `weight` biases the draw; `max` caps stacking so
// no single stat runs away and flattens the build.

export const UPGRADES = [
  { id: 'power',   name: 'Overcharge',   max: 6, weight: 100, icon: 3,
    desc: (l) => `+22% damage  (${l}/6)`,
    apply: (s) => { s.dmgMul *= 1.22; } },

  { id: 'rapid',   name: 'Rapid Cycle',  max: 6, weight: 100, icon: 4,
    desc: (l) => `+18% fire rate  (${l}/6)`,
    apply: (s) => { s.rateMul *= 1.18; } },

  { id: 'multi',   name: 'Split Barrel', max: 3, weight: 55, icon: 5,
    desc: (l) => `+1 projectile  (${l}/3)`,
    apply: (s) => { s.count += 1; s.spread = Math.max(s.spread, 0.16); s.dmgMul *= 0.93; } },

  { id: 'pierce',  name: 'Penetrator',   max: 3, weight: 60, icon: 6,
    desc: (l) => `Shots pierce +1 enemy  (${l}/3)`,
    apply: (s) => { s.pierce += 1; } },

  { id: 'velocity',name: 'Railgun',      max: 3, weight: 65, icon: 4,
    desc: (l) => `+28% shot speed & range  (${l}/3)`,
    apply: (s) => { s.speedMul *= 1.28; s.rangeMul *= 1.2; } },

  { id: 'swift',   name: 'Thrusters',    max: 5, weight: 85, icon: 3,
    desc: (l) => `+11% move speed  (${l}/5)`,
    apply: (s) => { s.moveMul *= 1.11; } },

  { id: 'vitality',name: 'Reinforce',    max: 5, weight: 80, icon: 6,
    desc: (l) => `+22 max integrity, heal 22  (${l}/5)`,
    apply: (s, p) => { s.maxHp += 22; p.hp = Math.min(s.maxHp, p.hp + 22); } },

  { id: 'magnet',  name: 'Attractor',    max: 3, weight: 60, icon: 0,
    desc: (l) => `+55% pickup radius  (${l}/3)`,
    apply: (s) => { s.magnet *= 1.55; } },

  { id: 'orbit',   name: 'Aegis Shards', max: 4, weight: 55, icon: 5,
    desc: (l) => `+1 orbiting shard that damages on contact  (${l}/4)`,
    apply: (s) => { s.orbitals += 1; } },

  { id: 'crit',    name: 'Fracture',     max: 4, weight: 60, icon: 3,
    desc: (l) => `+9% critical chance (2.2x damage)  (${l}/4)`,
    apply: (s) => { s.crit += 0.09; } },

  { id: 'homing',  name: 'Seeker Coil',  max: 2, weight: 45, icon: 0,
    desc: (l) => `Shots curve toward enemies  (${l}/2)`,
    apply: (s) => { s.homing += 2.6; } },

  { id: 'dashmaster', name: 'Phase Drive', max: 2, weight: 45, icon: 4,
    desc: (l) => (l === 1 ? '-28% dash cooldown' : '+1 dash charge'),
    apply: (s, p, lvl) => { if (lvl === 1) s.dashCd *= 0.72; else s.dashCharges += 1; } },

  { id: 'thorns',  name: 'Backlash',     max: 2, weight: 40, icon: 6,
    desc: (l) => `Detonate a shockwave when hit  (${l}/2)`,
    apply: (s) => { s.thorns += 1; } },

  { id: 'regen',   name: 'Reknit',       max: 3, weight: 50, icon: 6,
    desc: (l) => `Regenerate 1 integrity every 2.6s  (${l}/3)`,
    apply: (s) => { s.regen += 1 / 2.6; } },

  { id: 'greed',   name: 'Prospector',   max: 3, weight: 55, icon: 5,
    desc: (l) => `+30% shard drops  (${l}/3)`,
    apply: (s) => { s.shardMul *= 1.3; } },

  { id: 'bigshot', name: 'Heavy Slug',   max: 3, weight: 55, icon: 0,
    desc: (l) => `+32% projectile size, +12% damage  (${l}/3)`,
    apply: (s) => { s.sizeMul *= 1.32; s.dmgMul *= 1.12; } },

  { id: 'shield',  name: 'Null Field',   max: 2, weight: 42, icon: 0,
    desc: (l) => `Barrier absorbs 1 hit, recharges in ${l === 1 ? 14 : 9}s`,
    apply: (s, p, lvl) => { s.shieldMax = 1; s.shieldRecharge = lvl === 1 ? 14 : 9; } },

  { id: 'nova',    name: 'Deathbloom',   max: 2, weight: 38, icon: 5,
    desc: (l) => `Slain enemies erupt, damaging nearby foes  (${l}/2)`,
    apply: (s) => { s.nova += 1; } },
];

// ---------------------------------------------------------------- meta shop
//
// Permanent, shard-bought. Deliberately modest multipliers: meta progression should
// shorten the ramp, not trivialise the run — otherwise the daily stops being a fair
// comparison between players.

export const SHOP = [
  // Weapons
  { id: 'weapon_scatter', cat: 'Weapons', name: 'Scatter', cost: 650,
    desc: WEAPONS.weapon_scatter.desc },
  { id: 'weapon_lance', cat: 'Weapons', name: 'Lance', cost: 1300,
    desc: WEAPONS.weapon_lance.desc },

  // Passives (tiered — each requires the previous)
  { id: 'hp_1', cat: 'Passives', name: 'Plating I',   cost: 250,  desc: '+15 starting integrity' },
  { id: 'hp_2', cat: 'Passives', name: 'Plating II',  cost: 550,  desc: '+15 more integrity', req: 'hp_1' },
  { id: 'hp_3', cat: 'Passives', name: 'Plating III', cost: 1000, desc: '+20 more integrity', req: 'hp_2' },

  { id: 'dmg_1', cat: 'Passives', name: 'Focus I',   cost: 300,  desc: '+6% damage' },
  { id: 'dmg_2', cat: 'Passives', name: 'Focus II',  cost: 700,  desc: '+6% more damage', req: 'dmg_1' },
  { id: 'dmg_3', cat: 'Passives', name: 'Focus III', cost: 1300, desc: '+8% more damage', req: 'dmg_2' },

  { id: 'spd_1', cat: 'Passives', name: 'Impulse I',  cost: 280, desc: '+5% move speed' },
  { id: 'spd_2', cat: 'Passives', name: 'Impulse II', cost: 650, desc: '+5% more move speed', req: 'spd_1' },

  { id: 'xp_1', cat: 'Passives', name: 'Insight I',  cost: 320, desc: '+12% experience gain' },
  { id: 'xp_2', cat: 'Passives', name: 'Insight II', cost: 750, desc: '+12% more experience', req: 'xp_1' },

  { id: 'shard_1', cat: 'Passives', name: 'Avarice I',   cost: 220, desc: '+15% shards earned' },
  { id: 'shard_2', cat: 'Passives', name: 'Avarice II',  cost: 500, desc: '+15% more shards', req: 'shard_1' },
  { id: 'shard_3', cat: 'Passives', name: 'Avarice III', cost: 950, desc: '+20% more shards', req: 'shard_2' },

  { id: 'magnet_start', cat: 'Passives', name: 'Lodestone', cost: 400, desc: '+60% starting pickup radius' },
  { id: 'dash_charge',  cat: 'Passives', name: 'Twin Phase', cost: 900, desc: '+1 dash charge' },
  { id: 'revive',       cat: 'Passives', name: 'Second Core', cost: 2200,
    desc: 'Once per run, return at 45% integrity' },

  // Cosmetics
  { id: 'trail_toxic', cat: 'Trails', name: 'Toxic Trail', cost: 400, desc: 'Acid-green wake' },
  { id: 'trail_rose',  cat: 'Trails', name: 'Rose Trail',  cost: 400, desc: 'Hot-pink wake' },
];

/** Streak-only unlocks, shown greyed in the shop so the reward is visible early. */
export const STREAK_LOCKED = {
  trail_ember: '3-day streak',
  trail_prism: '7-day streak',
  trail_void: '30-day streak',
};

// ------------------------------------------------------- derived meta stats

export function metaStats(save) {
  const has = (id) => save.data.unlocked.includes(id);
  let hp = 0, dmg = 1, spd = 1, xp = 1, shard = 1, magnet = 1, dashCharges = 0;
  if (has('hp_1')) hp += 15;
  if (has('hp_2')) hp += 15;
  if (has('hp_3')) hp += 20;
  if (has('dmg_1')) dmg *= 1.06;
  if (has('dmg_2')) dmg *= 1.06;
  if (has('dmg_3')) dmg *= 1.08;
  if (has('spd_1')) spd *= 1.05;
  if (has('spd_2')) spd *= 1.05;
  if (has('xp_1')) xp *= 1.12;
  if (has('xp_2')) xp *= 1.12;
  if (has('shard_1')) shard *= 1.15;
  if (has('shard_2')) shard *= 1.15;
  if (has('shard_3')) shard *= 1.20;
  if (has('magnet_start')) magnet *= 1.6;
  if (has('dash_charge')) dashCharges += 1;
  return { hp, dmg, spd, xp, shard, magnet, dashCharges, revive: has('revive') };
}

/** XP needed to go from level n to n+1. Superlinear so late levels feel earned. */
export const xpForLevel = (n) => Math.floor(5 + n * 4 + Math.pow(n, 1.72) * 1.6);

// Daily Run: one deterministic seeded run per calendar day, shared by everyone.
//
// Determinism contract — everything the director does must come from the run's Rng, in a
// fixed order, and nothing may consume from that stream based on player input. Spawn
// positions, enemy type choices, elite timing and mutator all draw from it; particle
// jitter and cosmetic randomness use Math.random so they can't desync the run.

import { Rng, todayKey, dayOffsetKey } from '../core/rng.js';

export const MUTATORS = [
  {
    id: 'overclock', name: 'OVERCLOCK',
    desc: 'Enemies move 50% faster. All score x2.',
    apply: (m) => { m.enemySpeed *= 1.5; m.scoreMul *= 2; },
  },
  {
    id: 'swarm', name: 'SWARM',
    desc: 'Double spawn rate, enemies have 35% less integrity. Shards x1.5.',
    apply: (m) => { m.spawnRate *= 2; m.enemyHp *= 0.65; m.shardMul *= 1.5; },
  },
  {
    id: 'brittle', name: 'BRITTLE',
    desc: 'No healing drops. Triple shards. Score x1.6.',
    apply: (m) => { m.noHealing = true; m.shardMul *= 3; m.scoreMul *= 1.6; },
  },
  {
    id: 'bulwark', name: 'IRONCLAD',
    desc: 'Enemies have +80% integrity but move 25% slower. Score x1.8.',
    apply: (m) => { m.enemyHp *= 1.8; m.enemySpeed *= 0.75; m.scoreMul *= 1.8; },
  },
  {
    id: 'glass', name: 'GLASS CANNON',
    desc: 'You deal double damage but start at 40% integrity. Score x2.2.',
    apply: (m) => { m.playerDmg *= 2; m.startHpMul = 0.4; m.scoreMul *= 2.2; },
  },
  {
    id: 'rush', name: 'RUSH HOUR',
    desc: 'Everything is 30% faster — you included. Score x1.9.',
    apply: (m) => { m.enemySpeed *= 1.3; m.playerSpeed *= 1.3; m.spawnRate *= 1.25; m.scoreMul *= 1.9; },
  },
  {
    id: 'famine', name: 'FAMINE',
    desc: 'Experience drops halved, but every level grants two upgrades. Score x2.',
    apply: (m) => { m.xpMul *= 0.5; m.doubleUpgrade = true; m.scoreMul *= 2; },
  },
  {
    id: 'gauntlet', name: 'GAUNTLET',
    desc: 'Elites arrive twice as often. Shards x2, score x2.4.',
    apply: (m) => { m.eliteRate *= 2; m.shardMul *= 2; m.scoreMul *= 2.4; },
  },
  {
    id: 'shrouded', name: 'SHROUDED',
    desc: 'The arena is smaller and tighter. Nowhere to run. Score x1.7.',
    apply: (m) => { m.arenaScale = 0.68; m.scoreMul *= 1.7; },
  },
  {
    id: 'volatile', name: 'VOLATILE',
    desc: 'Every slain enemy detonates. So does every mistake. Score x1.8.',
    apply: (m) => { m.forceNova = 2; m.enemyDmg *= 1.35; m.scoreMul *= 1.8; },
  },
];

export function defaultModifiers() {
  return {
    enemySpeed: 1, enemyHp: 1, enemyDmg: 1,
    spawnRate: 1, eliteRate: 1,
    playerDmg: 1, playerSpeed: 1, startHpMul: 1,
    xpMul: 1, shardMul: 1, scoreMul: 1,
    arenaScale: 1,
    noHealing: false, doubleUpgrade: false, forceNova: 0,
  };
}

/**
 * Build a run config.
 * @param {'daily'|'practice'} mode
 * @param {string} [dateKey] only used for daily
 */
export function makeRunConfig(mode, dateKey = todayKey()) {
  const isDaily = mode === 'daily';
  // The `pulsegrid-v1|` prefix namespaces the seed, so if the generator is ever
  // rebalanced the seed space can be bumped without colliding with old history.
  const seedStr = isDaily ? `pulsegrid-v1|${dateKey}` : `practice|${Date.now()}|${Math.random()}`;
  const rng = Rng.fromString(seedStr);

  const mods = defaultModifiers();
  let mutator = null;
  if (isDaily) {
    // Draw the mutator first so it's a stable function of the date alone.
    mutator = MUTATORS[Math.floor(rng.next() * MUTATORS.length)];
    mutator.apply(mods);
  }

  return { mode, isDaily, dateKey: isDaily ? dateKey : null, seed: rng.seed, rng, mods, mutator };
}

/** Preview the mutator for a date without building a full run (menu display). */
export function mutatorFor(dateKey) {
  const rng = Rng.fromString(`pulsegrid-v1|${dateKey}`);
  return MUTATORS[Math.floor(rng.next() * MUTATORS.length)];
}

export const yesterdayKey = () => dayOffsetKey(-1);

/** ms until local midnight — drives the "next daily in ..." countdown. */
export function msUntilTomorrow() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  return next - now;
}

export function formatCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

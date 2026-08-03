// Characters: who you are, who's watching, and why any of it matters.
//
// The three starting weapons were "Pulse / Scatter / Lance" — mechanically distinct but
// nameless. They're now three *cores*, each a character with a face, a temperament and
// its own voice. Equipping a weapon means playing as someone else, which costs nothing
// mechanically and gives the meta-progression something to be about.

// ---------------------------------------------------------------- the cores

export const CORES = {
  weapon_pulse: {
    id: 'weapon_pulse',
    name: 'NIM',
    role: 'Pulse Core',
    blurb: 'Fires first. Thinks later, if at all.',
    long: 'The smallest thing the Grid ever failed to digest. Relentlessly, exhaustingly optimistic.',
    eyeStyle: 'eager',
    sides: 3,
    rgb: [80, 230, 255],
    pupilRgb: [255, 255, 255],
    spin: 0.5,
  },
  weapon_scatter: {
    id: 'weapon_scatter',
    name: 'BURR',
    role: 'Scatter Core',
    blurb: 'Panics loudly, in every direction at once.',
    long: 'Convinced that any problem can be solved by covering more of it. Frequently correct.',
    eyeStyle: 'jittery',
    sides: 5,
    rgb: [160, 255, 110],
    pupilRgb: [255, 255, 255],
    spin: 1.4,
  },
  weapon_lance: {
    id: 'weapon_lance',
    name: 'QUILL',
    role: 'Lance Core',
    blurb: 'Waits. Then only needs the one shot.',
    long: 'Has never hurried. Considers hurrying a category of mistake.',
    eyeStyle: 'calm',
    sides: 6,
    rgb: [255, 176, 76],
    pupilRgb: [255, 255, 255],
    spin: 0.28,
  },
};

export const coreFor = (weaponId) => CORES[weaponId] || CORES.weapon_pulse;

// ---------------------------------------------------------------- the rival

export const RIVAL = {
  name: 'VANTA',
  role: 'Custodian of the Grid',
  eyeStyle: 'smug',
  sides: 6,
  rgb: [190, 130, 255],
  pupilRgb: [255, 210, 255],
  spin: -0.34,
};

/**
 * One short framing sentence, shown on first launch and from the About screen.
 * The daily loop needs a "why" and this is it: the Grid resets, you don't.
 */
export const STAKES = {
  title: 'WHY ANY OF THIS',
  line: 'The Grid rewrites itself at midnight and forgets everyone who ran it.',
  line2: 'Nim keeps showing up anyway. The streak is the only proof it happened.',
  signoff: '— VANTA finds this hilarious. Prove it wrong.',
};

// ---------------------------------------------------------------- trail flavour
//
// Cosmetics get one line each too, so the shop reads as a wardrobe rather than a table
// of SKUs.

export const TRAIL_BLURBS = {
  trail_cyan:  'Factory standard. Honest work.',
  trail_ember: 'Three days running. You left a mark.',
  trail_prism: 'A week of stubbornness, refracted.',
  trail_void:  'Thirty days. The Grid stopped arguing.',
  trail_toxic: 'Leaves a smell. Nobody has complained yet.',
  trail_rose:  'Purely a flex. Respect it.',
};

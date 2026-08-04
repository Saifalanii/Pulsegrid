// Voice: short reactive lines from the player core and the rival.
//
// Text only — no audio dialogue. Lines are picked with a bag shuffle rather than a plain
// random draw, so you see the whole pool before anything repeats. Random selection on a
// 16-line pool produces a visible repeat roughly every fourth line, which is exactly the
// thing that makes reactive barks feel cheap.
//
// Everything is rate-limited and priority-ranked in the UI layer; this module only
// decides *what* gets said.

// ---------------------------------------------------------------- player lines
//
// Shared across all three cores. Kept under ~10 words, wry rather than informative —
// the HUD already tells you the number, so the line's job is attitude.

const PLAYER = {
  hurt: [
    'Ow. Noted.',
    'That one counted.',
    'Fine. That was fine.',
    'I meant to do that. Obviously.',
    'Rude.',
    'Okay, it has hands.',
    'Filing a complaint with the Grid.',
    'Paint damage only.',
    'Structural. Definitely structural.',
    'I felt that in my geometry.',
    'Still here. Barely a scratch.',
    'That is going to buff out.',
    'Hey! I was using that.',
    'Tell me that was the last one.',
    'Unpleasant. Do it again and see.',
    'I have decided to allow that.',
    'Worth it. Probably.',
    'Bold of it, honestly.',
  ],

  levelUp: [
    'Oh, that is new.',
    'More of me. Excellent.',
    'Upgrade acquired. No notes.',
    'I am becoming a problem.',
    'Getting dangerous over here.',
    'The Grid is going to hate this.',
    'Yes. Give me that.',
    'Sharper. Meaner. Same charm.',
    'Now we are talking.',
    'This changes the arithmetic.',
    'I feel taller. I am not.',
    'Something clicked. Loudly.',
    'Better. Considerably better.',
    'Add it to the pile.',
    'Vanta is not going to like this.',
    'One more and I am unbearable.',
    'Compounding nicely.',
  ],

  nearDeath: [
    'This is fine. This is fine.',
    'Running on spite now.',
    'Do not look at the integrity bar.',
    'One more hit and I am a rumour.',
    'Held together by opinion.',
    'Still counts as alive.',
    'I have been worse. Recently.',
    'Nobody panic. I am panicking.',
    'Structurally: a suggestion.',
    'Almost out. Not out.',
    'Beautiful weather for it.',
    'If I die, delete my search history.',
    'Any moment now would be great.',
    'Down to vibes and momentum.',
    'This is the fun part, apparently.',
    'Do not tell Vanta.',
  ],

  death: [
    'Well. That happened.',
    'Same time tomorrow.',
    'I regret several things.',
    'The Grid wins a round. One.',
    'Put that on my headstone.',
    'Unlucky. Mostly.',
    'I was doing so well.',
    'Tell them I went sideways.',
    'That was survivable. In theory.',
    'Rewind. Oh. Right.',
    'Worth every second.',
    'I want it on record: unfair.',
    'Back tomorrow. Obviously.',
    'Do not laugh. Vanta, do not.',
    'Ran out of arena.',
    'A learning experience. Allegedly.',
  ],

  milestone: [
    'We keep showing up.',
    'That is a streak. A real one.',
    'The Grid noticed. Good.',
    'Consistency. Who knew.',
    'Adding this to my personality.',
    'Say it louder, Vanta.',
    'Every single day. On purpose.',
    'This is the whole point.',
    'Turns out I am reliable.',
    'Streak intact. Ego intact.',
    'The Grid forgets. I did not.',
    'Put this one in the records.',
    'Days stacked like bricks.',
    'Nobody handed me this.',
    'Still here. Still counting.',
    'Momentum is a real thing.',
    'That is discipline, technically.',
  ],

  eliteKill: [
    'Big ones fall the same.',
    'Sat down. Stayed down.',
    'That was the scary one, right?',
    'Warden: retired.',
    'Loud, then quiet. Love it.',
    'Next.',
    'Bring another.',
    'Deleted. Politely.',
  ],

  tierShift: [
    'Deeper. Great. Love that.',
    'New colours. New problems.',
    'Down we go.',
    'The Grid is showing off.',
    'It gets worse from here.',
    'Nice place. Terrible tenants.',
  ],
};

// Per-core signature lines, mixed into the shared pool so each character still sounds
// like themselves without needing three full sets.
const CORE_FLAVOUR = {
  weapon_pulse: {
    hurt: ['I can do this all day. I cannot.'],
    levelUp: ['Faster! Everything faster!'],
    nearDeath: ['Optimism remains high. Integrity does not.'],
    death: ['I had a whole plan.'],
  },
  weapon_scatter: {
    hurt: ['Which one hit me? Any of them?'],
    levelUp: ['MORE directions. All of them.'],
    nearDeath: ['Spreading thin. Literally.'],
    death: ['I covered so much area.'],
  },
  weapon_lance: {
    hurt: ['Miscalculated. Once.'],
    levelUp: ['Efficiency improves.'],
    nearDeath: ['Margins have narrowed.'],
    death: ['Acceptable losses. Mine.'],
  },
};

// ---------------------------------------------------------------- rival lines

const RIVAL = {
  // Shown on the daily brief.
  dailyStart: [
    'Back again. How reliable of you.',
    "Today's arrangement is particularly unkind.",
    'I built this one while thinking about you.',
    'Try to last longer than the music.',
    'Everyone gets the same run. Only you get excuses.',
    'I have already watched you lose this.',
    'Do enjoy. It gets worse in the middle.',
    'Same grid, same rules, same result.',
    'I have set the difficulty to "your fault".',
  ],

  streakBroken: [
    'You missed a day. Back to one.',
    'A whole streak, undone by a Tuesday.',
    'I did not even have to do anything.',
    'Gone. All of it. Sleep well?',
    'The Grid forgets. I do not.',
    'You had momentum. Had.',
    'Zero is such a clean number.',
    'Come back when you mean it.',
  ],

  milestone: {
    3:  ['Three days. Fine. That is something.'],
    7:  ['A week. I am adjusting my estimate of you.'],
    14: ['Fourteen. You are becoming a fixture.'],
    30: ['Thirty days. I concede nothing, but... thirty.'],
  },

  runGood: [
    'That was almost impressive.',
    'Better. Do it again tomorrow.',
    'I felt something. Probably indigestion.',
    'You beat yesterday. Yesterday was weak.',
    'Noted. Grudgingly.',
  ],

  runBad: [
    'The Grid barely woke up for that.',
    'I have seen debris last longer.',
    'Shorter than my attention span.',
    'That was a warm-up, surely.',
    'Try using the dash. It exists.',
  ],

  idle: [
    'The Grid resets at midnight. It always does.',
    'One run a day. That is the arrangement.',
    'I keep the scores. You keep the excuses.',
  ],

  // Announcing a miniboss. Vanta is enjoying this.
  miniboss: [
    'Ah. I was wondering when it would wake up.',
    'This one I built personally. Do try.',
    'It fractures when hurt. That is the fun part.',
    'Mind the segments. Or do not. Your run.',
    'I would step back, if I were capable of caring.',
    'Finally, something worth watching.',
    'It has been waiting all run for you.',
    'Try to make this last more than nine seconds.',
  ],
};

// ---------------------------------------------------------------- bag shuffle

class Bag {
  constructor(items) { this.items = items.slice(); this.queue = []; }
  next() {
    if (!this.items.length) return null;
    if (!this.queue.length) {
      this.queue = this.items.slice();
      // Fisher-Yates on cosmetic text: Math.random is correct here, never a seeded
      // stream — barks must not be able to perturb a Daily Run.
      for (let i = this.queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
      }
      // Avoid the seam where a reshuffle repeats the line that just played.
      if (this.queue.length > 1 && this.queue[this.queue.length - 1] === this._last) {
        this.queue.unshift(this.queue.pop());
      }
    }
    this._last = this.queue.pop();
    return this._last;
  }
}

export class Voice {
  constructor() {
    this.bags = new Map();
    this.coreId = 'weapon_pulse';
    // Tracks which core the player bags were actually built for. This must not be
    // inferred from bags.size — the same Map holds the rival's bags, so any rival line
    // requested first would make the player bags look already-built and they'd never
    // be created at all.
    this._builtCore = null;
  }

  /** Rebuild the player bags for the equipped core (shared pool + its flavour lines). */
  setCore(coreId) {
    if (this._builtCore === coreId) return;
    this.coreId = coreId;
    this._builtCore = coreId;
    for (const key of Object.keys(PLAYER)) {
      const extra = (CORE_FLAVOUR[coreId] && CORE_FLAVOUR[coreId][key]) || [];
      this.bags.set('p:' + key, new Bag(PLAYER[key].concat(extra)));
    }
  }

  _bag(key, items) {
    let b = this.bags.get(key);
    if (!b) { b = new Bag(items); this.bags.set(key, b); }
    return b;
  }

  /** @param {keyof PLAYER} kind */
  player(kind) {
    this.setCore(this.coreId);
    const b = this.bags.get('p:' + kind);
    return b ? b.next() : null;
  }

  rival(kind) {
    const items = RIVAL[kind];
    if (!items || !Array.isArray(items)) return null;
    return this._bag('r:' + kind, items).next();
  }

  rivalMilestone(days) {
    const lines = RIVAL.milestone[days];
    if (lines) return lines[Math.floor(Math.random() * lines.length)];
    return this.rival('milestone3') || 'Still here, then.';
  }

  /** Rival's verdict on a finished run, relative to the player's own history. */
  rivalVerdict(score, prevBest, seconds) {
    if (seconds < 45) return this.rival('runBad');
    if (prevBest > 0 && score >= prevBest) return this.rival('runGood');
    if (prevBest > 0 && score < prevBest * 0.45) return this.rival('runBad');
    return this.rival(score > 0 && seconds > 150 ? 'runGood' : 'runBad');
  }
}

export const voice = new Voice();
export { PLAYER as PLAYER_LINES, RIVAL as RIVAL_LINES };

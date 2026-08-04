// Procedural audio. Raw Web Audio API — no Tone.js, no sample files.
//
// Judgment call: I dropped Tone.js. It's a great library, but it's ~200KB of CDN
// dependency in a game whose whole point is offline-first PWA installability, and
// everything here is short envelopes on primitive oscillators plus one noise buffer.
// Hand-rolling it keeps the service worker cache tiny and the latency floor low.
//
// Graph:
//   [sfx voices] -> sfxBus -> comp -> master -> destination
//   [music voices] -> musicBus -> comp -^

import { clamp } from './math.js';

// Pentatonic minor — hard to make sound wrong, which matters when the sequencer is
// improvising against gameplay intensity rather than a fixed score.
const SCALE = [0, 3, 5, 7, 10];
const ROOT = 55; // A1

// Harmonic movement so the music doesn't sit on one note for an entire run.
// Semitone offsets from ROOT: i - iv - v - bIII-ish. Loops.
const PROGRESSION = [0, -5, -7, -3];
const BARS_PER_CHORD = 4; // how many 16-step bars before the chord moves on

// Bag of bass patterns, picked without immediate repeats — same principle the
// bark system uses, so the groove doesn't loop identically forever either.
const BASS_PATTERNS = [
  [0, -1, 0, 2, -1, 0, 3, -1, 0, -1, 2, -1, 0, 3, 4, -1],
  [0, -1, 2, -1, 0, -1, 3, -1, 0, -1, 2, -1, 4, -1, 0, -1],
  [0, 2, -1, 0, -1, 3, -1, 0, 2, -1, 0, -1, 4, -1, 3, -1],
];

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.unlocked = false;
    this.masterVol = 0.9;
    this.sfxVol = 0.85;
    this.musicVol = 0.55;
    this.muted = false;
    this._noise = null;
    this._intensity = 0;      // 0..1, drives the adaptive layers
    this._targetIntensity = 0;
    this._step = 0;
    this._nextStepTime = 0;
    this._bpm = 82;
    this._playing = false;
    this._lastSfxAt = new Map(); // crude per-sound rate limit
    this._totalBars = 0;
    this._chordIdx = 0;
    this._bassPattern = BASS_PATTERNS[0];
  }

  /** Safe to call repeatedly; only the first user gesture actually resumes. */
  async unlock() {
    // Must be the very first thing this function does — the whole point is to run
    // synchronously inside the same user-gesture call stack that invoked unlock().
    // iOS Safari standalone PWAs have been reported to trust a real <audio>/<video>
    // element's .play() as unlock evidence more reliably than AudioContext.resume()
    // alone; playing this silent clip costs nothing and gives resume() a second,
    // independent path to actually taking effect instead of just one.
    this._playSilentUnlockClip();

    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this._buildGraph();
    }
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* user gesture required; try again later */ }
    }
    this.unlocked = this.ctx.state === 'running';
    this.ready = this.unlocked;

    // iOS Safari quirk: resume() can resolve as "running" before the render thread
    // has actually started producing audio. Gain automation scheduled in the same
    // tick can get silently dropped. A one-sample inaudible blip forces the graph
    // to genuinely start, so volume settings applied right after this actually
    // take effect — instead of needing a manual mute/unmute to "wake" it.
    if (this.unlocked) this._primeOutput();

    this._unlockAttempts = (this._unlockAttempts || 0) + (this.unlocked ? 0 : 1);
    return this.unlocked;
  }

  /**
   * Number of unlock() calls so far that did NOT end in a running AudioContext.
   * main.js uses this to decide when to stop silently retrying and show a manual
   * "tap to enable sound" prompt instead — the fallback the original brief asked for
   * and which a purely silent retry loop never surfaces to the player.
   */
  get failedUnlockAttempts() { return this._unlockAttempts || 0; }

  /** Builds (once) and plays a silent WAV via a real HTMLAudioElement. See unlock(). */
  _playSilentUnlockClip() {
    if (!this._silentEl) {
      // 80 samples of 8-bit unsigned PCM silence (0x80) at 8kHz mono — the smallest
      // WAV that's still unambiguously valid, built at runtime so there's no
      // hand-typed base64 blob to get subtly wrong.
      const samples = 80;
      const buf = new ArrayBuffer(44 + samples);
      const v = new DataView(buf);
      const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      str(0, 'RIFF'); v.setUint32(4, 36 + samples, true); str(8, 'WAVE');
      str(12, 'fmt '); v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
      v.setUint16(32, 1, true); v.setUint16(34, 8, true);
      str(36, 'data'); v.setUint32(40, samples, true);
      for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128);
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      this._silentEl = new Audio(url);
      this._silentEl.loop = false;
      this._silentEl.volume = 0;
      this._silentEl.setAttribute('playsinline', '');
    }
    try {
      this._silentEl.currentTime = 0;
      this._silentEl.play().catch(() => {});
    } catch { /* best-effort; AudioContext path below is the real unlock */ }
  }

  _primeOutput() {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.02);
  }

  _buildGraph() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.masterVol;

    // Gentle limiter so stacked explosions don't clip on phone speakers.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.18;

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxVol;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0; // faded in when music starts

    // Shared reverb-ish send: a short synthesized impulse keeps everything in one room.
    this.verb = ctx.createConvolver();
    this.verb.buffer = this._makeImpulse(1.8, 2.4);
    this.verbGain = ctx.createGain();
    this.verbGain.gain.value = 0.22;

    this.sfxBus.connect(this.comp);
    this.musicBus.connect(this.comp);
    this.sfxBus.connect(this.verb);
    this.musicBus.connect(this.verb);
    this.verb.connect(this.verbGain);
    this.verbGain.connect(this.comp);
    this.comp.connect(this.master);
    this.master.connect(ctx.destination);

    this._noise = this._makeNoise(2.0);
  }

  _makeNoise(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.masterVol, this.ctx.currentTime, 0.02);
  }
  setSfxVolume(v) { this.sfxVol = v; if (this.sfxBus) this.sfxBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
  setMusicVolume(v) {
    this.musicVol = v;
    if (this.musicBus && this._playing) this.musicBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  // ---------------------------------------------------------------- voices

  /** One enveloped oscillator. All SFX below are combinations of this + _noiseHit. */
  _tone({ type = 'sine', freq = 440, toFreq = null, dur = 0.2, gain = 0.3, attack = 0.004,
          delay = 0, bus = null, detune = 0, curve = 'exp' }) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(Math.max(20, freq), t0);
    if (toFreq != null) {
      const target = Math.max(20, toFreq);
      if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(target, t0 + dur);
      else osc.frequency.linearRampToValueAtTime(target, t0 + dur);
    }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(bus || this.sfxBus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** Filtered noise burst — the "air" in every impact. */
  _noiseHit({ dur = 0.12, gain = 0.25, freq = 1200, q = 1.2, type = 'bandpass',
              sweepTo = null, delay = 0, bus = null }) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, t0);
    filt.Q.value = q;
    if (sweepTo != null) filt.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt); filt.connect(g); g.connect(bus || this.sfxBus);
    src.start(t0, Math.random() * 1.0);
    src.stop(t0 + dur + 0.02);
  }

  /** Cheap voice-stealing guard: identical sounds inside `ms` collapse into one. */
  _throttle(key, ms) {
    const now = performance.now();
    const last = this._lastSfxAt.get(key) || 0;
    if (now - last < ms) return true;
    this._lastSfxAt.set(key, now);
    return false;
  }

  // ---------------------------------------------------------------- SFX

  /**
   * Hit-marker style tick. Fires on every shot, several times a second, for minutes —
   * so it's built to disappear into the mix rather than punch through it.
   *
   * The old version swept a triangle 760 -> 300Hz over 85ms at gain 0.12. Two separate
   * problems: the sweep *descends into the low-mids*, which is where ear fatigue and
   * "buzzy/grating" live, and 85ms is long enough that consecutive shots overlap into a
   * continuous tone instead of reading as discrete taps. This is ~38ms, sits up at
   * 2-4kHz where the ear reads "click" rather than "tone", and peaks at roughly a third
   * of the old gain — well under hit() (0.10) and enemyDeath() (0.16), so impacts still
   * clearly outrank the act of firing.
   */
  shoot(pitch = 1) {
    if (this._throttle('shoot', 34)) return;
    // Small per-shot pitch jitter. Without it, a fixed-frequency tick repeating at a
    // steady fire rate fuses into a single droning pitch — the machine-gun-drill effect.
    const j = 0.94 + Math.random() * 0.12;
    const p = pitch * j;

    // Transient: a tight band of noise high in the spectrum. This is the "tk".
    this._noiseHit({ dur: 0.026, gain: 0.05, freq: 3600 * p, sweepTo: 2300 * p, q: 2.4, type: 'bandpass' });
    // Body: a very short high sine so the tick has definite pitch and feels intentional
    // rather than like a burst of static. Kept above ~1.5kHz to stay out of the mud.
    this._tone({ type: 'sine', freq: 2200 * p, toFreq: 1600 * p, dur: 0.038, gain: 0.038, attack: 0.001 });
  }

  hit() {
    if (this._throttle('hit', 26)) return;
    this._noiseHit({ dur: 0.06, gain: 0.10, freq: 1900, sweepTo: 500, q: 0.8 });
    this._tone({ type: 'square', freq: 320, toFreq: 140, dur: 0.05, gain: 0.05 });
  }

  enemyDeath(sizeScale = 1) {
    if (this._throttle('death', 22)) return;
    const f = 240 / sizeScale;
    this._tone({ type: 'sawtooth', freq: f, toFreq: f * 0.28, dur: 0.20 * sizeScale, gain: 0.16 });
    this._noiseHit({ dur: 0.22 * sizeScale, gain: 0.16, freq: 1400, sweepTo: 180, q: 0.6, type: 'lowpass' });
    this._tone({ type: 'sine', freq: f * 2.2, toFreq: f * 0.6, dur: 0.10, gain: 0.06, delay: 0.005 });
  }

  bigDeath() {
    this._tone({ type: 'sawtooth', freq: 150, toFreq: 34, dur: 0.75, gain: 0.30 });
    this._tone({ type: 'square', freq: 90, toFreq: 26, dur: 0.6, gain: 0.16, delay: 0.02 });
    this._noiseHit({ dur: 0.85, gain: 0.28, freq: 900, sweepTo: 70, q: 0.5, type: 'lowpass' });
    this._noiseHit({ dur: 0.14, gain: 0.20, freq: 5200, sweepTo: 1600, q: 1.0 });
  }

  playerHurt() {
    this._tone({ type: 'sawtooth', freq: 180, toFreq: 55, dur: 0.34, gain: 0.26 });
    this._noiseHit({ dur: 0.24, gain: 0.20, freq: 700, sweepTo: 110, q: 0.7, type: 'lowpass' });
    this._tone({ type: 'square', freq: 78, toFreq: 40, dur: 0.4, gain: 0.10, delay: 0.03 });
  }

  pickup() {
    if (this._throttle('pickup', 32)) return;
    this._tone({ type: 'sine', freq: 900, toFreq: 1500, dur: 0.075, gain: 0.055, attack: 0.002 });
  }

  shard() {
    if (this._throttle('shard', 40)) return;
    this._tone({ type: 'triangle', freq: 1320, toFreq: 1980, dur: 0.11, gain: 0.07 });
    this._tone({ type: 'sine', freq: 2640, dur: 0.07, gain: 0.03, delay: 0.02 });
  }

  levelUp() {
    // Rising arpeggio on the run's own scale — reads as "you got stronger", not a jingle.
    const base = midiToFreq(ROOT + 24);
    [0, 3, 7, 12].forEach((semi, i) => {
      this._tone({ type: 'triangle', freq: base * Math.pow(2, semi / 12), dur: 0.32,
                   gain: 0.13, delay: i * 0.055, attack: 0.006 });
      this._tone({ type: 'sine', freq: base * 2 * Math.pow(2, semi / 12), dur: 0.24,
                   gain: 0.05, delay: i * 0.055 });
    });
    this._noiseHit({ dur: 0.4, gain: 0.07, freq: 4200, sweepTo: 1200, q: 0.7 });
  }

  dash() {
    if (this._throttle('dash', 90)) return;
    this._noiseHit({ dur: 0.20, gain: 0.14, freq: 400, sweepTo: 3400, q: 1.4 });
    this._tone({ type: 'sine', freq: 200, toFreq: 700, dur: 0.16, gain: 0.07 });
  }

  uiClick() {
    this._tone({ type: 'square', freq: 620, toFreq: 880, dur: 0.045, gain: 0.05 });
  }

  uiBack() {
    this._tone({ type: 'square', freq: 520, toFreq: 300, dur: 0.06, gain: 0.05 });
  }

  tierShift() {
    // Whole-arena colour change gets a swell, so the visual escalation has a partner.
    const base = midiToFreq(ROOT + 12);
    this._tone({ type: 'sawtooth', freq: base * 0.5, toFreq: base, dur: 1.5, gain: 0.10, attack: 0.5, curve: 'lin' });
    this._tone({ type: 'triangle', freq: base * 1.5, dur: 1.2, gain: 0.06, attack: 0.4 });
    this._noiseHit({ dur: 1.4, gain: 0.10, freq: 200, sweepTo: 4000, q: 0.8 });
  }

  runComplete(isNewBest) {
    const base = midiToFreq(ROOT + 24);
    const notes = isNewBest ? [0, 4, 7, 12, 16] : [0, 3, 7, 10];
    notes.forEach((semi, i) => {
      this._tone({ type: 'triangle', freq: base * Math.pow(2, semi / 12), dur: 0.9,
                   gain: 0.12, delay: i * 0.13, attack: 0.02 });
    });
    this._tone({ type: 'sine', freq: base * 0.25, dur: 2.2, gain: 0.10, attack: 0.3 });
  }

  gameOver() {
    this._tone({ type: 'sawtooth', freq: 220, toFreq: 40, dur: 1.8, gain: 0.20, attack: 0.02 });
    this._tone({ type: 'sine', freq: 110, toFreq: 32, dur: 2.4, gain: 0.14, attack: 0.05 });
    this._noiseHit({ dur: 1.6, gain: 0.12, freq: 600, sweepTo: 60, q: 0.5, type: 'lowpass' });
  }

  milestone() {
    const base = midiToFreq(ROOT + 26);
    [0, 5, 9, 14, 17, 21].forEach((s, i) => {
      this._tone({ type: 'triangle', freq: base * Math.pow(2, s / 12), dur: 0.7, gain: 0.11, delay: i * 0.08 });
    });
  }

  // ---------------------------------------------------------------- adaptive music
  //
  // A 16-step sequencer scheduled ~100ms ahead of the audio clock. Intensity (0..1)
  // comes from the director and gates which layers exist:
  //   always   pad drone + sub pulse
  //   > 0.15   kick on the quarter
  //   > 0.35   bass line
  //   > 0.55   hats / off-beat noise
  //   > 0.75   arpeggio lead + tension detune
  // Tempo rides 82 -> 132 BPM across the same range.

  startMusic() {
    if (!this.ready || this._playing) return;
    this._playing = true;
    this._step = 0;
    this._totalBars = 0;
    this._chordIdx = 0;
    this._bassPattern = BASS_PATTERNS[0];
    this._nextStepTime = this.ctx.currentTime + 0.08;
    this.musicBus.gain.cancelScheduledValues(this.ctx.currentTime);
    this.musicBus.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    this.musicBus.gain.exponentialRampToValueAtTime(Math.max(0.0002, this.musicVol), this.ctx.currentTime + 1.6);
    this._startDrone();
  }

  stopMusic(fade = 1.2) {
    if (!this._playing) return;
    this._playing = false;
    const t = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setValueAtTime(Math.max(0.0002, this.musicBus.gain.value), t);
    this.musicBus.gain.exponentialRampToValueAtTime(0.0001, t + fade);
    if (this._drone) {
      this._drone.forEach((o) => { try { o.stop(t + fade + 0.1); } catch {} });
      this._drone = null;
    }
  }

  _startDrone() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this._drone = [];
    this._droneGains = [];
    this._droneOscs = [];
    // Two slightly detuned saws + a sine sub = a bed that sits under everything.
    [[ROOT, 'sawtooth', 0.030, -7], [ROOT, 'sawtooth', 0.030, 7], [ROOT - 12, 'sine', 0.055, 0]]
      .forEach(([note, type, gain, detune]) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const filt = ctx.createBiquadFilter();
        filt.type = 'lowpass';
        filt.frequency.value = 420;
        filt.Q.value = 1.2;
        osc.type = type;
        osc.frequency.value = midiToFreq(note);
        osc.detune.value = detune;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + 2.0);
        osc.connect(filt); filt.connect(g); g.connect(this.musicBus);
        osc.start(t);
        this._drone.push(osc);
        this._droneOscs.push({ osc, baseOffset: note - ROOT });
        this._droneGains.push({ g, filt, base: gain });
      });
  }

  setIntensity(v) { this._targetIntensity = clamp(v, 0, 1); }

  /** Called once per frame from the game loop. */
  update(dt) {
    if (!this.ready) return;
    this._intensity += (this._targetIntensity - this._intensity) * Math.min(1, dt * 0.8);
    if (!this._playing) return;

    const I = this._intensity;
    this._bpm = 82 + I * 50;

    // Drone opens up and gets brighter as things get dangerous.
    if (this._droneGains) {
      const t = this.ctx.currentTime;
      for (const d of this._droneGains) {
        d.filt.frequency.setTargetAtTime(420 + I * 900, t, 0.4);
        d.g.gain.setTargetAtTime(d.base * (1 + I * 0.5), t, 0.4);
      }
    }

    const stepDur = 60 / this._bpm / 4; // 16ths
    const lookahead = this.ctx.currentTime + 0.1;
    let guard = 0;
    while (this._nextStepTime < lookahead && guard++ < 32) {
      this._scheduleStep(this._step, this._nextStepTime, I);
      this._nextStepTime += stepDur;
      this._step = (this._step + 1) % 16;
    }
  }

  _scheduleStep(step, time, I) {
    const ctx = this.ctx;
    const delay = Math.max(0, time - ctx.currentTime);
    const bus = this.musicBus;

    if (step === 0) {
      this._totalBars++;
      const newChordIdx = Math.floor(this._totalBars / BARS_PER_CHORD) % PROGRESSION.length;
      if (newChordIdx !== this._chordIdx) {
        this._chordIdx = newChordIdx;
        const newChordRoot = ROOT + PROGRESSION[this._chordIdx];
        if (this._droneOscs) {
          this._droneOscs.forEach(({ osc, baseOffset }) => {
            osc.frequency.setTargetAtTime(midiToFreq(newChordRoot + baseOffset), time, 0.6);
          });
        }
        // Pick a new bass pattern that isn't the one we just played.
        let next = this._bassPattern;
        while (next === this._bassPattern && BASS_PATTERNS.length > 1) {
          next = BASS_PATTERNS[Math.floor(Math.random() * BASS_PATTERNS.length)];
        }
        this._bassPattern = next;
      }
    }
    const chordRoot = ROOT + PROGRESSION[this._chordIdx];

    // Sub pulse on the downbeat — present at every intensity, the heartbeat.
    if (step % 8 === 0) {
      this._tone({ type: 'sine', freq: midiToFreq(chordRoot - 12), toFreq: midiToFreq(chordRoot - 24),
                   dur: 0.5, gain: 0.10, delay, bus, attack: 0.01 });
    }

    if (I > 0.15 && step % 4 === 0) {
      this._tone({ type: 'sine', freq: 150, toFreq: 42, dur: 0.20, gain: 0.16 + I * 0.10, delay, bus, attack: 0.002 });
      this._noiseHit({ dur: 0.05, gain: 0.04 + I * 0.04, freq: 2200, sweepTo: 500, delay, bus });
    }

    if (I > 0.35) {
      const s = this._bassPattern[step];
      if (s >= 0) {
        this._tone({ type: 'sawtooth', freq: midiToFreq(chordRoot + SCALE[s % 5]),
                     dur: 0.14, gain: 0.075, delay, bus, attack: 0.006 });
      }
    }

    if (I > 0.55 && step % 2 === 1) {
      this._noiseHit({ dur: 0.035, gain: 0.022 + I * 0.02, freq: 8000, q: 1.6, delay, bus });
    }

    if (I > 0.75) {
      const arp = [0, 2, 4, 3, 2, 4, 1, 3];
      const s = arp[step % 8];
      this._tone({ type: 'triangle', freq: midiToFreq(chordRoot + 24 + SCALE[s]),
                   dur: 0.09, gain: 0.024, delay, bus, detune: (I - 0.75) * 20 });
    }

    // Bar-end tension riser once things are genuinely hairy.
    if (I > 0.85 && step === 12) {
      this._noiseHit({ dur: 0.5, gain: 0.045, freq: 300, sweepTo: 5000, q: 1.2, delay, bus });
    }
  }
}

export const audio = new AudioEngine();
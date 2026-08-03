// Fixed-capacity object pool with a swap-remove active list.
//
// Every hot-loop entity (bullets, particles, enemies, pickups, damage numbers) lives in
// one of these. Objects are constructed once at boot and reused forever, so the steady
// state of a run allocates nothing and the GC never has a reason to pause mid-frame.

export class Pool {
  /**
   * @param {number} capacity hard cap; spawns past this are dropped (or recycle the oldest)
   * @param {() => object} factory creates one blank instance
   */
  constructor(capacity, factory) {
    this.capacity = capacity;
    this.items = new Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.items[i] = factory();
      this.items[i]._idx = i;
    }
    this.active = 0; // items[0 .. active-1] are live
  }

  /** @returns {object|null} a slot to initialise, or null if full. */
  spawn() {
    if (this.active >= this.capacity) return null;
    return this.items[this.active++];
  }

  /**
   * Recycles the oldest live item when full instead of dropping the spawn. Right for
   * particles (losing the newest burst is more visible than losing a stale mote),
   * wrong for enemies (silently deleting a live threat).
   */
  spawnOrRecycle() {
    if (this.active < this.capacity) return this.items[this.active++];
    // releaseAt swaps the victim to the end of the live range, so the very next
    // spawn hands that same slot straight back.
    this.releaseAt(0);
    return this.items[this.active++];
  }

  /**
   * Swap-remove index i. O(1), but it reorders the array — so any loop that releases
   * must iterate backwards, or re-test the swapped-in index.
   */
  releaseAt(i) {
    // Defensive: a caller iterating the pool while kills cascade can hand us a stale
    // index. Silently ignoring it beats corrupting `active` into a negative number,
    // which turns every later spawn into an undefined-property crash.
    if (i < 0 || i >= this.active) return;
    const last = --this.active;
    if (i !== last) {
      const a = this.items[i], b = this.items[last];
      this.items[i] = b; b._idx = i;
      this.items[last] = a; a._idx = last;
    }
  }

  clear() { this.active = 0; }

  /** Iterate live items backwards so callbacks can safely release the current one. */
  forEachLive(fn) {
    for (let i = this.active - 1; i >= 0; i--) fn(this.items[i], i);
  }
}

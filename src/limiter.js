/**
 * Request rate limiter.
 *
 * A personal Riot key allows 20 requests per second and 100 per two minutes.
 * The second window is the binding one, and exceeding it returns 429s that
 * cascade into failed commands, so every call is funnelled through here rather
 * than relying on caches and cooldowns to keep usage incidentally low.
 *
 * Callers queue and are served in order; nothing is ever dropped.
 */
export class RateLimiter {
  #windows;
  #chain = Promise.resolve();

  /** @param windows e.g. [{ limit: 20, windowMs: 1000 }, { limit: 100, windowMs: 120000 }] */
  constructor(windows) {
    this.#windows = windows.map((window) => ({ ...window, hits: [] }));
  }

  #waitFor(now) {
    let longest = 0;

    for (const window of this.#windows) {
      // Drop hits that have aged out of this window.
      while (window.hits.length > 0 && window.hits[0] <= now - window.windowMs) {
        window.hits.shift();
      }

      if (window.hits.length >= window.limit) {
        // The window frees up when its oldest hit expires.
        longest = Math.max(longest, window.hits[0] + window.windowMs - now);
      }
    }

    return longest;
  }

  #record(now) {
    for (const window of this.#windows) window.hits.push(now);
  }

  /** Resolves when the caller may issue its request. */
  acquire() {
    // Serialising on a promise chain keeps the accounting race-free without
    // needing locks: each waiter sees the hits recorded by the one before it.
    const result = this.#chain.then(async () => {
      for (;;) {
        const now = Date.now();
        const wait = this.#waitFor(now);

        if (wait === 0) {
          this.#record(now);
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    });

    this.#chain = result.catch(() => {});
    return result;
  }
}

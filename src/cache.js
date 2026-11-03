/**
 * Tiny in-memory cache with per-entry expiry and a size limit.
 *
 * A TTL of Infinity never expires, which suits values that are immutable once
 * created (a Riot ID's PUUID, a finished match). Those entries still need a
 * size limit: this process runs for months, so an unbounded cache of large
 * match payloads would grow until the container is killed.
 *
 * Eviction is least-recently-used: reading an entry marks it as fresh.
 */
export class TtlCache {
  #entries = new Map();

  constructor(defaultTtlMs, maxEntries = Infinity) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = maxEntries;
  }

  get size() {
    return this.#entries.size;
  }

  #evictIfFull() {
    // Map preserves insertion order, so the first key is the oldest touch.
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      this.#entries.delete(oldest);
    }
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }

    // Re-insert so this key counts as the most recently used.
    this.#entries.delete(key);
    this.#entries.set(key, entry);

    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    const expiresAt = ttlMs === Infinity ? Infinity : Date.now() + ttlMs;
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt });
    this.#evictIfFull();
    return value;
  }

  /** Returns the cached value, or computes, stores and returns a fresh one. */
  wrap(key, producer, ttlMs = this.defaultTtlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    // The promise itself is cached, so a burst of chat commands shares a single
    // upstream request rather than each firing its own. Failures are evicted so
    // a transient Riot outage never sticks for the whole TTL.
    const pending = producer().catch((error) => {
      this.#entries.delete(key);
      throw error;
    });

    return this.set(key, pending, ttlMs);
  }
}

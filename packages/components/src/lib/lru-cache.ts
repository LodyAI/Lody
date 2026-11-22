/**
 * A simple LRU (Least Recently Used) cache implementation.
 * When the cache exceeds maxSize, the least recently accessed entries are evicted.
 */
export type LRUCacheOptions<K, V> = {
  /** Called after an entry is dropped to make room for a new one. */
  onEvict?: (key: K, value: V) => void;
};

export class LRUCache<K, V> {
  private cache: Map<K, V>;
  private readonly maxSize: number;
  private readonly onEvict: ((key: K, value: V) => void) | undefined;

  constructor(maxSize: number, options: LRUCacheOptions<K, V> = {}) {
    if (maxSize < 1) {
      throw new Error('LRU cache maxSize must be at least 1');
    }
    this.cache = new Map();
    this.maxSize = maxSize;
    this.onEvict = options.onEvict;
  }

  /**
   * Get a value from the cache.
   * Accessing a key moves it to the "most recently used" position.
   */
  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }
    // Move to end (most recently used) by deleting and re-inserting
    const value = this.cache.get(key) as V;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  /**
   * Set a value in the cache.
   * If the key already exists, it updates the value and moves it to "most recently used".
   * If adding a new key would exceed maxSize, the least recently used entry is evicted.
   */
  set(key: K, value: V): void {
    // If key exists, delete it first to update its position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict the least recently used (first item in Map iteration order)
      const firstKey = this.cache.keys().next().value as K;
      const evicted = this.cache.get(firstKey) as V;
      this.cache.delete(firstKey);
      this.onEvict?.(firstKey, evicted);
    }
    this.cache.set(key, value);
  }

  /**
   * Check if a key exists in the cache.
   * Note: This does NOT update the "recently used" status.
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Delete a key from the cache.
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Iterate over all cached values without affecting recency order.
   */
  values(): IterableIterator<V> {
    return this.cache.values();
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the current number of entries in the cache.
   */
  get size(): number {
    return this.cache.size;
  }
}

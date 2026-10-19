/** Daemon-local ownership: caller disconnects do not retire in-flight raw ACP work. */
export class ProviderQuotaRefreshCache {
  private readonly entries = new Map<
    string,
    {
      fingerprint: string;
      blocked?: unknown;
      pending?: Promise<boolean>;
      completedAt?: number;
      success?: boolean;
    }
  >();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly canRetry: (error: unknown) => boolean = () => true
  ) {}

  async run(key: string, fingerprint: string, query: () => Promise<boolean>): Promise<boolean> {
    const existing = this.entries.get(key);
    if (existing?.blocked) return false;
    if (existing?.pending) {
      if (existing.fingerprint === fingerprint) return existing.pending;
      await existing.pending;
      return this.run(key, fingerprint, query);
    }
    if (
      existing?.fingerprint === fingerprint &&
      existing.completedAt !== undefined &&
      this.now() - existing.completedAt < (existing.success ? 15_000 : 5_000)
    )
      return existing.success === true;
    const entry: {
      fingerprint: string;
      blocked?: unknown;
      pending?: Promise<boolean>;
      completedAt?: number;
      success?: boolean;
    } = { fingerprint };
    this.entries.set(key, entry);
    entry.pending = Promise.resolve()
      .then(query)
      .catch((error) => {
        if (!this.canRetry(error)) entry.blocked = error;
        return false;
      })
      .then((success) => {
        entry.success = success;
        entry.completedAt = this.now();
        entry.pending = undefined;
        // Bound settled metadata without ever evicting an in-flight owner.
        for (const [oldKey, old] of this.entries) {
          if (this.entries.size <= 256) break;
          if (!old.pending && !old.blocked && oldKey !== key) this.entries.delete(oldKey);
        }
        return success;
      });
    return entry.pending;
  }
}

/** Stop waiting on optional cloud calls when their local owner closes. This does
 * NOT cancel a server mutation: its durable job identity must survive ambiguity.
 * Always consume late replies/rejections, without running the caller continuation. */
export class ShortcutLifetime {
  private readonly controller = new AbortController();

  wait<T>(pending: Promise<T>): Promise<T> {
    const { signal } = this.controller;
    return new Promise((resolve, reject) => {
      const aborted = () => {
        signal.removeEventListener('abort', aborted);
        reject(new Error('Shortcut runtime disposed'));
      };
      signal.addEventListener('abort', aborted, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener('abort', aborted);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', aborted);
          reject(error);
        }
      );
      if (signal.aborted) aborted();
    });
  }

  dispose() {
    this.controller.abort();
  }
}

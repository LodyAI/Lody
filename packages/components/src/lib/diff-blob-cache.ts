export const DIFF_BLOB_CACHE_DB = 'lody:diff-blobs-v1';
const MAX_BYTES = 64 * 1024 * 1024;

type CachedBlob = { id: string; bytes: Uint8Array; size: number; touched: number };

/** Verified content only. Disk persistence is opt-in for ordinary remote workspaces. */
export class DiffBlobCache {
  private readonly memory = new Map<string, Uint8Array>();
  private bytes = 0;
  private revision = 0;
  get epoch(): number {
    return this.revision;
  }

  async get(scope: string, key: string, persist: boolean): Promise<Uint8Array | undefined> {
    const epoch = this.revision;
    const id = `${scope}\0${key}`;
    const hit = this.memory.get(id);
    if (hit) {
      this.memory.delete(id);
      this.memory.set(id, hit);
      return hit;
    }
    if (!persist) return undefined;
    try {
      const db = await openCache();
      try {
        const tx = db.transaction(['blobs', 'sizes'], 'readwrite');
        const store = tx.objectStore('blobs');
        const done = transactionDone(tx);
        const row = await requestResult<CachedBlob | undefined>(store.get(id));
        if (row) {
          store.put({ ...row, touched: Date.now() });
          tx.objectStore('sizes').put({ id, size: row.size, touched: Date.now() });
        }
        await done;
        if (row && epoch === this.revision) this.remember(id, row.bytes);
        return row?.bytes;
      } finally {
        db.close();
      }
    } catch {
      return undefined;
    }
  }

  async put(scope: string, key: string, bytes: Uint8Array, persist: boolean): Promise<void> {
    if (bytes.length > MAX_BYTES) return;
    const id = `${scope}\0${key}`;
    this.remember(id, bytes);
    if (!persist) return;
    try {
      const db = await openCache();
      try {
        const tx = db.transaction(['blobs', 'sizes'], 'readwrite');
        const done = transactionDone(tx);
        tx.objectStore('blobs').put({
          id,
          bytes,
          size: bytes.length,
          touched: Date.now(),
        } satisfies CachedBlob);
        tx.objectStore('sizes').put({ id, size: bytes.length, touched: Date.now() });
        const sizes = await requestResult<{ id: string; size: number; touched: number }[]>(
          tx.objectStore('sizes').getAll()
        );
        let total = sizes.reduce((sum, row) => sum + row.size, 0);
        let count = sizes.length;
        for (const row of sizes.sort((a, b) => a.touched - b.touched)) {
          if (total <= MAX_BYTES && count <= 2048) break;
          tx.objectStore('blobs').delete(row.id);
          tx.objectStore('sizes').delete(row.id);
          total -= row.size;
          count--;
        }
        await done;
      } finally {
        db.close();
      }
    } catch {
      /* A cache quota failure never makes an authorized file unreadable. */
    }
  }

  async delete(scope: string, key: string, persist: boolean): Promise<void> {
    const id = `${scope}\0${key}`;
    const value = this.memory.get(id);
    if (value) this.bytes -= value.length;
    this.memory.delete(id);
    if (!persist) return;
    try {
      const db = await openCache();
      try {
        const tx = db.transaction(['blobs', 'sizes'], 'readwrite');
        const done = transactionDone(tx);
        tx.objectStore('blobs').delete(id);
        tx.objectStore('sizes').delete(id);
        await done;
      } finally {
        db.close();
      }
    } catch {
      /* A corrupt cache entry will be verified again before use. */
    }
  }

  clear(): void {
    this.revision++;
    this.memory.clear();
    this.bytes = 0;
  }
  private remember(id: string, value: Uint8Array): void {
    const old = this.memory.get(id);
    if (old) this.bytes -= old.length;
    this.memory.delete(id);
    this.memory.set(id, value);
    this.bytes += value.length;
    while (this.bytes > MAX_BYTES || this.memory.size > 2048) {
      const oldest = this.memory.entries().next().value;
      if (!oldest) break;
      this.memory.delete(oldest[0]);
      this.bytes -= oldest[1].length;
    }
  }
}

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DIFF_BLOB_CACHE_DB, 1);
    let abandoned = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore('blobs', { keyPath: 'id' });
      request.result.createObjectStore('sizes', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      if (abandoned) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      abandoned = true;
      reject(new Error('Diff cache is blocked.'));
    };
  });
}
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transactionDone(tx: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
  void done.catch(() => undefined);
  return done;
}

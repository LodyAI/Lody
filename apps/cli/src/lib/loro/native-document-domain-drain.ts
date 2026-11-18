import { isDeepStrictEqual } from 'node:util';
import {
  nativeDocumentDomainFreezeRequestSchema,
  type NativeDocumentDomainFreezeRequest,
  type NativeDocumentDomainFreezeResponse,
} from '@lody/shared/native-document-domain-control';
import type { RendererDocumentDomainScope } from '@lody/shared/renderer-document-domain-migration';

type Held = {
  request: NativeDocumentDomainFreezeRequest;
  metadataGeneration: string;
  draining?: Promise<void>;
  sealed: boolean;
};
/** Exact-room Promise application boundary. The original SDK flush/unload work
 * remains owned after a deadline; retries join it rather than replay authors. */
export class NativeDocumentDomainDrainLegacy {
  private retired = false;
  private readonly active = new Map<string, Set<Promise<unknown>>>();
  private readonly held = new Map<string, Held>();
  constructor(
    private readonly ports: {
      accountId: string;
      workspaceId: string;
      ownerGeneration: string;
      metadataGeneration(): string;
      authorize(
        scope: RendererDocumentDomainScope,
        purpose?: 'create',
        nonce?: string
      ): Promise<void>;
      route(scope: RendererDocumentDomainScope): 'legacy' | 'frozen' | 'native';
      /** Seal captured WASM containers, stop exact-room transport/peers, persist
       * through the original SDK writer and join its real unload acknowledgement. */
      drain(scope: RendererDocumentDomainScope): Promise<void>;
      source(scope: RendererDocumentDomainScope): {
        sourceId: string;
        present: boolean;
        sha256: string;
        byteLength: number;
      };
      waitMs?: number;
    }
  ) {}
  assertLegacy(roomId: string) {
    if (this.retired || this.held.has(roomId)) throw new Error('Legacy document author is frozen');
  }
  run<A>(roomId: string, work: () => Promise<A>): Promise<A> {
    this.assertLegacy(roomId);
    const raw = Promise.resolve().then(work);
    const jobs = this.active.get(roomId) ?? new Set<Promise<unknown>>();
    jobs.add(raw);
    this.active.set(roomId, jobs);
    void raw
      .finally(() => {
        jobs.delete(raw);
        if (!jobs.size) this.active.delete(roomId);
      })
      .catch(() => {});
    return raw;
  }
  private bounded<A>(work: Promise<A>): Promise<A> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Document drain unconfirmed')),
        this.ports.waitMs ?? 5000
      );
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }
  private check(entry: Held) {
    if (
      this.held.get(entry.request.scope.roomId) !== entry ||
      this.ports.metadataGeneration() !== entry.metadataGeneration
    )
      throw new Error('Document drain generation changed');
  }
  async handle(
    input: NativeDocumentDomainFreezeRequest
  ): Promise<NativeDocumentDomainFreezeResponse> {
    const parsed = nativeDocumentDomainFreezeRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'invalid_request' };
    const request = parsed.data,
      roomId = request.scope.roomId;
    if (
      this.retired ||
      request.accountId !== this.ports.accountId ||
      request.workspaceId !== this.ports.workspaceId
    )
      return { ok: false, error: 'scope_unavailable' };
    try {
      await this.ports.authorize(request.scope, request.purpose, request.nonce);
      let entry = this.held.get(roomId);
      if (
        entry &&
        (entry.request.nonce !== request.nonce ||
          entry.request.purpose !== request.purpose ||
          !isDeepStrictEqual(entry.request.scope, request.scope))
      )
        throw new Error('Document drain nonce changed');
      if (!entry && request.phase === 'abort' && this.ports.route(request.scope) === 'legacy')
        return {
          ...request,
          phase: 'abort',
          ok: true,
          ownerGeneration: this.ports.ownerGeneration,
          metadataGeneration: this.ports.metadataGeneration(),
          released: true,
        };
      if (!entry && request.phase === 'publish' && this.ports.route(request.scope) === 'native') {
        entry = { request, metadataGeneration: this.ports.metadataGeneration(), sealed: true };
        this.held.set(roomId, entry);
        const recovered = entry;
        entry.draining = Promise.resolve()
          .then(() => this.ports.drain(request.scope))
          .then(() => {
            this.check(recovered);
          });
        void entry.draining.catch(() => {});
      }
      if (!entry) {
        if (request.phase !== 'prepare' || this.ports.route(request.scope) === 'native')
          throw new Error('Document must prepare before freeze');
        entry = { request, metadataGeneration: this.ports.metadataGeneration(), sealed: false };
        this.held.set(roomId, entry);
      }
      this.check(entry);
      const reply = {
        ...request,
        ok: true as const,
        ownerGeneration: this.ports.ownerGeneration,
        metadataGeneration: entry.metadataGeneration,
      };
      if (request.phase === 'prepare') {
        await this.bounded(Promise.allSettled([...(this.active.get(roomId) ?? [])]));
        this.check(entry);
        return { ...reply, phase: 'prepare', prepared: true };
      }
      if (request.phase === 'publish' || request.phase === 'abort') {
        if (
          this.ports.route(request.scope) !== (request.phase === 'publish' ? 'native' : 'legacy') ||
          (request.phase === 'abort' && entry.sealed)
        )
          throw new Error('Document release route changed');
        if (entry.draining) await this.bounded(entry.draining);
        this.check(entry);
        this.held.delete(roomId);
        return { ...reply, phase: request.phase, released: true };
      }
      if (this.ports.route(request.scope) === 'legacy')
        throw new Error('Durable document freeze required');
      if (request.phase === 'freeze') {
        entry.sealed = true;
        if (!entry.draining) {
          const original = entry;
          const work = (async () => {
            await Promise.allSettled([...(this.active.get(roomId) ?? [])]);
            this.check(original);
            await this.ports.drain(request.scope);
            this.check(original);
          })();
          entry.draining = work;
          void work.catch(() => {
            if (original.draining === work) original.draining = undefined;
          });
        }
      }
      if (!entry.draining) throw new Error('Document physical drain unavailable');
      await this.bounded(entry.draining);
      this.check(entry);
      const source = this.ports.source(request.scope);
      this.check(entry);
      return {
        ...reply,
        phase: request.phase,
        source: {
          sourceId: source.sourceId,
          present: source.present,
          sha256: source.sha256,
          byteLength: source.byteLength,
        },
      };
    } catch {
      return { ok: false, error: 'freeze_unconfirmed' };
    }
  }
  async close() {
    this.retired = true;
    for (const entry of this.held.values()) {
      if (entry.sealed && !entry.draining) {
        const raw = Promise.resolve().then(() => this.ports.drain(entry.request.scope));
        entry.draining = raw;
        void raw.catch(() => {
          if (entry.draining === raw) entry.draining = undefined;
        });
      }
    }
    const original = [...this.held.values()].flatMap((entry) =>
      entry.draining ? [entry.draining] : []
    );
    await this.bounded(Promise.allSettled([...this.active.values()].flatMap((set) => [...set])));
    const results = await this.bounded(Promise.allSettled(original));
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length)
      throw new AggregateError(failures, 'Document drain cleanup remains unconfirmed');
    this.held.clear();
  }
}

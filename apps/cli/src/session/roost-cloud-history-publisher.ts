import {
  roostCloudHistoryBindingSchema,
  ROOST_HISTORY_BUCKET_ID,
  roostCloudHistoryStreamId,
  roostHistoryAuthorKey,
  roostHistorySourceId,
  RoostCloudHistoryRequestError,
  type RoostCloudHistoryBinding,
  type RoostCloudHistoryGrant,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { RoostHistoryGeneration } from './roost-history-generation';
import { acquireRoostCloudUploadOwner } from './roost-node-session';

const MAX_SEND = 32n;
const RETRY_MS = 2_000;

type UploadOwner = Awaited<ReturnType<typeof acquireRoostCloudUploadOwner>>;
type Options = {
  readonly workspaceId: WorkspaceId;
  readonly machineId: string;
  readonly grant: (
    sessionId: SessionId,
    binding: RoostCloudHistoryBinding,
    signal: AbortSignal
  ) => Promise<RoostCloudHistoryGrant>;
  readonly isOwned: (sessionId: SessionId) => Promise<boolean>;
  readonly publish: (
    sessionId: SessionId,
    binding: RoostCloudHistoryBinding,
    signal: AbortSignal
  ) => Promise<void>;
  readonly unpublish: (sessionId: SessionId, signal: AbortSignal) => Promise<void>;
  readonly logger: Logger;
};

/** Workspace-owned scheduling over Native's durable per-stream upload queue. */
export class RoostCloudHistoryPublisher {
  private readonly lifetime = new AbortController();
  private readonly pending = new Map<SessionId, number>();
  private readonly priority = new Set<SessionId>();
  private prioritizedLast = false;
  private readonly removed = new Set<SessionId>();
  private readonly failures = new Map<SessionId, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private publishing: SessionId | undefined;
  private owner: UploadOwner | undefined;
  private readonly grants = new Map<string, { grant: RoostCloudHistoryGrant; expires: number }>();
  private readonly remotes = new Map<string, Uint8Array>();
  private readonly refused = new Set<string>();
  private closing: Promise<void> | undefined;

  constructor(private readonly options: Options) {}

  enqueue(sessionId: SessionId): void {
    if (this.lifetime.signal.aborted) return;
    if (!this.pending.has(sessionId)) this.pending.set(sessionId, 0);
    this.schedule();
  }

  prioritize(sessionId: SessionId): void {
    if (this.pending.has(sessionId)) this.priority.add(sessionId);
  }

  remove(sessionId: SessionId): void {
    this.removed.add(sessionId);
    this.enqueue(sessionId);
  }

  pendingWork(): ReadonlyMap<SessionId, boolean> {
    const sessions = new Set(this.pending.keys());
    if (this.publishing) sessions.add(this.publishing);
    return new Map([...sessions].map((sessionId) => [sessionId, this.removed.has(sessionId)]));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    clearTimeout(this.timer);
    this.pending.clear();
    this.priority.clear();
    this.removed.clear();
    this.failures.clear();
    this.grants.clear();
    this.remotes.clear();
    this.refused.clear();
    return (this.closing = (async () => {
      await this.running;
      await this.owner?.release();
    })());
  }

  private schedule(): void {
    if (this.running || this.lifetime.signal.aborted) return;
    clearTimeout(this.timer);
    if (!this.pending.size) return;
    let next = Infinity;
    for (const due of this.pending.values()) next = Math.min(next, due);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.running = this.step().finally(() => {
          this.running = undefined;
          this.schedule();
        });
      },
      Math.max(0, next - Date.now())
    );
  }

  private async step(): Promise<void> {
    const now = Date.now();
    let priority: SessionId | undefined;
    let backlog: SessionId | undefined;
    for (const [sessionId, due] of this.pending) {
      if (due > now) continue;
      if (this.priority.has(sessionId)) priority ??= sessionId;
      else backlog ??= sessionId;
      if (priority && backlog) break;
    }
    const sessionId = this.prioritizedLast ? (backlog ?? priority) : (priority ?? backlog);
    if (!sessionId) return;
    this.prioritizedLast = sessionId === priority;
    this.pending.delete(sessionId);
    this.publishing = sessionId;
    try {
      if (this.lifetime.signal.aborted) return;
      if (this.removed.has(sessionId)) {
        await this.options.unpublish(sessionId, this.lifetime.signal);
        this.removed.delete(sessionId);
      } else if (await this.options.isOwned(sessionId)) {
        const done = await this.upload(sessionId);
        if (!done && !this.lifetime.signal.aborted) {
          this.pending.set(sessionId, 0);
          this.failures.delete(sessionId);
          return;
        }
      }
      this.priority.delete(sessionId);
      this.failures.delete(sessionId);
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      if (error instanceof RoostCloudHistoryRequestError && !error.retryable) {
        this.priority.delete(sessionId);
        this.failures.delete(sessionId);
        this.options.logger.warn(`[${sessionId}] ${error.message}`);
        return;
      }
      const failures = (this.failures.get(sessionId) ?? 0) + 1;
      this.failures.set(sessionId, failures);
      if (failures === 1)
        this.options.logger.warn(`[${sessionId}] Roost cloud history upload will retry`);
      this.pending.set(sessionId, Date.now() + RETRY_MS * 2 ** Math.min(failures - 1, 5));
    } finally {
      this.publishing = undefined;
    }
  }

  private async upload(sessionId: SessionId): Promise<boolean> {
    const signal = this.lifetime.signal;
    signal.throwIfAborted();
    const owner = (this.owner ??= await acquireRoostCloudUploadOwner());
    const history = new RoostHistoryGeneration(owner.client, owner.owner, sessionId);
    await history.resolve();
    const source = history.observationStream;
    const root = roostHistorySourceId(sessionId, 'root');
    const binding = roostCloudHistoryBindingSchema.parse({
      generation: source === root ? 'root' : source.slice(`${root}:generation:`.length),
      ownerPublicKey: roostHistoryAuthorKey(owner.owner),
    });
    const physicalStream = roostCloudHistoryStreamId(
      this.options.workspaceId,
      this.options.machineId,
      sessionId,
      binding
    );
    if (this.refused.has(physicalStream)) return true;
    const getGrant = async (currentSignal: AbortSignal, refresh = false) => {
      const cached = this.grants.get(physicalStream);
      if (!refresh && cached && Date.now() < cached.expires) return cached.grant;
      const grant = await this.options.grant(sessionId, binding, currentSignal).catch((error) => {
        if (error instanceof RoostCloudHistoryRequestError && !error.retryable) {
          if (this.refused.size >= 256) this.refused.delete(this.refused.values().next().value!);
          this.refused.add(physicalStream);
        }
        throw error;
      });
      currentSignal.throwIfAborted();
      if (
        !new URL(grant.streamUrl).pathname.endsWith(
          `/ds/${ROOST_HISTORY_BUCKET_ID}/${encodeURIComponent(physicalStream)}`
        )
      )
        throw new Error('Roost upload grant does not name the owner stream');
      if (this.grants.size >= 64) this.grants.clear();
      this.grants.set(physicalStream, {
        grant,
        expires: Date.now() + (grant.expiresIn - 5) * 1_000,
      });
      return grant;
    };
    const initial = await getGrant(signal);
    const url = initial.streamUrl;
    const remoteKey = JSON.stringify([physicalStream, url]);
    let remoteId = this.remotes.get(remoteKey);
    const needsEnsure = !remoteId;
    if (!remoteId) {
      const registered = await owner.client.listRemotes({ signal });
      remoteId =
        registered.find(
          (remote) => remote.name === physicalStream && remote.url === url && remote.enabled
        )?.id ??
        (
          await owner.client.registerRemote(
            {
              name: physicalStream,
              url,
              physicalStream,
              generation: {
                bytes: new TextEncoder().encode(binding.generation),
                source: 'app_marker',
              },
            },
            { signal }
          )
        ).id;
    }
    signal.throwIfAborted();
    if (!(await this.options.isOwned(sessionId))) return true;
    const unbind = owner.bindAuth(remoteId, async ({ reason, signal: request }) => {
      const grant = await getGrant(AbortSignal.any([signal, request]), reason === 'unauthorized');
      if (grant.streamUrl !== url) throw new Error('Roost upload grant changed stream');
      return grant.token;
    });
    try {
      const sync = owner.client.stream(source).sync(remoteId, {
        partial: false,
        authentication: 'host',
        encryption: 'plaintext',
      });
      if (needsEnsure) {
        await sync.ensureRemote({ signal });
        if (this.remotes.size >= 256) this.remotes.clear();
        this.remotes.set(remoteKey, remoteId);
      }
      const result = await sync.upload({ maxSend: MAX_SEND }, { signal });
      signal.throwIfAborted();
      if (result.transportError) throw new Error('Roost cloud history upload failed');
      if (result.waitingLocal.length || result.waitingParents.length) {
        if (result.confirmed.length) return false;
        throw new Error('Roost cloud history has unconfirmed writes');
      }
      if (BigInt(result.sent.length) >= MAX_SEND || result.sent.length !== result.confirmed.length)
        return false;
      await history.resolve();
      signal.throwIfAborted();
      if (history.observationStream !== source) return false;
      if (await this.options.isOwned(sessionId))
        await this.options.publish(sessionId, binding, signal);
      return true;
    } catch (error) {
      this.remotes.delete(remoteKey);
      throw error;
    } finally {
      unbind();
    }
  }
}

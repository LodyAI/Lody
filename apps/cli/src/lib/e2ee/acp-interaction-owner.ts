import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  E2eeAcpInteractionParamsSchema,
  type E2eeAcpInteractionResultSchema,
} from '@lody/shared/local-machine-rpc';
import {
  e2eeAcpInteractionInputContext,
  e2eeAcpInteractionResponseContext,
} from '@lody/shared/e2ee-rpc';
import type { RpcSecretEnvelope, RpcSecretPublicKey } from '@lody/shared';

type Params = z.infer<typeof E2eeAcpInteractionParamsSchema>;
type Start = Extract<Params, { action: 'start' }>;
type Result = z.infer<typeof E2eeAcpInteractionResultSchema>;
type Context = {
  requestId: string;
  requesterDevice: string;
  expiresAt: number;
  authority?: { isCurrent(): boolean; signal: AbortSignal };
};
type Recipient = {
  publicKey: RpcSecretPublicKey;
  decrypt(envelope: RpcSecretEnvelope, context: string): Promise<string>;
};
type Work = { result: Promise<unknown>; cancel(): Promise<void> | void };

type Session = {
  requester: string;
  start: Start;
  deadline: number;
  state: Result['state'];
  controller: AbortController;
  recipient?: Recipient;
  work?: Work;
  progress: Array<{ cursor: number; value: unknown; bytes: number; pinned?: boolean }>;
  progressBytes: number;
  nextCursor: number;
  deliveredCursor: number;
  acknowledgedCursor: number;
  result?: unknown;
  consumed: Set<string>;
  submitted: Set<string>;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  ready: boolean;
  activated: boolean;
  authority?: Context['authority'];
  onRevoke?: () => void;
};

/** Owns one machine/workspace's encrypted ACP interactions. Call close when its runtime stops.
 * The caller must provide the verified feature context, and journal original requests before invoking.
 */
export function createAcpInteractionOwner(options: {
  workspaceId: string;
  machineId: string;
  createRecipient(): Promise<Recipient>;
  encrypt(key: RpcSecretPublicKey, plaintext: string, context: string): Promise<RpcSecretEnvelope>;
  start(args: {
    requestId: string;
    configId: Start['configId'];
    kind: Start['kind'];
    force?: boolean;
    methodId?: string;
    signal: AbortSignal;
    onProgress(progress: unknown): void;
  }): Work;
  submit(args: { requestId: string; interactionId: string; input: string }): Promise<void>;
  now?: () => number;
  maxSessions?: number;
  maxLifetimeMs?: number;
  closeTimeoutMs?: number;
}) {
  const sessions = new Map<string, Session>();
  // Feature envelopes are accepted for at most fifteen minutes by the verified ingress.
  const tombstones = new Map<string, ReturnType<typeof setTimeout>>();
  const tombstoneKey = (device: string, id: string) => `${device}:${id}`;
  const tombstoneLifetime = 900_000;
  const now = options.now ?? Date.now;
  const capacity = options.maxSessions ?? 32;
  const lifetime = Math.min(options.maxLifetimeMs ?? 300_000, 300_000);
  if (!Number.isFinite(lifetime) || lifetime <= 0) throw new Error('e2ee_acp_invalid_lifetime');
  const closeTimeout = options.closeTimeoutMs ?? 1000;
  if (!Number.isFinite(closeTimeout) || closeTimeout <= 0 || closeTimeout > 30_000)
    throw new Error('e2ee_acp_invalid_close_timeout');
  let closed = false;
  const remove = (id: string, session: Session) => {
    if (session.authority && session.onRevoke)
      session.authority.signal.removeEventListener('abort', session.onRevoke);
    if (sessions.get(id) === session) sessions.delete(id);
  };
  const stop = (session: Session, state: 'cancelled' | 'expired') => {
    if (session.state !== 'running') {
      if (state === 'expired') {
        session.state = state;
        session.progress = [];
        session.progressBytes = 0;
        session.result = undefined;
        session.recipient = undefined;
      }
      return;
    }
    session.state = state;
    session.progress = [];
    session.progressBytes = 0;
    session.result = undefined;
    session.recipient = undefined;
    session.controller.abort();
    if (session.work)
      void Promise.resolve()
        .then(() => session.work?.cancel())
        .catch(() => undefined);
  };
  const checkAuthority = (session: Session): boolean => {
    let current = !closed;
    try {
      current =
        current &&
        (!session.authority ||
          (!session.authority.signal.aborted && session.authority.isCurrent()));
    } catch {
      current = false;
    }
    if (!current) {
      if (session.state === 'running') stop(session, 'cancelled');
      else {
        session.state = 'cancelled';
        session.progress = [];
        session.progressBytes = 0;
        session.result = undefined;
        session.recipient = undefined;
      }
    }
    return current;
  };
  const expire = (id: string, session: Session) => {
    stop(session, 'expired');
    // A non-cooperating raw task remains owned and consumes capacity until it settles.
    if (session.settled) remove(id, session);
  };
  const ensureLive = (id: string, session: Session) => {
    checkAuthority(session);
    if (now() >= session.deadline) expire(id, session);
  };
  const bounded = (value: unknown): unknown => {
    const text = JSON.stringify(value);
    if (text === undefined || Buffer.byteLength(text) > 65536)
      throw new Error('e2ee_acp_content_limit');
    return JSON.parse(text) as unknown;
  };
  const reply = async (id: string, session: Session, context: Context): Promise<Result> => {
    if (!checkAuthority(session)) throw new Error('e2ee_acp_authority_revoked');
    ensureLive(id, session);
    const progress = session.progress[0];
    if (progress) progress.pinned = true;
    const state = progress ? 'running' : session.state;
    const result: Result = { type: 'machine/acp-interaction', interactionRequestId: id, state };
    if (state === 'running' && session.recipient)
      result.inputPublicKey = session.recipient.publicKey;
    const content = progress
      ? { progress: progress.value, progressCursor: progress.cursor }
      : state === 'completed'
        ? { result: { kind: session.start.kind, response: session.result } }
        : undefined;
    if (content) {
      result.responseEnvelope = await options.encrypt(
        session.start.responseKey,
        JSON.stringify(content),
        e2eeAcpInteractionResponseContext({
          workspaceId: options.workspaceId,
          machineId: options.machineId,
          requesterDevice: session.requester,
          interactionRequestId: id,
          requestId: context.requestId,
        })
      );
      if (!checkAuthority(session)) throw new Error('e2ee_acp_authority_revoked');
      ensureLive(id, session);
      if (progress && session.progress[0]?.cursor === progress.cursor) {
        session.deliveredCursor = Math.max(session.deliveredCursor, progress.cursor);
      } else if (!progress && session.state !== state) return reply(id, session, context);
      if (progress && now() >= session.deadline) return reply(id, session, context);
    }
    return result;
  };
  return {
    async handle(params: Params, context: Context): Promise<Result> {
      if (
        closed ||
        !/^[0-9a-f]{64}$/.test(context.requesterDevice) ||
        !/^[0-9a-f]{32}$/.test(context.requestId) ||
        !Number.isFinite(context.expiresAt) ||
        context.expiresAt <= now()
      )
        throw new Error('e2ee_acp_invalid_context');
      const id = params.action === 'start' ? context.requestId : params.interactionRequestId;
      if (params.action === 'start') {
        if (tombstones.has(tombstoneKey(context.requesterDevice, id)))
          throw new Error('e2ee_acp_cancelled_before_start');
        if (sessions.has(id)) throw new Error('e2ee_acp_duplicate_start');
        if (sessions.size >= capacity) throw new Error('e2ee_acp_capacity');
        const deadline = now() + lifetime;
        const session: Session = {
          requester: context.requesterDevice,
          start: params,
          deadline,
          state: 'running',
          controller: new AbortController(),
          consumed: new Set(),
          submitted: new Set(),
          progress: [],
          progressBytes: 0,
          nextCursor: 1,
          deliveredCursor: 0,
          acknowledgedCursor: 0,
          timer: setTimeout(() => expire(id, session), Math.max(1, deadline - now())),
          settled: false,
          ready: false,
          activated: false,
          authority: context.authority,
        };
        sessions.set(id, session);
        if (session.authority) {
          session.onRevoke = () => {
            checkAuthority(session);
          };
          session.authority.signal.addEventListener('abort', session.onRevoke, { once: true });
        }
        try {
          if (!checkAuthority(session)) throw new Error('e2ee_acp_authority_revoked');
          session.recipient = await options.createRecipient();
          ensureLive(id, session);
          // The envelope grants admission only while it is valid; key preparation can
          // outlive it, but must never start an agent after that point.
          if (now() >= context.expiresAt) throw new Error('e2ee_acp_start_expired');
          if (!checkAuthority(session)) throw new Error('e2ee_acp_authority_revoked');
          if (closed || session.state !== 'running') {
            session.recipient = undefined;
            session.settled = true;
            expire(id, session);
            return reply(id, session, context);
          }
          session.ready = true;
          session.settled = true;
          return await reply(id, session, context);
        } catch (error) {
          stop(session, 'cancelled');
          if (!session.work) session.settled = true;
          throw error;
        }
      }
      const session = sessions.get(id);
      if (!session && params.action === 'cancel') {
        if (
          context.authority &&
          (context.authority.signal.aborted || !context.authority.isCurrent())
        )
          throw new Error('e2ee_acp_authority_revoked');
        const key = tombstoneKey(context.requesterDevice, id);
        if (!tombstones.has(key)) {
          if (tombstones.size >= 128) throw new Error('e2ee_acp_tombstone_capacity');
          tombstones.set(
            key,
            setTimeout(() => tombstones.delete(key), tombstoneLifetime)
          );
        }
        return { type: 'machine/acp-interaction', interactionRequestId: id, state: 'cancelled' };
      }
      if (!session || session.requester !== context.requesterDevice)
        throw new Error('e2ee_acp_not_found');
      if (!checkAuthority(session)) throw new Error('e2ee_acp_authority_revoked');
      ensureLive(id, session);
      if (params.action === 'activate') {
        if (
          context.authority &&
          (context.authority.signal.aborted || !context.authority.isCurrent())
        )
          throw new Error('e2ee_acp_authority_revoked');
        if (session.state !== 'running' || !session.ready || session.activated)
          throw new Error('e2ee_acp_activation_unavailable');
        // No asynchronous gap between the cancellation/authority checks and reserving activation.
        session.activated = true;
        session.settled = false;
        const deadline = session.deadline;
        const start = session.start;
        try {
          session.work = options.start({
            requestId: id,
            configId: start.configId,
            kind: start.kind,
            ...(start.kind === 'probe' ? { force: start.force } : { methodId: start.methodId }),
            signal: session.controller.signal,
            onProgress: (progress) => {
              if (!checkAuthority(session) || session.state !== 'running' || now() >= deadline)
                return;
              try {
                const value = bounded(progress);
                const bytes = Buffer.byteLength(JSON.stringify(value));
                const previous = session.progress[session.progress.length - 1];
                const current = value as Record<string, unknown> | null;
                const prior = previous?.value as Record<string, unknown> | null;
                const replaceable =
                  current &&
                  prior &&
                  !Array.isArray(current) &&
                  !Array.isArray(prior) &&
                  previous &&
                  !previous.pinned &&
                  ((current.status === 'runtime-download' &&
                    prior.status === current.status &&
                    prior.runtimeName === current.runtimeName &&
                    prior.runtimePhase === current.runtimePhase) ||
                    (current.type === 'machine/acp-binary-progress' &&
                      prior.type === current.type &&
                      current.status === prior.status &&
                      current.agentType === prior.agentType) ||
                    (current.status === 'output' &&
                      prior.status === 'output' &&
                      current.stream === prior.stream &&
                      typeof current.output === 'string' &&
                      typeof prior.output === 'string'));
                if (replaceable && previous) {
                  const merged =
                    current.status === 'output'
                      ? {
                          ...current,
                          output: (String(prior?.output) + String(current.output)).slice(-8192),
                        }
                      : value;
                  const mergedBytes = Buffer.byteLength(JSON.stringify(merged));
                  if (session.progressBytes - previous.bytes + mergedBytes <= 262144) {
                    session.progressBytes += mergedBytes - previous.bytes;
                    previous.value = merged;
                    previous.bytes = mergedBytes;
                    return;
                  }
                }
                if (session.progress.length >= 32 || session.progressBytes + bytes > 262144) {
                  const queued = session.progress;
                  const queuedBytes = session.progressBytes;
                  stop(session, 'cancelled');
                  session.progress = queued;
                  session.progressBytes = queuedBytes;
                  return;
                }
                session.progress.push({ cursor: session.nextCursor++, value, bytes });
                session.progressBytes += bytes;
              } catch {
                stop(session, 'cancelled');
              }
            },
          });
          if (session.state !== 'running') {
            session.controller.abort();
            void Promise.resolve()
              .then(() => session.work?.cancel())
              .catch(() => undefined);
          }
          void session.work.result
            .then(
              (result) => {
                if (!checkAuthority(session) || session.state !== 'running' || now() >= deadline)
                  return;
                try {
                  session.result = bounded(result);
                  session.state = 'completed';
                  session.recipient = undefined;
                } catch {
                  stop(session, 'cancelled');
                }
              },
              () => {
                stop(session, 'cancelled');
              }
            )
            .finally(() => {
              session.settled = true;
              if (now() >= deadline || closed) {
                clearTimeout(session.timer);
                remove(id, session);
              }
            });
          return await reply(id, session, context);
        } catch (error) {
          stop(session, 'cancelled');
          if (!session.work) session.settled = true;
          throw error;
        }
      }
      if (params.action === 'poll' && params.progressAck !== undefined) {
        if (params.progressAck > session.deliveredCursor) throw new Error('e2ee_acp_invalid_ack');
        if (params.progressAck > session.acknowledgedCursor) {
          session.acknowledgedCursor = params.progressAck;
          while (session.progress[0] && session.progress[0].cursor <= params.progressAck) {
            const removed = session.progress.shift();
            if (removed) session.progressBytes -= removed.bytes;
          }
        }
      }
      if (params.action === 'cancel') stop(session, 'cancelled');
      if (params.action === 'submit') {
        if (
          session.state !== 'running' ||
          !session.recipient ||
          session.start.kind !== 'authenticate' ||
          !session.activated
        )
          throw new Error('e2ee_acp_input_unavailable');
        const fingerprint = createHash('sha256')
          .update(JSON.stringify(params.inputEnvelope))
          .digest('hex');
        if (
          session.consumed.has(fingerprint) ||
          session.submitted.has(params.interactionId) ||
          session.consumed.size >= 128
        )
          throw new Error('e2ee_acp_input_replay');
        // Ciphertext is single-use even on failure. Reserve the interaction while
        // decrypting, but release it if no side effect was invoked.
        session.consumed.add(fingerprint);
        session.submitted.add(params.interactionId);
        let invoked = false;
        try {
          const input = await session.recipient.decrypt(
            params.inputEnvelope,
            e2eeAcpInteractionInputContext({
              workspaceId: options.workspaceId,
              machineId: options.machineId,
              requesterDevice: session.requester,
              interactionRequestId: id,
              interactionId: params.interactionId,
            })
          );
          if (!checkAuthority(session)) throw new Error('e2ee_acp_authority_revoked');
          ensureLive(id, session);
          if (session.state !== 'running' || Buffer.byteLength(input) > 65536)
            throw new Error('e2ee_acp_input_unavailable');
          invoked = true;
          await options.submit({ requestId: id, interactionId: params.interactionId, input });
        } finally {
          if (!invoked) session.submitted.delete(params.interactionId);
        }
      }
      return reply(id, session, context);
    },
    async close(): Promise<void> {
      closed = true;
      for (const timer of tombstones.values()) clearTimeout(timer);
      tombstones.clear();
      const pending: Promise<unknown>[] = [];
      for (const [id, session] of sessions) {
        clearTimeout(session.timer);
        stop(session, 'cancelled');
        if (session.work)
          pending.push(
            session.work.result.catch(() => undefined).finally(() => remove(id, session))
          );
        else if (session.settled) remove(id, session);
      }
      if (pending.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all(pending),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, closeTimeout);
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
    },
  };
}

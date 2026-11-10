import type { z } from 'zod/v4';
import type {
  AgentProviderAuthParams,
  AgentProviderAuthState,
  AgentProviderOperationParams,
  AgentProviderOperationResult,
} from '../contract/provider-details';
import { registryProviderCatalog } from '../protocol/provider-catalog';
import { isSubscriptionQuotaEligible } from '../protocol/subscription-quota';
import {
  readProvider,
  readProviderMachine,
  record,
  type ProviderGrant,
  type ProviderScope,
} from './provider-detail';
import { machineRpc } from './machine-rpc';

type AuthArgs = z.infer<typeof AgentProviderAuthParams>;
type AuthState = z.infer<typeof AgentProviderAuthState>;
type OperationArgs = z.infer<typeof AgentProviderOperationParams>;
type OperationResult = z.infer<typeof AgentProviderOperationResult>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
type MachineScope = Omit<ProviderScope, 'id'> & { id?: string };
const scopeKey = (s: MachineScope) =>
  JSON.stringify([s.workspaceId, s.userId, s.machineId, s.id]);
const terminal = (s: AuthState) =>
  ['authenticated', 'cancelled', 'error'].includes(s.status);
const initial = (flowId: string): AuthState => ({
  flowId,
  status: 'starting',
  methods: [],
  fields: [],
  acceptsAuthorizationCode: false,
  requiresAuthorizationConsent: false,
});
const methods = (v: unknown) =>
  list(v)
    .map(record)
    .filter((m) => m.type === 'agent' && text(m.id))
    .map((m) => ({ id: text(m.id), name: text(m.name) || text(m.id) }));
function safeURL(raw: unknown): string | undefined {
  try {
    const u = new URL(text(raw));
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password)
      return;
    return u.href;
  } catch {
    return;
  }
}

// Browser-only port of loro-streams-rpc/rpc-secret.ts. Keep the exact wire and
// AAD contexts: the independent native graph cannot import its Node root barrel.
async function sealInput(
  keyValue: unknown,
  plaintext: string,
  context: string,
) {
  const key = record(keyValue),
    jwk = record(key.publicKey);
  if (
    key.type !== 'rpc-secret-public-key-v1' ||
    key.algorithm !== 'ECDH-P256-AES-256-GCM' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(text(key.keyId)) ||
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256'
  )
    throw new Error('provider_auth_key_missing');
  const recipient = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: text(jwk.x),
      y: text(jwk.y),
      ext: true,
      key_ops: [],
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey'],
  );
  const shared = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: recipient },
    pair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(
        `lody-machine-rpc-secret-v1\0${key.keyId}\0${context}`,
      ),
    },
    shared,
    new TextEncoder().encode(plaintext),
  );
  const encode = (bytes: Uint8Array) => {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  };
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    type: 'rpc-secret-envelope-v1',
    algorithm: 'ECDH-P256-AES-256-GCM',
    keyId: key.keyId,
    ephemeralPublicKey: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y },
    iv: encode(iv),
    ciphertext: encode(new Uint8Array(ciphertext)),
  };
}

type Flow = {
  scope: ProviderScope;
  agentType: string;
  state: AuthState;
  key?: unknown;
  controller: AbortController;
  busy: boolean;
};
export function createProviderRpc(options: {
  grant: ProviderGrant;
  check: () => void;
  online: (machineId: string) => boolean;
  progress?: (state: AuthState) => void;
  operationProgress?: (event: {
    machineId: string;
    id: string;
    status: string;
    percent?: number;
  }) => void;
}) {
  const flows = new Map<string, Flow>();
  const controllers = new Set<AbortController>();
  const operations = new Map<string, Promise<OperationResult>>();
  let disposed = false;
  let disposal: Promise<{ unconfirmedFlowIds: string[] }> | undefined;
  function check() {
    if (disposed) throw new Error('provider_disposed');
    options.check();
  }
  function publish(flow: Flow, state: AuthState) {
    check();
    if (flow.controller.signal.aborted) return;
    flow.state = state;
    if (
      terminal(state) ||
      (state.status === 'method-required' && !state.interactionId)
    )
      flow.key = undefined;
    options.progress?.(structuredClone(state));
  }
  async function read(args: ProviderScope, signal: AbortSignal) {
    check();
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    controllers.add(controller);
    const timer = setTimeout(abort, 35000);
    try {
      const result = await readProvider(
        args,
        options.grant,
        controller.signal,
        check,
      );
      check();
      controller.signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controllers.delete(controller);
    }
  }
  async function call(
    args: MachineScope,
    method: string,
    params: unknown,
    controller: AbortController,
    timeoutMs: number,
    progress?: (value: unknown) => void,
  ) {
    check();
    controller.signal.throwIfAborted();
    if (!options.online(args.machineId)) throw new Error('machine_unavailable');
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const reply = await machineRpc(
        args.workspaceId,
        args.machineId,
        method,
        params,
        options.grant,
        controller.signal,
        progress,
        timeoutMs,
      );
      check();
      controller.signal.throwIfAborted();
      if (reply.error) throw new Error('provider_rpc_failed');
      return record(reply.result);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }
  function accept(flow: Flow, raw: unknown, final: boolean, requestId: string) {
    const value = record(raw);
    if (
      value.machineId !== flow.scope.machineId ||
      value.agentType !== flow.agentType ||
      value.requestId !== requestId
    )
      throw new Error('provider_response_mismatch');
    if (terminal(flow.state)) return;
    if (final) {
      if (value.type !== 'machine/acp-authenticate_response')
        throw new Error('provider_response_mismatch');
      if (value.disposition === 'input-accepted') return;
      let status: AuthState['status'] = 'error';
      if (
        value.disposition === 'authenticated' &&
        value.success === true &&
        value.authRequired !== true &&
        value.capabilitiesRefreshed !== false
      )
        status = 'authenticated';
      if (
        value.disposition === 'cancelled' ||
        value.disposition === 'not-running'
      )
        status = 'cancelled';
      if (value.disposition === 'method-required') status = 'method-required';
      publish(flow, {
        ...initial(flow.state.flowId),
        status,
        methods: methods(value.authMethods),
        ...(status === 'error'
          ? {
              errorCode:
                value.authRequired === true
                  ? 'provider_auth_required'
                  : 'provider_auth_failed',
            }
          : {}),
      });
      return;
    }
    if (value.type !== 'machine/acp-authentication-progress') return;
    const key =
      value.authenticationInputPublicKey ?? value.authorizationCodePublicKey;
    if (key) flow.key = key;
    if (value.status === 'output' || value.status === 'runtime-download')
      return;
    let status = text(value.status);
    if (status === 'auth-methods') status = 'method-required';
    if (status === 'authenticated') status = 'verifying';
    if (
      ![
        'starting',
        'method-required',
        'authorization',
        'input-required',
        'verifying',
        'cancelled',
        'error',
      ].includes(status)
    )
      return;
    const fields: AuthState['fields'] = list(record(value.form).fields)
      .map(record)
      .filter(
        (f) =>
          text(f.id) && ['text', 'secret', 'select'].includes(text(f.type)),
      )
      .map((f) => ({
        id: text(f.id),
        label: text(f.label),
        type: f.type as 'text' | 'secret' | 'select',
        required: f.required === true,
        options: list(f.options)
          .map(record)
          .map((o) => ({ value: text(o.value), label: text(o.label) })),
      }));
    const url = safeURL(value.authorizationUrl);
    publish(flow, {
      ...initial(flow.state.flowId),
      status: status as AuthState['status'],
      methods: methods(value.authMethods),
      fields,
      ...(text(value.interactionId)
        ? { interactionId: text(value.interactionId) }
        : {}),
      ...(url ? { authorizationUrl: url } : {}),
      ...(text(value.userCode) ? { userCode: text(value.userCode) } : {}),
      acceptsAuthorizationCode: value.acceptsAuthorizationCode === true,
      requiresAuthorizationConsent: value.requiresAuthorizationConsent === true,
      ...(status === 'error' ? { errorCode: 'provider_auth_failed' } : {}),
    });
  }
  async function auth(args: AuthArgs): Promise<AuthState> {
    const controller = new AbortController();
    const { config, protocol } = await read(args, controller.signal);
    if (
      config.cliType !== 'builtin' &&
      Number(protocol.acpProtocolAuthentication ?? 0) < 2
    )
      throw new Error('provider_auth_unsupported');
    const key = scopeKey(args);
    let flow = flows.get(args.flowId);
    if (flow && scopeKey(flow.scope) !== key)
      throw new Error('provider_auth_scope_mismatch');
    if (args.action === 'start') {
      if (flow) return structuredClone(flow.state); // never replay an uncertain start
      if (
        args.methodId &&
        Number(protocol.acpAuthenticationMethodSelection ?? 0) < 1
      )
        throw new Error('provider_auth_method_unsupported');
      if (
        [...flows.values()].some(
          (f) =>
            scopeKey(f.scope) === key &&
            !terminal(f.state) &&
            !(f.state.status === 'method-required' && !f.state.interactionId),
        )
      )
        throw new Error('provider_auth_running');
      if (flows.size >= 32) {
        const old = [...flows.entries()].find(([, f]) => terminal(f.state));
        if (!old) throw new Error('provider_auth_capacity');
        flows.delete(old[0]);
      }
      flow = {
        scope: args,
        agentType: text(config.agentType),
        state: initial(args.flowId),
        controller,
        busy: false,
      };
      flows.set(args.flowId, flow);
      const current = flow;
      // Start stays owned here; native gets an immediate handle and polls or subscribes.
      void call(
        args,
        'machine/acp-authenticate',
        {
          action: 'start',
          requestId: args.flowId,
          configId: args.id,
          ...(args.methodId ? { methodId: args.methodId } : {}),
        },
        controller,
        300000,
        (raw) => accept(current, raw, false, args.flowId),
      )
        .then((result) => accept(current, result, true, args.flowId))
        .catch(() => {
          if (!disposed && !terminal(current.state)) {
            current.key = undefined;
            current.state = {
              ...initial(args.flowId),
              status: 'error',
              errorCode: 'provider_auth_unknown',
            };
            try {
              check();
              options.progress?.(structuredClone(current.state));
            } catch {
              /* stale scope cannot publish */
            }
          }
        });
      return structuredClone(flow.state);
    }
    if (!flow) throw new Error('provider_auth_not_found');
    if (args.action === 'status') return structuredClone(flow.state);
    if (terminal(flow.state)) return structuredClone(flow.state);
    if (flow.busy) throw new Error('provider_auth_busy');
    flow.busy = true;
    try {
      const requestId = crypto.randomUUID();
      const params: Record<string, unknown> = {
        requestId,
        authenticationRequestId: args.flowId,
        action: 'cancel',
      };
      if (args.action === 'submit') {
        if (!flow.key) throw new Error('provider_auth_key_missing');
        if (args.authorizationCode !== undefined) {
          if (!flow.state.acceptsAuthorizationCode)
            throw new Error('provider_auth_code_unsupported');
          params.action = 'submit-code';
          params.authorizationCodeEnvelope = await sealInput(
            flow.key,
            args.authorizationCode,
            `machine/acp-authenticate\0${args.workspaceId}\0${args.machineId}\0${args.flowId}`,
          );
        } else {
          if (Number(protocol.acpAuthenticationInteractions ?? 0) < 2)
            throw new Error('provider_auth_interaction_unsupported');
          if (
            !args.interactionId ||
            args.interactionId !== flow.state.interactionId
          )
            throw new Error('provider_auth_interaction_mismatch');
          params.action = 'submit-input';
          params.interactionId = args.interactionId;
          const input = JSON.stringify({
            action: args.responseAction ?? 'accept',
            ...(args.methodId ? { methodId: args.methodId } : {}),
            ...(args.values ? { content: args.values } : {}),
          });
          params.authenticationInputEnvelope = await sealInput(
            flow.key,
            input,
            `machine/acp-authenticate-input\0${args.workspaceId}\0${args.machineId}\0${args.flowId}\0${args.interactionId}`,
          );
        }
      }
      // Encryption is asynchronous: revalidate ownership immediately before sending.
      await read(args, controller.signal);
      let result;
      try {
        result = await call(
          args,
          'machine/acp-authenticate',
          params,
          controller,
          300000,
        );
      } catch {
        publish(flow, {
          ...initial(args.flowId),
          status: 'error',
          errorCode: 'provider_auth_unknown',
        });
        flow.controller.abort();
        return structuredClone(flow.state);
      }
      accept(flow, result, true, requestId);
      if (
        args.action === 'submit' &&
        result.disposition === 'input-accepted' &&
        args.interactionId === flow.state.interactionId &&
        args.responseAction !== 'decline' &&
        args.responseAction !== 'cancel' &&
        flow.state.requiresAuthorizationConsent
      )
        publish(flow, { ...flow.state, requiresAuthorizationConsent: false });
      if (terminal(flow.state)) flow.controller.abort();
      return structuredClone(flow.state);
    } finally {
      flow.busy = false;
    }
  }
  async function runOperation(args: OperationArgs): Promise<OperationResult> {
    const controller = new AbortController();
    let config: Record<string, unknown>;
    let protocol: Record<string, unknown>;
    let flock: Awaited<ReturnType<typeof readProvider>>['flock'] | undefined;
    if (args.id) {
      ({ config, protocol, flock } = await read(
        { ...args, id: args.id },
        controller.signal,
      ));
    } else {
      if (args.action === 'rate-limits-refresh')
        throw new Error('provider_not_found');
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 35000);
      try {
        ({ protocol } = await readProviderMachine(
          args,
          options.grant,
          controller.signal,
          check,
        ));
        check();
        controller.signal.throwIfAborted();
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
      }
      config = {
        cliType: record(args).cliType,
        agentType: record(args).agentType,
      };
      if (args.action !== 'pi-extension-scan') {
        const knownBuiltin =
          config.cliType === 'builtin' &&
          ['kimi', 'devin', 'grok', 'claude', 'codex', 'pi'].includes(
            text(config.agentType),
          );
        const knownRegistry =
          config.cliType === 'registry' &&
          registryProviderCatalog.some((p) => p.agentType === config.agentType);
        if (!knownBuiltin && !knownRegistry)
          throw new Error('provider_binary_unsupported');
      }
    }
    let method: string,
      params: unknown,
      timeout = 30000;
    switch (args.action) {
      case 'binary-status':
      case 'binary-install':
        method = `machine/acp-${args.action}`;
        params = { agentType: config.agentType };
        if (args.action === 'binary-install') timeout = 300000;
        break;
      case 'pi-extension-scan':
        if (
          (args.id &&
            (config.cliType !== 'builtin' || config.agentType !== 'pi')) ||
          Number(protocol.piExtensions ?? 0) < 1
        )
          throw new Error('provider_pi_extensions_unsupported');
        method = 'machine/pi-extensions';
        params = args.id ? { configId: args.id } : {};
        timeout = 180000;
        break;
      case 'rate-limits-refresh': {
        const capability = record(flock?.get(['acpCapability', args.id]));
        if (
          Number(protocol.providerRateLimitsRefresh ?? 0) < 1 ||
          record(capability.rateLimits).query !== true ||
          !isSubscriptionQuotaEligible(config)
        )
          throw new Error('provider_rate_limits_unsupported');
        method = 'machine/provider-rate-limits-refresh';
        params = { configId: args.id };
        timeout = 60000;
        break;
      }
    }
    let value;
    try {
      value = await call(args, method, params, controller, timeout, (raw) => {
        check();
        if (controller.signal.aborted) return;
        const v = record(raw);
        if (
          !args.id ||
          v.type !== 'machine/acp-binary-progress' ||
          v.machineId !== args.machineId ||
          v.agentType !== config.agentType
        )
          return;
        options.operationProgress?.({
          machineId: args.machineId,
          id: args.id,
          status: text(v.status),
          ...(typeof v.percent === 'number' && Number.isFinite(v.percent)
            ? { percent: Math.max(0, Math.min(100, v.percent)) }
            : {}),
        });
      });
    } catch {
      check();
      return {
        action: args.action,
        success: false,
        errorCode: 'provider_operation_unknown',
      };
    }
    if (args.id) await read({ ...args, id: args.id }, controller.signal);
    else check();
    if (
      args.action !== 'pi-extension-scan' &&
      value.type !== `${method}_response`
    )
      throw new Error('provider_response_mismatch');
    if (
      args.action !== 'pi-extension-scan' &&
      (value.machineId !== args.machineId ||
        (args.action === 'rate-limits-refresh'
          ? value.configId !== args.id
          : value.agentType !== config.agentType))
    )
      throw new Error('provider_response_mismatch');
    const result: OperationResult = {
      action: args.action,
      success: value.success === true,
      ...(value.success !== true
        ? { errorCode: 'provider_operation_failed' }
        : {}),
    };
    if (args.action === 'binary-status') {
      if (
        ![
          'installed',
          'not-applicable',
          'not-installed',
          'unsupported-platform',
          'incompatible-host',
          'error',
        ].includes(text(value.status))
      )
        throw new Error('provider_response_mismatch');
      result.status = value.status as OperationResult['status'];
    }
    if (args.action === 'binary-install' && result.success)
      result.status = 'installed';
    for (const name of ['version', 'current', 'required'] as const)
      if (typeof value[name] === 'string') result[name] = value[name];
    if (args.action === 'pi-extension-scan')
      result.extensions = list(record(value.discovery).extensions)
        .map(record)
        .filter((e) => text(e.path))
        .map((e) => ({
          path: text(e.path),
          name: text(e.name),
          source: text(e.source),
        }));
    return result;
  }
  async function operation(args: OperationArgs): Promise<OperationResult> {
    check();
    const key = JSON.stringify([
      scopeKey(args),
      args.action,
      record(args).cliType,
      record(args).agentType,
    ]);
    const existing = operations.get(key);
    if (existing) {
      if (args.id)
        await read({ ...args, id: args.id }, new AbortController().signal);
      else check();
      return existing;
    }
    const task = runOperation(args);
    operations.set(key, task);
    try {
      return await task;
    } finally {
      if (operations.get(key) === task) operations.delete(key);
    }
  }
  return {
    auth,
    operation,
    dispose() {
      if (disposal) return disposal;
      const pending = [...flows.values()].filter(
        (flow) =>
          !['authenticated', 'cancelled'].includes(flow.state.status) &&
          !(
            flow.state.status === 'method-required' && !flow.state.interactionId
          ),
      );
      disposed = true;
      for (const controller of controllers) controller.abort();
      for (const flow of flows.values()) {
        flow.key = undefined;
        flow.controller.abort();
      }
      controllers.clear();
      flows.clear();
      operations.clear();
      const cleanup = new AbortController();
      const unconfirmed = new Set(pending.map((flow) => flow.state.flowId));
      // Cleanup retains only the original scope's authority. A changed identity
      // rejects cancellation; it never borrows the replacement account's grant.
      const checkCleanup = () => {
        cleanup.signal.throwIfAborted();
        options.check();
      };
      const cleanupGrant: ProviderGrant = async () => {
        checkCleanup();
        const grant = await options.grant();
        checkCleanup();
        return grant;
      };
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          cleanup.abort();
          resolve();
        }, 10000);
      });
      const work = Promise.allSettled(
        pending.map(async (flow) => {
          checkCleanup();
          await readProvider(
            flow.scope,
            cleanupGrant,
            cleanup.signal,
            checkCleanup,
          );
          checkCleanup();
          if (!options.online(flow.scope.machineId)) return;
          const requestId = crypto.randomUUID();
          const reply = await machineRpc(
            flow.scope.workspaceId,
            flow.scope.machineId,
            'machine/acp-authenticate',
            {
              action: 'cancel',
              requestId,
              authenticationRequestId: flow.state.flowId,
            },
            cleanupGrant,
            cleanup.signal,
            undefined,
            10000,
          );
          checkCleanup();
          const value = record(reply.result);
          if (
            !reply.error &&
            value.type === 'machine/acp-authenticate_response' &&
            value.machineId === flow.scope.machineId &&
            value.agentType === flow.agentType &&
            value.requestId === requestId &&
            ['cancelled', 'not-running'].includes(text(value.disposition))
          )
            unconfirmed.delete(flow.state.flowId);
        }),
      );
      disposal = Promise.race([work, deadline]).then(() => {
        clearTimeout(timer);
        cleanup.abort();
        return { unconfirmedFlowIds: [...unconfirmed] };
      });
      return disposal;
    },
  };
}

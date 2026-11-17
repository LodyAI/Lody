import type { PostHog } from 'posthog-js';
import { redactedTelemetryException } from '@lody/platform/telemetry';

type Event = {
  event: string;
  properties?: Record<string, unknown>;
  uuid?: string;
  timestamp?: unknown;
};

const REDACTED_CAPABILITY = '[redacted_installation_capability]';

function decodedCapabilityText(value: string): string {
  let decoded = value;
  // Decode delimiters even if an unrelated malformed escape is present.
  for (let i = 0; i < 8; i++) {
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    );
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function hasInstallationCapability(value: string): boolean {
  return /(?:^|[?&#;=\s])(?:state|github[-_]install[-_]retry)\s*=/i.test(
    decodedCapabilityText(value)
  );
}

/** Replay URL metadata is masked before SDK compression; keep unrelated query data. */
export function sanitizePostHogCapabilityUrl(value: string): string {
  if (!hasInstallationCapability(value)) return value;
  try {
    const url = new URL(value);
    for (const [key, entry] of [...url.searchParams]) {
      if (
        /^(?:state|github[-_]install[-_]retry)$/i.test(decodedCapabilityText(key)) ||
        hasInstallationCapability(key) ||
        hasInstallationCapability(entry)
      )
        url.searchParams.delete(key);
    }
    if (hasInstallationCapability(url.hash)) url.hash = '';
    const result = url.toString();
    return hasInstallationCapability(result) ? REDACTED_CAPABILITY : result;
  } catch {
    return REDACTED_CAPABILITY;
  }
}

function sanitizeCapabilityValues(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return sanitizePostHogCapabilityUrl(value);
  if (!value || typeof value !== 'object') return value;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return value;
  if (seen.has(value)) return REDACTED_CAPABILITY;
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => sanitizeCapabilityValues(entry, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      /^github[-_]install[-_]retry$/i.test(decodedCapabilityText(key)) ||
      hasInstallationCapability(key)
    )
      continue;
    result[key] = sanitizeCapabilityValues(entry, seen);
  }
  seen.delete(value);
  return result;
}

function sanitizeEventCapabilities(event: Event): Event {
  if (event.properties)
    event.properties = sanitizeCapabilityValues(event.properties) as Record<string, unknown>;
  return event;
}

/** Keep the internal SDK boundary here. The real-SDK browser regression pins
 * discard, batching, retries, unload and synchronous transport encoding. */
export function createPostHogPrivacy(readScope: () => string | null) {
  let scope: string | null = null;
  let generation = 0;
  let transitioning = false;
  let sdk: PostHog | undefined;
  let canDiscard = true;
  const configHandlers = new WeakMap<
    object,
    NonNullable<PostHog['sessionRecording']>['onRemoteConfig']
  >();
  let remoteConfig:
    | Parameters<NonNullable<PostHog['sessionRecording']>['onRemoteConfig']>[0]
    | undefined;
  const generations = new WeakMap<object, number>();

  const allowed = () => !transitioning && scope !== null && readScope() === scope;
  const redact = (event: Event): Event => ({
    event: '$exception',
    ...(typeof event.uuid === 'string' ? { uuid: event.uuid } : {}),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    properties: {
      // SDK routing/identity fields are the only non-diagnostic fields retained.
      token: event.properties?.token,
      distinct_id: event.properties?.distinct_id,
      ...redactedTelemetryException(event.properties),
    },
  });

  function sync(force = false): void {
    const next = readScope();
    if (!force && scope === next) return;
    transitioning = true;
    scope = null;
    generation += 1;
    if (sdk?.__loaded) {
      const recorder = sdk.sessionRecording;
      canDiscard = typeof recorder?.onRemoteConfig === 'function';
      if (recorder && canDiscard) {
        if (!configHandlers.has(recorder)) {
          const onConfig = recorder.onRemoteConfig.bind(recorder);
          recorder.onRemoteConfig = (response) => {
            if ('sessionRecording' in response) remoteConfig = response;
            if (allowed()) onConfig(response);
            else {
              onConfig({
                sessionRecording: false,
                supportedCompression: [],
                toolbarParams: {},
                toolbarVersion: 'toolbar',
                isAuthenticated: false,
                siteApps: [],
              });
              sdk!.unregister('$session_recording_remote_config');
            }
          };
          configHandlers.set(recorder, onConfig);
        }
        // This SDK's supported remote-disable path discards recording buffers
        // and invalidates in-flight event compression. Stop alone flushes them.
        configHandlers.get(recorder)!({
          sessionRecording: false,
          supportedCompression: [],
          toolbarParams: {},
          toolbarVersion: 'toolbar',
          isAuthenticated: false,
          siteApps: [],
        });
        // The remote-disable response leaves a truthy disabled cache object.
        // Removing it also makes an already-loading recorder refuse to start.
        sdk.unregister('$session_recording_remote_config');
      }
      sdk.stopSessionRecording();
    }
    scope = next;
    transitioning = false;
    if (sdk?.__loaded && scope !== null && canDiscard) {
      if (remoteConfig) sdk.sessionRecording?.onRemoteConfig(remoteConfig);
      sdk.startSessionRecording();
    }
  }

  return {
    sync,
    isAllowed: allowed,
    beforeSend(event: Event): Event | null {
      sync();
      if (event.event === '$snapshot') {
        if (!allowed() || !canDiscard) return null;
        generations.set(event, generation);
      } else if (event.event === '$exception') {
        const deferredGeneration = event.properties?.__lody_exception_generation;
        if (!allowed() || (deferredGeneration !== undefined && deferredGeneration !== generation)) {
          event = redact(event);
        } else if (event.properties) {
          delete event.properties.__lody_exception_generation;
        }
        generations.set(event, generation);
      }
      return sanitizeEventCapabilities(event);
    },
    attach(client: PostHog) {
      if (sdk) return;
      sdk = client;
      const send = client._send_request.bind(client);
      client._send_request = (options) => {
        sync();
        let sensitive = false;
        const filter = (data: unknown): unknown => {
          if (!data || typeof data !== 'object' || !('event' in data)) return data;
          const event = data as Event;
          if (event.event === '$snapshot') {
            sensitive = true;
            return allowed() && canDiscard && generations.get(event) === generation
              ? sanitizeEventCapabilities(event)
              : null;
          }
          if (event.event === '$exception') {
            sensitive = true;
            return allowed() && generations.get(event) === generation
              ? sanitizeEventCapabilities(event)
              : redact(event);
          }
          return sanitizeEventCapabilities(event);
        };
        const data = Array.isArray(options.data)
          ? options.data.map(filter).filter((event) => event !== null)
          : filter(options.data);
        if (data === null || (Array.isArray(data) && data.length === 0)) {
          // A discarded event is terminal, including a queued network retry.
          options.callback?.({ statusCode: 200 });
          return;
        }
        // Native gzip yields AFTER serializing the body. Use the SDK's synchronous
        // encoder here so a later workspace switch cannot race an already encoded
        // sensitive body waiting to enter fetch/XHR/sendBeacon.
        send({
          ...options,
          data: data as typeof options.data,
          ...(sensitive ? { compression: undefined } : {}),
        });
      };
      sync(true);
    },
    prepareException(args: unknown[]): unknown[] {
      sync();
      const supplied = args[1];
      const properties =
        supplied && typeof supplied === 'object' ? (supplied as Record<string, unknown>) : {};
      if (allowed())
        return [
          args[0],
          { ...properties, __lody_exception_generation: generation },
          ...args.slice(2),
        ];
      const error = new Error('redacted_exception');
      error.stack = undefined;
      return [
        error,
        { ...redactedTelemetryException(properties), __lody_exception_generation: generation },
      ];
    },
  };
}

let readWorkspaceScope: () => string | null = () => null;
let routeTarget: string | null | undefined;
let routeCommitted = false;
let routeRevision = 0;
const privateSurfaces = new Set<object>();
export const postHogPrivacy = createPostHogPrivacy(() =>
  routeCommitted && privateSurfaces.size === 0 ? readWorkspaceScope() : null
);

export function getTelemetryRouteTarget(): string | null | undefined {
  return routeTarget;
}

export function setTelemetryRouteTarget(slug: string | null, committed: boolean): void {
  routeRevision += 1;
  if (routeTarget !== slug) routeCommitted = false;
  routeTarget = slug;
  if (committed) routeCommitted = true;
  postHogPrivacy.sync();
}

/** Private overlays can appear above an ordinary workspace. Each mounted surface
 * owns a lease; a route commit or another surface's release cannot revive capture. */
export function holdPrivateTelemetrySurface(): () => void {
  const owner = {};
  privateSurfaces.add(owner);
  postHogPrivacy.sync();
  return () => {
    if (privateSurfaces.delete(owner)) postHogPrivacy.sync();
  };
}

export function suspendWorkspaceTelemetry(): () => void {
  const revision = ++routeRevision;
  routeCommitted = false;
  postHogPrivacy.sync();
  return () => {
    if (routeRevision !== revision) return;
    routeCommitted = true;
    postHogPrivacy.sync();
  };
}

export function installWorkspaceTelemetryScope(read: () => string | null): () => void {
  readWorkspaceScope = read;
  postHogPrivacy.sync();
  return () => {
    if (readWorkspaceScope !== read) return;
    readWorkspaceScope = () => null;
    postHogPrivacy.sync();
  };
}

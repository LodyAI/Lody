import type { PostHog } from 'posthog-js';
import { redactedTelemetryException } from '@lody/platform/telemetry';

type Event = {
  event: string;
  properties?: Record<string, unknown>;
  uuid?: string;
  timestamp?: unknown;
};

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
      return event;
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
            return allowed() && canDiscard && generations.get(event) === generation ? event : null;
          }
          if (event.event === '$exception') {
            sensitive = true;
            return allowed() && generations.get(event) === generation ? event : redact(event);
          }
          return event;
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
export const postHogPrivacy = createPostHogPrivacy(() =>
  routeCommitted ? readWorkspaceScope() : null
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

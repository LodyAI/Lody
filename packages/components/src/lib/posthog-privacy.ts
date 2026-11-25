import { usageSharingAllowed, usageSharingSince } from './usage-sharing';
import {
  isAgentProviderTelemetryEvent,
  isPostHogProductEvent,
  isTelemetryCliType,
  isTelemetryNativePlatform,
  isTelemetryPlatform,
  normalizeTelemetryAgentType,
} from '@lody/shared/analytics';
import type { PostHog } from 'posthog-js';
import { redactedTelemetryException } from '@lody/platform/telemetry';
import { detectTelemetryPlatform } from './posthog-analytics';

type Event = {
  event: string;
  properties?: Record<string, unknown>;
  uuid?: string;
  timestamp?: unknown;
  offset?: number;
};

// Minimal PostHog SDK/device fields required for ingestion and coarse platform/OS breakdown.
// Never forward arbitrary $-prefixed fields (URLs, titles, element text, workspace groups,
// screen/viewport/timezone fingerprints, legacy person updates, or replay/network payloads).
const sdkFields = new Set([
  'token',
  'distinct_id',
  '$anon_distinct_id',
  '$device_id',
  '$user_id',
  '$session_id',
  '$window_id',
  '$is_identified',
  '$process_person_profile',
  '$lib',
  '$lib_version',
  '$device_type',
  '$os',
  '$os_version',
]);

function projectEvent(event: Event): Event | null {
  if (!usageSharingAllowed()) return null;
  if (
    !isPostHogProductEvent(event.event) &&
    event.event !== '$identify' &&
    event.event !== '$exception'
  ) {
    return null;
  }
  const distinctId = event.properties?.distinct_id;
  const validId = (value: unknown) =>
    typeof value === 'string' && /^(?:\$device:)?[a-zA-Z0-9_-]{1,128}$/.test(value);
  if (distinctId !== undefined && !validId(distinctId)) return null;
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.properties ?? {})) {
    if (
      ['$anon_distinct_id', '$user_id', '$device_id', '$session_id', '$window_id'].includes(key) &&
      !validId(value)
    )
      continue;
    if (
      (sdkFields.has(key) ||
        (key === 'user_id' && typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value))) &&
      (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
    ) {
      properties[key] = value;
    }
  }

  // Always attach coarse platform distribution ('web' | 'electron' | 'mobile' | 'cli').
  const detectedPlatform = detectTelemetryPlatform();
  properties.platform = isTelemetryPlatform(event.properties?.platform)
    ? event.properties.platform
    : detectedPlatform.platform;
  const nativePlatform = isTelemetryNativePlatform(event.properties?.native_platform)
    ? event.properties.native_platform
    : detectedPlatform.native_platform;
  if (properties.platform === 'mobile' && nativePlatform) {
    properties.native_platform = nativePlatform;
  }

  if (isAgentProviderTelemetryEvent(event.event)) {
    if (isTelemetryCliType(event.properties?.cli_type)) {
      properties.cli_type = event.properties.cli_type;
    }
    const agentType = normalizeTelemetryAgentType(event.properties?.agent_type);
    if (agentType !== undefined) {
      properties.agent_type = agentType;
    }
  }

  if (event.event === 'auth/oauth_returned') {
    if (typeof event.properties?.is_new_user === 'boolean') {
      properties.is_new_user = event.properties.is_new_user;
    }
    if (event.properties?.outcome === 'success' || event.properties?.outcome === 'failed') {
      properties.outcome = event.properties.outcome;
    }
  }

  if (event.event === '$exception') {
    const first = event.properties?.$exception_list;
    const existing = Array.isArray(first) ? first[0]?.value : undefined;
    properties.$exception_list = redactedTelemetryException({
      ...event.properties,
      error_code: event.properties?.error_code ?? existing,
    }).$exception_list;
  }
  return {
    event: event.event,
    uuid:
      typeof event.uuid === 'string' &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(event.uuid)
        ? event.uuid
        : undefined,
    timestamp:
      event.timestamp instanceof Date ||
      (typeof event.timestamp === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(event.timestamp))
        ? event.timestamp
        : undefined,
    ...(typeof event.offset === 'number' ? { offset: event.offset } : {}),
    properties,
  };
}

export function createPostHogPrivacy(readScope: () => string | null) {
  let attached: PostHog | undefined;
  const eventRevisions = new WeakMap<object, number>();
  return {
    isAllowed: () => readScope() !== null,
    beforeSend(event: Event) {
      const projected = projectEvent(event);
      if (projected) eventRevisions.set(projected, usageSharingSince());
      return projected;
    },
    attach(client: PostHog) {
      if (attached === client) return;
      attached = client;
      const send = client._send_request.bind(client);
      client._send_request = (options) => {
        const revision = usageSharingSince();
        const filter = (data: unknown) => {
          if (!data || typeof data !== 'object' || !('event' in data)) return null;
          const captured = data as Event;
          const previous = eventRevisions.get(data);
          if (previous !== undefined && previous !== revision) return null;
          if (revision && previous === undefined) {
            const time =
              typeof captured.offset === 'number'
                ? Date.now() - captured.offset
                : new Date(captured.timestamp as string).getTime();
            if (!Number.isFinite(time) || time < revision) return null;
          }
          const projected = projectEvent(captured);
          if (projected) eventRevisions.set(projected, revision);
          return projected;
        };
        const data = Array.isArray(options.data)
          ? options.data.map(filter).filter((event) => event !== null)
          : filter(options.data);
        if (data === null || (Array.isArray(data) && !data.length)) {
          options.callback?.({ statusCode: 200 });
          return;
        }
        send({ ...options, data: data as typeof options.data });
      };
    },
    prepareException(args: unknown[]) {
      const properties = args[1] && typeof args[1] === 'object' ? args[1] : {};
      const diagnostic = redactedTelemetryException(properties as Record<string, unknown>, args[0]);
      const error = new Error('redacted_exception');
      error.stack = undefined;
      return [error, diagnostic];
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
}

/** Private overlays can appear above an ordinary workspace. Each mounted surface
 * owns a lease; a route commit or another surface's release cannot revive capture. */
export function holdPrivateTelemetrySurface(): () => void {
  const owner = {};
  privateSurfaces.add(owner);
  return () => {
    privateSurfaces.delete(owner);
  };
}

export function suspendWorkspaceTelemetry(): () => void {
  const revision = ++routeRevision;
  routeCommitted = false;
  return () => {
    if (routeRevision !== revision) return;
    routeCommitted = true;
  };
}

export function installWorkspaceTelemetryScope(read: () => string | null): () => void {
  readWorkspaceScope = read;
  return () => {
    if (readWorkspaceScope !== read) return;
    readWorkspaceScope = () => null;
  };
}

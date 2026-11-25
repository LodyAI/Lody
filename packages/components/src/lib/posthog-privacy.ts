import { usageSharingAllowed, usageSharingSince } from './usage-sharing';
import { isPostHogProductEvent } from '@lody/shared/analytics';
import type { PostHog } from 'posthog-js';
import { redactedTelemetryException } from '@lody/platform/telemetry';

type Event = {
  event: string;
  properties?: Record<string, unknown>;
  uuid?: string;
  timestamp?: unknown;
  offset?: number;
};

// These PostHog properties describe the SDK, device and analytics session.
// Never forward arbitrary $-prefixed fields: they include URLs, element text,
// workspace groups, legacy person updates and replay/network payloads.
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
  '$browser',
  '$browser_version',
  '$browser_language',
  '$browser_language_prefix',
  '$device_type',
  '$device',
  '$device_model',
  '$os',
  '$os_version',
  '$screen_width',
  '$screen_height',
  '$viewport_width',
  '$viewport_height',
  '$timezone',
  '$timezone_offset',
  '$geoip_disable',
]);

function projectEvent(event: Event): Event | null {
  if (!usageSharingAllowed()) return null;
  if (
    !isPostHogProductEvent(event.event) &&
    !['$identify', '$exception', '$pageview', '$pageleave'].includes(event.event)
  )
    return null;
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

import { createIrohDaily } from '../src/lib/iroh-daily';
import { POSTHOG_OPTIONS } from '../src/providers/posthog-options';
import { logTokenProviderEvent } from '../src/providers/loro-streams-token-diagnostics';
import {
  postHogPrivacy,
  installWorkspaceTelemetryScope,
  setTelemetryRouteTarget,
  suspendWorkspaceTelemetry,
} from '../src/lib/posthog-privacy';
Object.assign(window, {
  POSTHOG_OPTIONS,
  logTokenProviderEvent,
  createIrohDaily,
  postHogPrivacy,
  installWorkspaceTelemetryScope,
  setTelemetryRouteTarget,
  suspendWorkspaceTelemetry,
});

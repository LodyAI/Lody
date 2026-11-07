import { POSTHOG_OPTIONS } from '../src/providers/posthog-options';
import {
  postHogPrivacy,
  installWorkspaceTelemetryScope,
  setTelemetryRouteTarget,
  suspendWorkspaceTelemetry,
} from '../src/lib/posthog-privacy';
Object.assign(window, {
  POSTHOG_OPTIONS,
  postHogPrivacy,
  installWorkspaceTelemetryScope,
  setTelemetryRouteTarget,
  suspendWorkspaceTelemetry,
});

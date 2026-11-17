import { ShortcutTokenAttempts, shortcutTokenDiagnostic } from '../src/lib/shortcut-token-attempt';
import { createIrohDaily } from '../src/lib/iroh-daily';
import { POSTHOG_OPTIONS } from '../src/providers/posthog-options';
import {
  postHogPrivacy,
  installWorkspaceTelemetryScope,
  setTelemetryRouteTarget,
  suspendWorkspaceTelemetry,
} from '../src/lib/posthog-privacy';
Object.assign(window, {
  POSTHOG_OPTIONS,
  ShortcutTokenAttempts,
  shortcutTokenDiagnostic,
  createIrohDaily,
  postHogPrivacy,
  installWorkspaceTelemetryScope,
  setTelemetryRouteTarget,
  suspendWorkspaceTelemetry,
});

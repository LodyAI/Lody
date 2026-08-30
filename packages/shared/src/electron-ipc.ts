import { z } from 'zod';
import type {
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  LocalSessionControlRequest,
  LocalSessionControlResponse,
} from './message';
import type {
  LocalLoroDataPlaneClientMessage,
  LocalLoroDataPlaneServerMessage,
} from './local-loro-data-plane';
import type { SessionFilePayload } from './ai';
import type {
  LocalMachineRpcRequest as LocalMachineRpcRequestFromModule,
  LocalMachineRpcResponse as LocalMachineRpcResponseFromModule,
} from './local-machine-rpc';

export type CliOutputEvent = {
  runId: string;
  stream: 'stdout' | 'stderr' | 'meta';
  chunk: string;
};

export type RendererFatalErrorReport = {
  scope: string;
  message: string;
  details: string;
  copied?: boolean;
};

export type WindowBadgeInput = { unread: number; waiting: number };

export type SessionControlSendInput = {
  requestId: string;
  message: LocalSessionControlRequest;
};

export type NativeThemeSource = 'dark' | 'light' | 'system';

export type OpenSystemNotificationSettingsResult = {
  opened: boolean;
  platform: string;
  target?: string;
  error?: string;
};

export type OpenExternalUrlResult = {
  opened: boolean;
  url?: string;
  error?: string;
};

export type DesktopOnboardingCompleteResult =
  | { ok: true }
  | { ok: false; error: 'untrusted_sender' | 'completion_failed'; message?: string };

export const ElectronPublicBrowserBoundsSchema = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();

export type ElectronPublicBrowserBounds = z.infer<typeof ElectronPublicBrowserBoundsSchema>;

export const ElectronPublicBrowserCreateInputSchema = z
  .object({
    browserId: z.string().trim().min(1).max(200),
    bounds: ElectronPublicBrowserBoundsSchema,
  })
  .strict();

export const ElectronPublicBrowserNavigateInputSchema = z
  .object({
    browserId: z.string().trim().min(1).max(200),
    url: z.string().trim().min(1).max(16_384),
  })
  .strict();

export const ElectronPublicBrowserIdInputSchema = z
  .object({ browserId: z.string().trim().min(1).max(200) })
  .strict();

export const ElectronPublicBrowserBoundsInputSchema = ElectronPublicBrowserIdInputSchema.extend({
  bounds: ElectronPublicBrowserBoundsSchema,
}).strict();

export const ElectronPublicBrowserVisibilityInputSchema = ElectronPublicBrowserIdInputSchema.extend(
  { visible: z.boolean() }
).strict();

export type ElectronPublicBrowserCreateInput = z.infer<
  typeof ElectronPublicBrowserCreateInputSchema
>;
export type ElectronPublicBrowserNavigateInput = z.infer<
  typeof ElectronPublicBrowserNavigateInputSchema
>;
export type ElectronPublicBrowserIdInput = z.infer<typeof ElectronPublicBrowserIdInputSchema>;
export type ElectronPublicBrowserBoundsInput = z.infer<
  typeof ElectronPublicBrowserBoundsInputSchema
>;
export type ElectronPublicBrowserVisibilityInput = z.infer<
  typeof ElectronPublicBrowserVisibilityInputSchema
>;

export type ElectronPublicBrowserPhase = 'idle' | 'loading' | 'ready' | 'error' | 'crashed';

export type ElectronPublicBrowserState = {
  browserId: string;
  phase: ElectronPublicBrowserPhase;
  url?: string;
  title?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
  blockedUrl?: string;
};

export type ElectronPublicBrowserResult =
  | { ok: true; state: ElectronPublicBrowserState }
  | { ok: false; error: string };

export const ELECTRON_PUBLIC_BROWSER_STATE_CHANNEL = 'publicBrowser.state';

const LocalPathLauncherStringSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim().length > 0, 'Blank strings are not allowed')
  .refine((value) => !value.includes('\0'), 'NUL bytes are not allowed');

export const LocalPathCommandSpecSchema = z
  .object({
    command: LocalPathLauncherStringSchema,
    args: z.array(LocalPathLauncherStringSchema).max(64).optional(),
  })
  .strict();

export type LocalPathCommandSpec = z.infer<typeof LocalPathCommandSpecSchema>;

export const LaunchLocalPathInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('url'),
      url: LocalPathLauncherStringSchema,
      targetPath: LocalPathLauncherStringSchema,
      label: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('command'),
      command: LocalPathCommandSpecSchema,
      fallbackCommands: z.array(LocalPathCommandSpecSchema).max(3).optional(),
      fallbackUrl: LocalPathLauncherStringSchema.optional(),
      targetPath: LocalPathLauncherStringSchema,
      label: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
]);

export type LaunchLocalPathInput = z.infer<typeof LaunchLocalPathInputSchema>;

export const PathLauncherProbeSchema = z
  .object({
    launchers: z
      .array(
        z
          .object({
            launcherId: z.string().trim().min(1).max(200),
            input: LaunchLocalPathInputSchema,
          })
          .strict()
      )
      .max(30),
  })
  .strict();

export type LaunchLocalPathResult =
  | {
      launched: true;
      method: 'url';
      url: string;
    }
  | {
      launched: true;
      method: 'command';
      command: string;
    }
  | {
      launched: false;
      method?: 'url' | 'command';
      url?: string;
      command?: string;
      error: string;
    };

export type ShowSessionCompletionNotificationInput = {
  sessionId: string;
  workspaceSlug?: string;
  title: string;
  body: string;
};

export type ShowSessionCompletionNotificationResult = {
  shown: boolean;
  reason?: string;
};

export const CliRuntimePhaseSchema = z.enum([
  'starting',
  'running',
  'degraded',
  'offline',
  'fatal',
]);

export type CliRuntimePhase = z.infer<typeof CliRuntimePhaseSchema>;

export const CliRuntimeStartupStageSchema = z.enum([
  'bootstrap',
  'auth',
  'sync-time',
  'fleet-start',
  'ready',
]);

export type CliRuntimeStartupStage = z.infer<typeof CliRuntimeStartupStageSchema>;

export const CliRuntimeConnectivitySchema = z.enum(['online', 'reconnecting', 'offline']);

export type CliRuntimeConnectivity = z.infer<typeof CliRuntimeConnectivitySchema>;

export const CliBackendAuthorizationSchema = z.enum(['pending', 'authorized', 'rejected']);

export type CliBackendAuthorization = z.infer<typeof CliBackendAuthorizationSchema>;

export const CliBackendConnectionSchema = z.enum(['connecting', 'connected', 'disconnected']);

export type CliBackendConnection = z.infer<typeof CliBackendConnectionSchema>;

export const CliWorkspaceBackendConnectionSchema = z.enum([
  'connected',
  'reconnecting',
  'disconnected',
]);

export type CliWorkspaceBackendConnection = z.infer<typeof CliWorkspaceBackendConnectionSchema>;

export const CliRuntimeWorkspaceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().nullable(),
    role: z.string().min(1),
    backendConnection: CliWorkspaceBackendConnectionSchema,
  })
  .strict();

export type CliRuntimeWorkspace = z.infer<typeof CliRuntimeWorkspaceSchema>;

export const CliRuntimeIssueSeveritySchema = z.enum(['warning', 'error', 'fatal']);

export type CliRuntimeIssueSeverity = z.infer<typeof CliRuntimeIssueSeveritySchema>;

export const CliRuntimeIssueSchema = z
  .object({
    id: z.string().min(1),
    code: z.string().min(1),
    severity: CliRuntimeIssueSeveritySchema,
    recoverable: z.boolean(),
    message: z.string(),
    firstSeenAtMs: z.number(),
    lastSeenAtMs: z.number(),
    count: z.number().int().nonnegative(),
  })
  .passthrough();

export type CliRuntimeIssue = z.infer<typeof CliRuntimeIssueSchema>;

export const CliRuntimeStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    phase: CliRuntimePhaseSchema,
    startupStage: CliRuntimeStartupStageSchema.optional(),
    connectivity: CliRuntimeConnectivitySchema.optional(),
    backend: z
      .object({
        authorization: CliBackendAuthorizationSchema,
        connection: CliBackendConnectionSchema,
      })
      .strict()
      .optional(),
    connectedWorkspaces: z.array(CliRuntimeWorkspaceSchema).optional(),
    machineId: z.string().min(1).optional(),
    pid: z.number().int(),
    updatedAtMs: z.number(),
    issues: z.array(CliRuntimeIssueSchema),
    activeSessionCount: z.number().int().nonnegative().optional(),
    connectedRoomCount: z.number().int().nonnegative().optional(),
    supervisor: z
      .object({
        instanceId: z.string().min(1),
        pid: z.number().int().positive(),
        launchMode: z.enum(['daemon', 'electron']),
      })
      .strict()
      .optional(),
  })
  .passthrough();

export type CliRuntimeState = z.infer<typeof CliRuntimeStateSchema>;

export type ElectronCliPhase = CliRuntimePhase | 'reconnecting' | 'stopping' | 'stopped';

export type ElectronCliState = {
  phase: ElectronCliPhase;
  desiredState: 'running' | 'stopped';
  /** Whether this desktop should run and use a local agent runtime. */
  localAgentEnabled: boolean;
  updatedAtMs: number;
  preventSleepEnabled: boolean;
  startupStage?: CliRuntimeStartupStage;
  connectivity?: CliRuntimeConnectivity;
  runtime?: CliRuntimeState;
  runtimeOwnership?: 'owned' | 'external';
  message?: string;
  retryAttempt?: number;
  retryInMs?: number;
  lastExitCode?: number | null;
  lastExitAtMs?: number;
};

export type RestartCliResult = {
  ok: boolean;
  error?: string;
};

export type TerminateCliResult = {
  ok: boolean;
  error?: string;
};

const ElectronAuthCallbackTokenSchema = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => !value.includes('\0'), 'NUL bytes are not allowed');

export const ElectronAuthCallbackInputSchema = z
  .object({
    token: ElectronAuthCallbackTokenSchema,
  })
  .strict();

export type ElectronAuthCallbackInput = z.infer<typeof ElectronAuthCallbackInputSchema>;

export const ElectronDevEmailPasswordSignInInputSchema = z
  .object({
    email: z.string().trim().email().max(320),
    password: z.string().min(1).max(1024),
    rememberMe: z.literal(true),
  })
  .strict();

export type ElectronDevEmailPasswordSignInInput = z.infer<
  typeof ElectronDevEmailPasswordSignInInputSchema
>;

export function isDevEmailPasswordLoginEnabled(input: { isPackaged: boolean }): boolean {
  return !input.isPackaged;
}

export const ElectronAuthCallbackSessionSchema = z
  .object({
    session: z
      .object({
        token: z.string().min(1),
      })
      .passthrough(),
    user: z
      .object({
        id: z.string().min(1),
      })
      .passthrough(),
  })
  .strict();

export type ElectronAuthCallbackSession = z.infer<typeof ElectronAuthCallbackSessionSchema>;

export type ElectronUpdaterPhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'downloaded'
  | 'up_to_date'
  | 'error'
  | 'disabled';

export type ElectronUpdaterState = {
  phase: ElectronUpdaterPhase;
  currentVersion: string;
  availableVersion?: string;
  downloadedVersion?: string;
  releaseName?: string;
  releaseDate?: string;
  releaseNotes?: string;
  /**
   * Release notes per UI language, so the renderer can show the changelog in
   * the language the user picked instead of the single publisher-provided
   * `releaseNotes` blob. Optional: a build whose main process does not publish
   * localized notes keeps falling back to `releaseNotes`.
   */
  releaseNotesByLocale?: {
    en?: string;
    zh_CN?: string;
  };
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  checkedAtMs?: number;
  error?: string;
  disabledReason?: string;
};

export type CheckForElectronUpdateResult = {
  started: boolean;
  error?: string;
};

export type QuitAndInstallElectronUpdateResult = {
  ok: boolean;
  error?: string;
};

export type NotificationPermissionState = 'default' | 'denied' | 'granted';

export type GetNotificationPermissionStatusResult = {
  supported: boolean;
  permission: NotificationPermissionState;
  source?: 'system' | 'renderer';
  error?: string;
};

export type ElectronAutoLaunchStatusResult = {
  supported: boolean;
  enabled: boolean;
  openAtLogin?: boolean;
  openAsHidden?: boolean;
  error?: string;
};

export type SetElectronAutoLaunchResult = {
  ok: boolean;
  supported: boolean;
  enabled: boolean;
  error?: string;
};

export type SessionCompletionNotificationClickPayload = {
  sessionId: string;
  workspaceSlug?: string;
};

export type SendLocalSessionControlResult =
  | {
      ok: true;
      responses: LocalSessionControlResponse[];
    }
  | {
      ok: false;
      error: string;
    };

export const ELECTRON_LOCAL_SESSION_CONTROL_RESPONSE_CHANNEL = 'sessionControl.response' as const;

export type ElectronLocalSessionControlResponseEvent = {
  requestId: string;
  response: LocalSessionControlResponse;
};

export type SendLocalSessionControl = (
  message: LocalSessionControlRequest,
  onResponse?: (response: LocalSessionControlResponse) => void
) => Promise<SendLocalSessionControlResult>;

export type SendLocalMachineRpcResult = LocalMachineRpcResponseFromModule;

export type SendLocalMachineRpc = (
  message: LocalMachineRpcRequestFromModule
) => Promise<SendLocalMachineRpcResult>;

// Protocol 2 is a persistent push channel, not request/response. The renderer
// sends fire-and-forget client messages and subscribes to server pushes +
// connection status via separate event channels (see the renderer API type).
export type SendLocalLoroDataPlane = (message: LocalLoroDataPlaneClientMessage) => void;

export type LocalLoroDataPlaneServerEvent = LocalLoroDataPlaneServerMessage;

export type OnLocalLoroDataPlaneEvent = (
  listener: (message: LocalLoroDataPlaneServerMessage) => void
) => () => void;

export type OnLocalLoroDataPlaneStatus = (listener: (connected: boolean) => void) => () => void;

export type SendLocalProjectControlResult = LocalProjectControlResponse;

export type SendLocalProjectControl = (
  message: LocalProjectControlRequest
) => Promise<SendLocalProjectControlResult>;

/**
 * One file in a desktop local-transport handoff. `bytes` is an ArrayBuffer so it
 * rides the IPC structured-clone path without a base64/JSON round trip (files may
 * be up to 100 MB). The main process writes each to a temp file before issuing
 * the `session/file-send-local` local-control request, then deletes it.
 */
export type SendSessionFileLocalFile = {
  fileName: string;
  bytes: ArrayBuffer;
};

export type SendSessionFileLocalInput = {
  workspaceId: string;
  sessionId: string;
  machineId: string;
  files: SendSessionFileLocalFile[];
};

export type SendSessionFileLocalResult =
  | {
      ok: true;
      /** `file` blocks (transport: 'local') the local CLI stored for this caller. */
      files: SessionFilePayload[];
      /** Set when some files stored and others failed (partial success). */
      message?: string;
    }
  | {
      ok: false;
      error: string;
    };

export type SendSessionFileLocal = (
  input: SendSessionFileLocalInput
) => Promise<SendSessionFileLocalResult>;

/* ── Image preview context menu ──────────────────────────────────────────────
 *
 * The previewed image only exists in the renderer (a `blob:` URL over bytes the
 * session store decrypted, or a Code Collab file read), so the main process can
 * neither download nor decode it from a URL. The split is therefore: main owns
 * the native menu, the clipboard, and the save dialog; the renderer owns the
 * bytes and hands them over per action, only after the user picked one.
 */

/** 64 MiB. Well past any real screenshot, small enough to bound one IPC copy. */
export const IMAGE_EXPORT_MAX_BYTES = 64 * 1024 * 1024;

export const IMAGE_PREVIEW_MENU_ACTIONS = ['copy', 'save'] as const;

export type ImagePreviewMenuAction = (typeof IMAGE_PREVIEW_MENU_ACTIONS)[number];

/**
 * Labels come from the renderer because that is where i18n lives; the main
 * process only decides that they render as a native menu.
 */
export const ShowImagePreviewMenuInputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            action: z.enum(IMAGE_PREVIEW_MENU_ACTIONS),
            label: z.string().trim().min(1).max(120),
          })
          .strict()
      )
      .min(1)
      .max(IMAGE_PREVIEW_MENU_ACTIONS.length),
  })
  .strict();

export type ShowImagePreviewMenuInput = z.infer<typeof ShowImagePreviewMenuInputSchema>;

/** `null` when the menu closed without a selection. */
export type ShowImagePreviewMenuResult = { action: ImagePreviewMenuAction | null };

const ImageExportBytesSchema = z
  .instanceof(ArrayBuffer)
  .refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= IMAGE_EXPORT_MAX_BYTES, {
    message: 'image bytes out of range',
  });

/**
 * PNG specifically: it is the one raster encoding every desktop clipboard
 * accepts, so the renderer re-encodes whatever the source format was rather
 * than making the main process guess at a decoder.
 */
export const CopyImageToClipboardInputSchema = z
  .object({ pngBytes: ImageExportBytesSchema })
  .strict();

export type CopyImageToClipboardInput = z.infer<typeof CopyImageToClipboardInputSchema>;

export type CopyImageToClipboardResult = { copied: boolean; error?: string };

/**
 * `bytes` stays in the ORIGINAL encoding so a save round-trips the file the user
 * is looking at; `fileName` is only a save-dialog default and the main process
 * reduces it to a base name.
 */
export const SaveImageFileInputSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    bytes: ImageExportBytesSchema,
  })
  .strict();

export type SaveImageFileInput = z.infer<typeof SaveImageFileInputSchema>;

export type SaveImageFileResult =
  | { saved: true; path: string }
  | { saved: false; canceled: true }
  | { saved: false; canceled?: false; error: string };

/* ── Global (OS-level) shortcuts ─────────────────────────────────────────────
 *
 * These are registered in the Electron main process via `globalShortcut` (they fire
 * app-wide even when Lody isn't focused), so they live OUTSIDE the in-renderer command
 * registry. This block is the single cross-process source of truth for which global
 * shortcuts exist and their defaults.
 *
 * To add another user-customizable global shortcut:
 *   1. add its id to `GlobalShortcutId` + a default to `GLOBAL_SHORTCUT_DEFAULTS`;
 *   2. add a handler definition in `apps/electron/src/main/index.ts`;
 *   3. add a display mirror (titleKey/defaultTitle) to `GLOBAL_SHORTCUTS` in
 *      `packages/components/src/lib/commands/shortcuts.ts` + the i18n title.
 */

/**
 * The single implicit workspace of the open-source local platform, read by the
 * Electron main process from the CLI-provisioned local workspace catalog
 * as part of `localPlatform.getSnapshot`. Null until the CLI has provisioned
 * it — and always null on the cloud platform.
 */
export type ElectronImplicitLocalWorkspace = {
  workspaceId: string;
  name: string;
  slug: string | null;
  role: string;
};

/**
 * Atomic renderer bootstrap snapshot for the local platform. Identity and
 * workspace come from the same CLI-owned catalog so every local author and
 * access check uses the installation's one durable synthetic user.
 */
export type ElectronLocalPlatformSnapshot = {
  userId: string;
  workspace: ElectronImplicitLocalWorkspace;
};

export type GlobalShortcutId = 'app.focus';
export const GLOBAL_SHORTCUT_TRIGGERED_CHANNEL = 'app.globalShortcut';

/**
 * Default binding per global shortcut, in the renderer's binding-string syntax
 * (`$mod+Shift+n`). The main process converts these to Electron accelerators via
 * `bindingToElectronAccelerator`.
 */
export const GLOBAL_SHORTCUT_DEFAULTS: Record<GlobalShortcutId, string | null> = {
  'app.focus': '$mod+Shift+l',
};

/** A global shortcut's effective + default binding, surfaced to the renderer. */
export type GlobalShortcutBinding = {
  id: GlobalShortcutId;
  /** Effective binding (user override or default), binding-string syntax. */
  binding: string | null;
  defaultBinding: string | null;
};

export type GlobalShortcutTriggeredPayload = GlobalShortcutBinding;

export type SetGlobalShortcutInput = {
  id: GlobalShortcutId;
  /** New binding (binding-string syntax), or `null` to leave it unbound. */
  binding: string | null;
};

/**
 * Why a `setGlobalShortcut` was refused. `invalid` = unparseable or missing a
 * primary modifier (Command / Control / Alt / Meta; Shift-only would still swallow
 * normal typing system-wide); `conflict` = the OS or another app already owns that
 * combo.
 */
export type GlobalShortcutSetError = 'invalid' | 'conflict';

export type SetGlobalShortcutResult =
  | { ok: true; binding: string | null }
  | { ok: false; error: GlobalShortcutSetError };

const GLOBAL_SHORTCUT_MODIFIER_TO_ACCELERATOR: Record<string, string> = {
  $mod: 'CommandOrControl',
  mod: 'CommandOrControl',
  cmd: 'Command',
  command: 'Command',
  meta: 'Super',
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};

const GLOBAL_SHORTCUT_NAMED_KEY_TO_ACCELERATOR: Record<string, string> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  enter: 'Return',
  return: 'Return',
  escape: 'Esc',
  esc: 'Esc',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  plus: 'Plus',
};

const GLOBAL_SHORTCUT_PRIMARY_MODIFIERS = new Set([
  '$mod',
  'mod',
  'cmd',
  'command',
  'meta',
  'ctrl',
  'control',
  'alt',
  'option',
]);

function splitBindingTokens(binding: string | null | undefined): string[] {
  if (!binding) return [];
  return binding
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean);
}

function keyTokenToAccelerator(token: string): string | null {
  if (token.length === 1) {
    // Letters → uppercase; digits / punctuation pass through as Electron expects.
    return /[a-z]/i.test(token) ? token.toUpperCase() : token;
  }
  const named = GLOBAL_SHORTCUT_NAMED_KEY_TO_ACCELERATOR[token.toLowerCase()];
  if (named) return named;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(token)) return token.toUpperCase(); // F1–F24
  return null;
}

/** True if the binding includes a non-Shift modifier safe for OS-level registration. */
export function globalShortcutBindingHasModifier(binding: string | null | undefined): boolean {
  const tokens = splitBindingTokens(binding);
  return tokens
    .slice(0, -1)
    .some((token) => GLOBAL_SHORTCUT_PRIMARY_MODIFIERS.has(token.toLowerCase()));
}

/**
 * Convert a binding-string (`$mod+Shift+l`) into an Electron accelerator
 * (`CommandOrControl+Shift+L`). Returns `null` when it can't be a usable global
 * accelerator — an unknown token, no key, or no primary modifier. Shift may be part
 * of the combo, but Shift-only globals would capture normal capitalization typing.
 */
export function bindingToElectronAccelerator(binding: string | null | undefined): string | null {
  const tokens = splitBindingTokens(binding);
  if (tokens.length === 0) return null;
  const keyToken = tokens[tokens.length - 1]!;
  const modifierTokens = tokens.slice(0, -1);

  const modifiers: string[] = [];
  for (const token of modifierTokens) {
    const accelerator = GLOBAL_SHORTCUT_MODIFIER_TO_ACCELERATOR[token.toLowerCase()];
    if (!accelerator) return null;
    if (!modifiers.includes(accelerator)) modifiers.push(accelerator);
  }
  if (!globalShortcutBindingHasModifier(binding)) return null;

  const key = keyTokenToAccelerator(keyToken);
  if (!key) return null;

  return [...modifiers, key].join('+');
}

export * from './electron-ipc-channels';

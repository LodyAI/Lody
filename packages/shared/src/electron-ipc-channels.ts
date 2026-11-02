import type {
  LocalLoroDataPlaneClientMessage,
  LocalLoroDataPlaneServerMessage,
} from './local-loro-data-plane';
import type { TerminalDataEvent, TerminalExitEvent, TerminalTitleEvent } from './terminal-protocol';
import type {
  CliOutputEvent,
  ElectronCliState,
  ElectronLoginState,
  ElectronLocalSessionControlResponseEvent,
  ElectronPublicBrowserState,
  ElectronPublicBrowserInteraction,
  ElectronStorageGuardState,
  ElectronUpdaterState,
  ElectronWindowTarget,
  PreparedWindowTarget,
  GlobalShortcutTriggeredPayload,
  SessionCompletionNotificationClickPayload,
} from './electron-ipc';

export type IpcPushMap = {
  'terminal.event':
    | TerminalDataEvent
    | TerminalExitEvent
    | TerminalTitleEvent
    | { type: 'error'; code: string; message: string };
  'loro.event': LocalLoroDataPlaneServerMessage;
  'loro.status': boolean;
  'cli.output': CliOutputEvent;
  'cli.state': ElectronCliState;
  'updater.state': ElectronUpdaterState;
  'storageGuard.state': ElectronStorageGuardState;
  'publicBrowser.state': ElectronPublicBrowserState;
  'publicBrowser.interaction': ElectronPublicBrowserInteraction;
  'sessionControl.response': ElectronLocalSessionControlResponseEvent;
  'app.deepLink': string;
  'auth.loginState': ElectronLoginState;
  'app.menuAction': string;
  'app.fullscreen': boolean;
  'app.nativeTheme': 'light' | 'dark';
  'app.globalShortcut': GlobalShortcutTriggeredPayload;
  'app.sessionCompletionClick': SessionCompletionNotificationClickPayload;
  'app.windowTarget': ElectronWindowTarget;
  'app.prepareWindowTarget': PreparedWindowTarget;
  'app.activatePreparedWindow': PreparedWindowTarget;
};

export type IpcSendMap = {
  'terminal.attach': { terminalId: string; cols: number; rows: number };
  'terminal.input': { terminalId: string; data: string };
  'terminal.resize': { terminalId: string; cols: number; rows: number };
  'terminal.close': { terminalId: string };
  'terminal.closeSession': { sessionId: string };
  'loro.send': LocalLoroDataPlaneClientMessage;
  'loro.subscribe': null;
  'cli.subscribe': null;
  'app.windowReady': null;
  'app.windowContentReady': ElectronWindowTarget;
  'app.preparedWindowState': PreparedWindowTarget & { ready: boolean };
};

export const IPC_PUSH_CHANNELS = {
  terminalEvent: 'terminal.event',
  loroEvent: 'loro.event',
  loroStatus: 'loro.status',
  cliOutput: 'cli.output',
  cliState: 'cli.state',
  updaterState: 'updater.state',
  storageGuardState: 'storageGuard.state',
  publicBrowserState: 'publicBrowser.state',
  publicBrowserInteraction: 'publicBrowser.interaction',
  sessionControlResponse: 'sessionControl.response',
  appDeepLink: 'app.deepLink',
  authLoginState: 'auth.loginState',
  appMenuAction: 'app.menuAction',
  appFullscreen: 'app.fullscreen',
  appNativeTheme: 'app.nativeTheme',
  appGlobalShortcut: 'app.globalShortcut',
  appSessionCompletionClick: 'app.sessionCompletionClick',
  appWindowTarget: 'app.windowTarget',
  appPrepareWindowTarget: 'app.prepareWindowTarget',
  appActivatePreparedWindow: 'app.activatePreparedWindow',
} as const satisfies { [K: string]: keyof IpcPushMap };

export const IPC_SEND_CHANNELS = {
  terminalAttach: 'terminal.attach',
  terminalInput: 'terminal.input',
  terminalResize: 'terminal.resize',
  terminalClose: 'terminal.close',
  terminalCloseSession: 'terminal.closeSession',
  loroSend: 'loro.send',
  loroSubscribe: 'loro.subscribe',
  cliSubscribe: 'cli.subscribe',
  appWindowReady: 'app.windowReady',
  appWindowContentReady: 'app.windowContentReady',
  appPreparedWindowState: 'app.preparedWindowState',
} as const satisfies { [K: string]: keyof IpcSendMap };

/**
 * E2E-only client-loss probe. Main registers both channels, and preload admits them,
 * only when an unpackaged `LODY_E2E=1` main passes `argument` to the window.
 */
export const E2EE_CLIENT_LOSS_PROBE = {
  argument: '--lody-e2ee-client-loss-probe',
  inspect: 'e2ee.inspectClientLoss',
  effects: 'e2ee.clientLossEffects',
} as const;

const PUSH_CHANNEL_VALUES: readonly string[] = Object.values(IPC_PUSH_CHANNELS);
const SEND_CHANNEL_VALUES: readonly string[] = Object.values(IPC_SEND_CHANNELS);

export function isIpcPushChannel(channel: string): channel is keyof IpcPushMap {
  return PUSH_CHANNEL_VALUES.includes(channel);
}

export function isIpcSendChannel(channel: string): channel is keyof IpcSendMap {
  return SEND_CHANNEL_VALUES.includes(channel);
}

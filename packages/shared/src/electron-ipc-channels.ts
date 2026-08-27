import type {
  LocalLoroDataPlaneClientMessage,
  LocalLoroDataPlaneServerMessage,
} from './local-loro-data-plane';
import type { TerminalDataEvent, TerminalExitEvent, TerminalTitleEvent } from './terminal-protocol';
import type {
  CliOutputEvent,
  ElectronCliState,
  ElectronLocalSessionControlResponseEvent,
  ElectronPublicBrowserState,
  ElectronUpdaterState,
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
  'publicBrowser.state': ElectronPublicBrowserState;
  'sessionControl.response': ElectronLocalSessionControlResponseEvent;
  'app.deepLink': string;
  'app.menuAction': string;
  'app.fullscreen': boolean;
  'app.nativeTheme': 'light' | 'dark';
  'app.globalShortcut': GlobalShortcutTriggeredPayload;
  'app.sessionCompletionClick': SessionCompletionNotificationClickPayload;
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
};

export const IPC_PUSH_CHANNELS = {
  terminalEvent: 'terminal.event',
  loroEvent: 'loro.event',
  loroStatus: 'loro.status',
  cliOutput: 'cli.output',
  cliState: 'cli.state',
  updaterState: 'updater.state',
  publicBrowserState: 'publicBrowser.state',
  sessionControlResponse: 'sessionControl.response',
  appDeepLink: 'app.deepLink',
  appMenuAction: 'app.menuAction',
  appFullscreen: 'app.fullscreen',
  appNativeTheme: 'app.nativeTheme',
  appGlobalShortcut: 'app.globalShortcut',
  appSessionCompletionClick: 'app.sessionCompletionClick',
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
} as const satisfies { [K: string]: keyof IpcSendMap };

const PUSH_CHANNEL_VALUES: readonly string[] = Object.values(IPC_PUSH_CHANNELS);
const SEND_CHANNEL_VALUES: readonly string[] = Object.values(IPC_SEND_CHANNELS);

export function isIpcPushChannel(channel: string): channel is keyof IpcPushMap {
  return PUSH_CHANNEL_VALUES.includes(channel);
}

export function isIpcSendChannel(channel: string): channel is keyof IpcSendMap {
  return SEND_CHANNEL_VALUES.includes(channel);
}

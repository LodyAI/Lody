import { ElectronAPI } from '@electron-toolkit/preload'

type LodyPlatformInfo = {
  os: string
  homeDir: string
  machineName: string
  preferredSystemLanguages?: readonly string[]
}

type LodyNativeAppInfo = {
  version?: string
  build?: string
  native_platform?: string
  os_name?: string
  os_version?: string
  app_version?: string
  install_id?: string
}

type ElectronRequestAuthOptions = {
  provider?: string
  callbackURL?: string
  newUserCallbackURL?: string
  errorCallbackURL?: string
  disableRedirect?: boolean
  scopes?: string[]
  requestSignUp?: boolean
  additionalData?: Record<string, unknown>
}

type ElectronAuthenticateOptions = {
  token: string
}

type BetterAuthElectronBridges = {
  getUser: () => Promise<unknown>
  requestAuth: (options?: ElectronRequestAuthOptions) => Promise<void>
  authenticate: (options: ElectronAuthenticateOptions) => Promise<unknown>
  signOut: () => Promise<void>
  onAuthenticated: (callback: (user: unknown) => unknown) => () => void
  onUserUpdated: (callback: (user: unknown) => unknown) => () => void
  onAuthError: (callback: (context: unknown) => unknown) => () => void
}

type LodyIpcBridge = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, listener: (payload: unknown) => void) => () => void
  send: (channel: string, payload?: unknown) => void
}

declare global {
  interface Window extends BetterAuthElectronBridges {
    __LODY_ELECTRON__?: true
    __LODY_PLATFORM__?: LodyPlatformInfo
    __LODY_APP_INFO__?: LodyNativeAppInfo
    electron: ElectronAPI
    ipc: LodyIpcBridge
  }
}

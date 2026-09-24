import { createAuthClient } from 'better-auth/client'
import { electronClient } from '@better-auth/electron/client'
import { organizationClient } from 'better-auth/client/plugins'
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins'
import { app, safeStorage } from 'electron'
import Conf from 'conf'
import { Buffer } from 'node:buffer'
import { join, resolve } from 'node:path'
import {
  backupAuthStorageFile,
  createRecoveringAuthStorage,
  openAuthStorageBackend
} from './auth-storage'
import { isLocalPlatform, desktopInstallationProfile } from './platform'

const DEV_PLAINTEXT_AUTH_STORAGE_ENV = 'LODY_ELECTRON_PLAINTEXT_AUTH_STORAGE'
const DEV_USER_DATA_DIR_ENV = 'LODY_ELECTRON_USER_DATA_DIR'
const DEV_PLAINTEXT_AUTH_STORAGE_PREFIX = 'lody-dev-plaintext-safe-storage-v1:'

function readNonEmptyEnv(name: string): string | null {
  const value = process.env[name]?.trim()
  return value && value.length > 0 ? value : null
}

function applyDevUserDataDirIfRequested(): void {
  const userDataDir = readNonEmptyEnv(DEV_USER_DATA_DIR_ENV)
  if (!userDataDir) {
    return
  }

  if (app.isPackaged) {
    console.warn(
      `[Auth] Ignoring ${DEV_USER_DATA_DIR_ENV} because custom userData is only allowed in dev builds.`
    )
    return
  }

  const resolvedUserDataDir = resolve(userDataDir)
  app.setPath('userData', resolvedUserDataDir)
  console.warn(`[Auth] ${DEV_USER_DATA_DIR_ENV}: using ${resolvedUserDataDir}`)
}

function enableDevPlaintextAuthStorageIfRequested(): void {
  if (process.env[DEV_PLAINTEXT_AUTH_STORAGE_ENV] !== '1') {
    return
  }

  if (app.isPackaged) {
    console.warn(
      `[Auth] Ignoring ${DEV_PLAINTEXT_AUTH_STORAGE_ENV}=1 because plaintext auth storage is only allowed in dev builds.`
    )
    return
  }

  try {
    Object.defineProperties(safeStorage, {
      decryptString: {
        configurable: true,
        value: (encrypted: Buffer) => {
          const text = encrypted.toString('utf8')
          return text.startsWith(DEV_PLAINTEXT_AUTH_STORAGE_PREFIX)
            ? text.slice(DEV_PLAINTEXT_AUTH_STORAGE_PREFIX.length)
            : ''
        }
      },
      encryptString: {
        configurable: true,
        value: (plainText: string) =>
          Buffer.from(`${DEV_PLAINTEXT_AUTH_STORAGE_PREFIX}${plainText}`, 'utf8')
      },
      isEncryptionAvailable: {
        configurable: true,
        value: () => true
      }
    })
    console.warn(
      `[Auth] ${DEV_PLAINTEXT_AUTH_STORAGE_ENV}=1: using dev-only plaintext auth storage.`
    )
  } catch (error) {
    console.warn(`[Auth] Failed to enable dev plaintext auth storage`, error)
  }
}

applyDevUserDataDirIfRequested()
enableDevPlaintextAuthStorageIfRequested()

function normalizeConvexSiteUrl(url: string): string {
  if (!url) return url
  try {
    const parsed = new URL(url)
    if (parsed.hostname.endsWith('.convex.cloud')) {
      parsed.hostname = parsed.hostname.replace(/\.convex\.cloud$/, '.convex.site')
    }
    parsed.pathname = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return url.replace(/\/$/, '')
  }
}

const rawAuthBaseURL =
  import.meta.env.VITE_CONVEX_SITE_URL || import.meta.env.VITE_CONVEX_DEPLOY_URL
// Local platform builds ship without cloud env and the renderer never
// authenticates: keep the auth client constructible against an inert loopback
// base URL so the main process can boot. Cloud builds still require the env.
export const authBaseURL = rawAuthBaseURL
  ? normalizeConvexSiteUrl(rawAuthBaseURL)
  : isLocalPlatform()
    ? 'http://127.0.0.1:0'
    : ''
if (!authBaseURL) {
  throw new Error(
    'VITE_CONVEX_SITE_URL (or VITE_CONVEX_DEPLOY_URL) is required for Electron auth client'
  )
}
const normalizedConfModule = Conf as typeof Conf | { default?: typeof Conf }
const ConfConstructor =
  typeof normalizedConfModule === 'function' ? normalizedConfModule : normalizedConfModule.default
if (typeof ConfConstructor !== 'function') {
  throw new TypeError('Unable to initialize auth storage: invalid Conf module export shape.')
}

// Same file as @better-auth/electron's storage(): `userData/config.json`.
const authStoragePath = join(app.getPath('userData'), 'config.json')
const opened = openAuthStorageBackend(
  () =>
    new ConfConstructor<Record<string, unknown>>({
      cwd: app.getPath('userData'),
      projectName: app.getName(),
      projectVersion: app.getVersion()
    }),
  { path: authStoragePath, backup: backupAuthStorageFile }
)
if (opened.error) {
  console.warn(
    `[Auth] ${authStoragePath} was unreadable and was moved to ${opened.backupPath ?? '(backup failed)'}; sign in again.`,
    opened.error
  )
}
const confStore = opened.store

const authStorage = createRecoveringAuthStorage(
  {
    path: authStoragePath,
    get: (key) => confStore.get(key, null),
    set: (key, value) => confStore.set(key, value),
    delete: (key) => confStore.delete(key)
  },
  {
    encryptedKeys: ['better-auth.cookie', 'better-auth.local_cache'],
    cipher: {
      isReady: () => app.isReady(),
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      decryptString: (encrypted) => safeStorage.decryptString(encrypted)
    },
    backup: (path) => backupAuthStorageFile(path),
    onRecovered: ({ key, backupPath, error }) => {
      console.warn(
        `[Auth] Dropped undecryptable ${key} from ${authStoragePath} (backup: ${backupPath ?? 'failed'}); sign in again.`,
        error
      )
    }
  }
)

export const authClient = createAuthClient({
  baseURL: authBaseURL,
  plugins: [
    organizationClient(),
    convexClient(),
    crossDomainClient({
      storage: authStorage
    }),
    electronClient({
      signInURL: `${import.meta.env.VITE_SITE_URL || 'https://lody.ai'}/login`,
      protocol: {
        scheme: desktopInstallationProfile.desktopProtocol
      },
      storage: authStorage
    })
  ]
})

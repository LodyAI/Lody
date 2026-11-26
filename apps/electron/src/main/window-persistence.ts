import { screen, type BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import Conf from 'conf'
import { createSettingsStoreWithFallback } from './settings-store-core'
import { DESKTOP_WINDOW_MIN_WIDTH } from '@lody/shared/layout'
import {
  MIN_VISIBLE_WINDOW_HEIGHT,
  MIN_VISIBLE_WINDOW_WIDTH,
  buildWindowBoundsOptions,
  ensureVisibleWindowBounds,
  normalizeWindowBounds,
  type PersistedWindowBounds,
  type WindowBoundsConstraints,
  type WindowBoundsConstructorOptions
} from './window-persistence-core'

const DEFAULT_MAIN_WINDOW_BOUNDS = {
  width: 900,
  height: 670
} as const

// The desktop shell keeps the desktop layout at every width — a narrow window
// takes the compact presentation (overlay sidebars) rather than the mobile
// renderer, so this floor only protects window chrome, not the layout switch.
export const MAIN_WINDOW_MIN_WIDTH = DESKTOP_WINDOW_MIN_WIDTH
export const MAIN_WINDOW_MIN_HEIGHT = 600

const MAIN_WINDOW_CONSTRAINTS: WindowBoundsConstraints = {
  defaultWidth: DEFAULT_MAIN_WINDOW_BOUNDS.width,
  defaultHeight: DEFAULT_MAIN_WINDOW_BOUNDS.height,
  minWidth: MAIN_WINDOW_MIN_WIDTH,
  minHeight: MAIN_WINDOW_MIN_HEIGHT
}

const DEFAULT_TODAY_WINDOW_BOUNDS = {
  width: 440,
  height: 760
} as const

export const TODAY_WINDOW_CONSTRAINTS: WindowBoundsConstraints = {
  defaultWidth: DEFAULT_TODAY_WINDOW_BOUNDS.width,
  defaultHeight: DEFAULT_TODAY_WINDOW_BOUNDS.height,
  minWidth: 320,
  minHeight: 360
}

const WINDOW_STATE_DEBOUNCE_MS = 150

type PersistedWindowState = {
  bounds: PersistedWindowBounds
  isMaximized: boolean
}

type PersistedTodayWindowState = {
  bounds: PersistedWindowBounds
}

type WindowStateSchema = {
  mainWindow: PersistedWindowState
  todayWindow: PersistedTodayWindowState
}

const boundsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['width', 'height'],
  properties: {
    width: { type: 'number', minimum: MIN_VISIBLE_WINDOW_WIDTH },
    height: { type: 'number', minimum: MIN_VISIBLE_WINDOW_HEIGHT },
    x: { type: 'number' },
    y: { type: 'number' }
  }
} as const

const normalizedConfModule = Conf as
  | typeof Conf
  | {
      default?: typeof Conf
    }

const ConfConstructor =
  typeof normalizedConfModule === 'function' ? normalizedConfModule : normalizedConfModule.default

if (typeof ConfConstructor !== 'function') {
  throw new TypeError('Unable to initialize config store: invalid Conf module export shape.')
}

const windowStateStore = createSettingsStoreWithFallback<WindowStateSchema>(
  () =>
    new ConfConstructor<WindowStateSchema>({
      projectName: 'lody-desktop',
      configName: 'window-state',
      defaults: {
        mainWindow: {
          bounds: DEFAULT_MAIN_WINDOW_BOUNDS,
          isMaximized: false
        },
        todayWindow: {
          bounds: DEFAULT_TODAY_WINDOW_BOUNDS
        }
      },
      schema: {
        mainWindow: {
          type: 'object',
          additionalProperties: false,
          required: ['bounds', 'isMaximized'],
          properties: {
            bounds: boundsSchema,
            isMaximized: { type: 'boolean' }
          }
        },
        todayWindow: {
          type: 'object',
          additionalProperties: false,
          required: ['bounds'],
          properties: {
            bounds: boundsSchema
          }
        }
      }
    }),
  {
    configName: 'window-state',
    defaults: {
      mainWindow: { bounds: DEFAULT_MAIN_WINDOW_BOUNDS, isMaximized: false },
      todayWindow: { bounds: DEFAULT_TODAY_WINDOW_BOUNDS }
    }
  }
)

function getDisplayWorkAreas() {
  return screen.getAllDisplays().map((display) => display.workArea)
}

function getMainWindowState(): PersistedWindowState {
  const savedState = windowStateStore.get('mainWindow')
  const normalizedBounds = ensureVisibleWindowBounds(
    normalizeWindowBounds(savedState.bounds, MAIN_WINDOW_CONSTRAINTS),
    getDisplayWorkAreas()
  )

  return {
    bounds: normalizedBounds,
    isMaximized: savedState.isMaximized
  }
}

export function getMainWindowConstructorOptions(): Pick<
  BrowserWindowConstructorOptions,
  'width' | 'height' | 'x' | 'y' | 'minWidth' | 'minHeight'
> {
  const state = getMainWindowState()

  return {
    width: state.bounds.width,
    height: state.bounds.height,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    ...(state.bounds.x !== undefined ? { x: state.bounds.x } : {}),
    ...(state.bounds.y !== undefined ? { y: state.bounds.y } : {})
  }
}

export function shouldMaximizeMainWindowOnLaunch(): boolean {
  return getMainWindowState().isMaximized
}

function readPersistedWindowBounds(
  window: BrowserWindow,
  constraints: WindowBoundsConstraints
): PersistedWindowBounds {
  return normalizeWindowBounds(
    window.isMaximized() || window.isMinimized() || window.isFullScreen()
      ? window.getNormalBounds()
      : window.getBounds(),
    constraints
  )
}

function saveMainWindowState(window: BrowserWindow): void {
  windowStateStore.set('mainWindow', {
    bounds: readPersistedWindowBounds(window, MAIN_WINDOW_CONSTRAINTS),
    isMaximized: window.isMaximized()
  })
}

export function trackMainWindowState(window: BrowserWindow): void {
  let persistTimer: NodeJS.Timeout | null = null

  const scheduleSave = (): void => {
    if (persistTimer) {
      clearTimeout(persistTimer)
    }

    persistTimer = setTimeout(() => {
      persistTimer = null
      if (!window.isDestroyed()) {
        saveMainWindowState(window)
      }
    }, WINDOW_STATE_DEBOUNCE_MS)
  }

  window.on('move', scheduleSave)
  window.on('resize', scheduleSave)
  window.on('maximize', scheduleSave)
  window.on('unmaximize', scheduleSave)
  window.on('close', () => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    saveMainWindowState(window)
  })
}

export function getTodayWindowConstructorOptions(): WindowBoundsConstructorOptions {
  const savedState = windowStateStore.get('todayWindow')
  return buildWindowBoundsOptions(
    savedState?.bounds,
    TODAY_WINDOW_CONSTRAINTS,
    getDisplayWorkAreas(),
    { centerWhenUnpositioned: true }
  )
}

function saveTodayWindowBounds(window: BrowserWindow): void {
  windowStateStore.set('todayWindow', {
    bounds: readPersistedWindowBounds(window, TODAY_WINDOW_CONSTRAINTS)
  })
}

export function trackTodayWindowBounds(window: BrowserWindow): void {
  let persistTimer: NodeJS.Timeout | null = null

  const flushSave = (): void => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (!window.isDestroyed()) {
      saveTodayWindowBounds(window)
    }
  }

  const scheduleSave = (): void => {
    if (persistTimer) {
      clearTimeout(persistTimer)
    }
    persistTimer = setTimeout(() => {
      persistTimer = null
      if (!window.isDestroyed()) {
        saveTodayWindowBounds(window)
      }
    }, WINDOW_STATE_DEBOUNCE_MS)
  }

  window.on('move', scheduleSave)
  window.on('resize', scheduleSave)
  window.on('hide', flushSave)
  window.on('close', flushSave)
}

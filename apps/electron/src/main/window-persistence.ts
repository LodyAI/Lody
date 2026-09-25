import {
  screen,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type Rectangle
} from 'electron'
import Conf from 'conf'
import { DESKTOP_WINDOW_MIN_WIDTH } from '@lody/shared/layout'

const DEFAULT_MAIN_WINDOW_BOUNDS = {
  width: 900,
  height: 670
} as const

// The desktop shell keeps the desktop layout at every width — a narrow window
// takes the compact presentation (overlay sidebars) rather than the mobile
// renderer, so this floor only protects window chrome, not the layout switch.
export const MAIN_WINDOW_MIN_WIDTH = DESKTOP_WINDOW_MIN_WIDTH
export const MAIN_WINDOW_MIN_HEIGHT = 600

const WINDOW_STATE_DEBOUNCE_MS = 150
const MIN_VISIBLE_WIDTH = 120
const MIN_VISIBLE_HEIGHT = 120

type PersistedWindowBounds = {
  width: number
  height: number
  x?: number
  y?: number
}

type PersistedWindowState = {
  bounds: PersistedWindowBounds
  isMaximized: boolean
}

type WindowStateSchema = {
  mainWindow: PersistedWindowState
}

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

const windowStateStore = new ConfConstructor<WindowStateSchema>({
  projectName: 'lody-desktop',
  configName: 'window-state',
  defaults: {
    mainWindow: {
      bounds: DEFAULT_MAIN_WINDOW_BOUNDS,
      isMaximized: false
    }
  },
  schema: {
    mainWindow: {
      type: 'object',
      additionalProperties: false,
      required: ['bounds', 'isMaximized'],
      properties: {
        bounds: {
          type: 'object',
          additionalProperties: false,
          required: ['width', 'height'],
          properties: {
            width: { type: 'number', minimum: MIN_VISIBLE_WIDTH },
            height: { type: 'number', minimum: MIN_VISIBLE_HEIGHT },
            x: { type: 'number' },
            y: { type: 'number' }
          }
        },
        isMaximized: { type: 'boolean' }
      }
    }
  }
})

function roundCoordinate(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }

  return Math.round(value)
}

function normalizeBounds(bounds: PersistedWindowBounds): PersistedWindowBounds {
  const width =
    typeof bounds.width === 'number' && Number.isFinite(bounds.width)
      ? Math.max(Math.round(bounds.width), MAIN_WINDOW_MIN_WIDTH)
      : DEFAULT_MAIN_WINDOW_BOUNDS.width
  const height =
    typeof bounds.height === 'number' && Number.isFinite(bounds.height)
      ? Math.max(Math.round(bounds.height), MAIN_WINDOW_MIN_HEIGHT)
      : DEFAULT_MAIN_WINDOW_BOUNDS.height

  return {
    width,
    height,
    x: roundCoordinate(bounds.x),
    y: roundCoordinate(bounds.y)
  }
}

function hasVisibleIntersection(bounds: PersistedWindowBounds, workArea: Rectangle): boolean {
  const x = bounds.x
  const y = bounds.y
  if (x === undefined || y === undefined) {
    return true
  }

  const visibleWidth =
    Math.min(x + bounds.width, workArea.x + workArea.width) - Math.max(x, workArea.x)
  const visibleHeight =
    Math.min(y + bounds.height, workArea.y + workArea.height) - Math.max(y, workArea.y)

  return visibleWidth >= MIN_VISIBLE_WIDTH && visibleHeight >= MIN_VISIBLE_HEIGHT
}

function ensureVisibleBounds(bounds: PersistedWindowBounds): PersistedWindowBounds {
  if (bounds.x === undefined || bounds.y === undefined) {
    return bounds
  }

  const hasVisibleDisplay = screen.getAllDisplays().some((display) => {
    return hasVisibleIntersection(bounds, display.workArea)
  })

  if (hasVisibleDisplay) {
    return bounds
  }

  return {
    width: bounds.width,
    height: bounds.height
  }
}

function getMainWindowState(): PersistedWindowState {
  const savedState = windowStateStore.get('mainWindow')
  const normalizedBounds = ensureVisibleBounds(normalizeBounds(savedState.bounds))

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

function saveMainWindowState(window: BrowserWindow): void {
  const bounds = normalizeBounds(
    window.isMaximized() || window.isMinimized() || window.isFullScreen()
      ? window.getNormalBounds()
      : window.getBounds()
  )

  windowStateStore.set('mainWindow', {
    bounds,
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

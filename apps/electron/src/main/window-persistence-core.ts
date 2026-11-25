export type PersistedWindowBounds = {
  width: number
  height: number
  x?: number
  y?: number
}

export type WindowBoundsConstraints = {
  defaultWidth: number
  defaultHeight: number
  minWidth: number
  minHeight: number
}

export type WorkAreaRect = {
  x: number
  y: number
  width: number
  height: number
}

export type WindowBoundsConstructorOptions = {
  width: number
  height: number
  minWidth: number
  minHeight: number
  x?: number
  y?: number
  center?: boolean
}

export const MIN_VISIBLE_WINDOW_WIDTH = 120
export const MIN_VISIBLE_WINDOW_HEIGHT = 120

function roundCoordinate(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.round(value)
}

export function normalizeWindowBounds(
  bounds: Partial<PersistedWindowBounds> | undefined,
  constraints: WindowBoundsConstraints
): PersistedWindowBounds {
  const width =
    typeof bounds?.width === 'number' && Number.isFinite(bounds.width)
      ? Math.max(Math.round(bounds.width), constraints.minWidth)
      : constraints.defaultWidth
  const height =
    typeof bounds?.height === 'number' && Number.isFinite(bounds.height)
      ? Math.max(Math.round(bounds.height), constraints.minHeight)
      : constraints.defaultHeight

  return {
    width,
    height,
    x: roundCoordinate(bounds?.x),
    y: roundCoordinate(bounds?.y)
  }
}

export function hasVisibleIntersection(
  bounds: PersistedWindowBounds,
  workArea: WorkAreaRect
): boolean {
  const { x, y } = bounds
  if (x === undefined || y === undefined) {
    return true
  }

  const visibleWidth =
    Math.min(x + bounds.width, workArea.x + workArea.width) - Math.max(x, workArea.x)
  const visibleHeight =
    Math.min(y + bounds.height, workArea.y + workArea.height) - Math.max(y, workArea.y)

  return visibleWidth >= MIN_VISIBLE_WINDOW_WIDTH && visibleHeight >= MIN_VISIBLE_WINDOW_HEIGHT
}

export function ensureVisibleWindowBounds(
  bounds: PersistedWindowBounds,
  workAreas: readonly WorkAreaRect[]
): PersistedWindowBounds {
  if (bounds.x === undefined || bounds.y === undefined) {
    return bounds
  }

  const hasVisibleDisplay = workAreas.some((workArea) => hasVisibleIntersection(bounds, workArea))
  if (hasVisibleDisplay) {
    return bounds
  }

  return {
    width: bounds.width,
    height: bounds.height
  }
}

export function buildWindowBoundsOptions(
  bounds: Partial<PersistedWindowBounds> | undefined,
  constraints: WindowBoundsConstraints,
  workAreas: readonly WorkAreaRect[],
  options?: { centerWhenUnpositioned?: boolean }
): WindowBoundsConstructorOptions {
  const visible = ensureVisibleWindowBounds(normalizeWindowBounds(bounds, constraints), workAreas)
  const hasPosition = visible.x !== undefined && visible.y !== undefined

  return {
    width: visible.width,
    height: visible.height,
    minWidth: constraints.minWidth,
    minHeight: constraints.minHeight,
    ...(hasPosition
      ? { x: visible.x, y: visible.y }
      : options?.centerWhenUnpositioned
        ? { center: true }
        : {})
  }
}

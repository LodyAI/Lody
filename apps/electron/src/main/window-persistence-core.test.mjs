import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWindowBoundsOptions, normalizeWindowBounds } from './window-persistence-core.ts'

const TODAY_CONSTRAINTS = {
  defaultWidth: 440,
  defaultHeight: 760,
  minWidth: 320,
  minHeight: 360
}

const PRIMARY_DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 }
const SECONDARY_DISPLAY = { x: 1920, y: 0, width: 1440, height: 900 }

void test('centers companion window with default size when no position is persisted', () => {
  const options = buildWindowBoundsOptions(undefined, TODAY_CONSTRAINTS, [PRIMARY_DISPLAY], {
    centerWhenUnpositioned: true
  })

  assert.deepEqual(options, {
    width: 440,
    height: 760,
    minWidth: 320,
    minHeight: 360,
    center: true
  })
})

void test('restores persisted on-screen position and size without center override', () => {
  const options = buildWindowBoundsOptions(
    { x: 1320.4, y: 120.6, width: 480, height: 680 },
    TODAY_CONSTRAINTS,
    [PRIMARY_DISPLAY],
    { centerWhenUnpositioned: true }
  )

  assert.deepEqual(options, {
    width: 480,
    height: 680,
    minWidth: 320,
    minHeight: 360,
    x: 1320,
    y: 121
  })
  assert.equal('center' in options, false)
})

void test('drops off-screen coordinates and re-centers while preserving size', () => {
  const options = buildWindowBoundsOptions(
    { x: 2400, y: 100, width: 500, height: 700 },
    TODAY_CONSTRAINTS,
    [PRIMARY_DISPLAY],
    { centerWhenUnpositioned: true }
  )

  assert.deepEqual(options, {
    width: 500,
    height: 700,
    minWidth: 320,
    minHeight: 360,
    center: true
  })
})

void test('preserves position on a connected secondary display', () => {
  const options = buildWindowBoundsOptions(
    { x: 2400, y: 100, width: 500, height: 700 },
    TODAY_CONSTRAINTS,
    [PRIMARY_DISPLAY, SECONDARY_DISPLAY],
    { centerWhenUnpositioned: true }
  )

  assert.equal(options.x, 2400)
  assert.equal(options.y, 100)
  assert.equal('center' in options, false)
})

void test('clamps persisted dimensions to window minimums', () => {
  const normalized = normalizeWindowBounds(
    { x: 40, y: 50, width: 100, height: 120 },
    TODAY_CONSTRAINTS
  )

  assert.deepEqual(normalized, {
    width: 320,
    height: 360,
    x: 40,
    y: 50
  })
})

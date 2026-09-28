import assert from 'node:assert/strict'
import test from 'node:test'

import {
  belowSheen,
  centredRect,
  evaluateFloatBleed,
  evaluateFloatPatch,
  FLOAT_GLASS_THRESHOLDS,
  growRect
} from './float-glass-checks.mjs'
import { parseHexColor } from './image-stats.mjs'

const DARK_TEXT = { primary: parseHexColor('#F5F5F6'), secondary: parseHexColor('#A1A1A6') }
const grey = (value) => ({ r: value, g: value, b: value })
const allBackdrops = (colour) =>
  Object.fromEntries(['red', 'blue', 'white', 'black', 'text'].map((variant) => [variant, colour]))

test('a raised surface one step lighter than the dark window glass passes', () => {
  // Window glass ≈ #2B2B2B (the owner's Stream Manager), surface ≈ #333336.
  const result = evaluateFloatPatch({
    theme: 'dark',
    windowMeans: allBackdrops(grey(0x2b)),
    surfaceMeans: allBackdrops({ r: 0x33, g: 0x33, b: 0x36 }),
    text: DARK_TEXT
  })
  assert.equal(result.pass, true, JSON.stringify(result))
  assert.ok(result.metrics.liftMin > 0)
})

test('the old near-opaque popover coat fails as a black slab on the window glass', () => {
  // The screenshot that started plan 072: #111113 on #2B2B2B.
  const result = evaluateFloatPatch({
    theme: 'dark',
    windowMeans: allBackdrops(grey(0x2b)),
    surfaceMeans: allBackdrops({ r: 0x11, g: 0x11, b: 0x13 }),
    text: DARK_TEXT
  })
  assert.equal(result.checks.lift, false)
  assert.ok(result.metrics.liftMin < FLOAT_GLASS_THRESHOLDS.lift.dark[0])
})

test('a surface too light for its text fails on contrast, not lift', () => {
  const result = evaluateFloatPatch({
    theme: 'dark',
    windowMeans: allBackdrops(grey(0x60)),
    surfaceMeans: allBackdrops(grey(0x68)),
    text: DARK_TEXT
  })
  assert.equal(result.checks.lift, true)
  assert.equal(result.checks.secondaryContrast, false)
})

test('patch scoring needs a shared backdrop and a contrast backdrop', () => {
  assert.throws(
    () =>
      evaluateFloatPatch({
        theme: 'dark',
        windowMeans: { red: grey(0x2b) },
        surfaceMeans: { blue: grey(0x33) },
        text: DARK_TEXT
      }),
    /both states/
  )
  assert.throws(
    () =>
      evaluateFloatPatch({
        theme: 'dark',
        windowMeans: { red: grey(0x2b) },
        surfaceMeans: { red: grey(0x33) },
        text: DARK_TEXT
      }),
    /white or black/
  )
})

test('the bleed check needs text under the surface and none through it', () => {
  assert.equal(evaluateFloatBleed({ sharpnessUnder: 777, sharpnessThrough: 0.1 }).pass, true)
  // A 97% coat over the dark sidebar measured 1.34: the tab labels still read.
  const leak = evaluateFloatBleed({ sharpnessUnder: 777, sharpnessThrough: 1.34 })
  assert.equal(leak.checks.noBleed, false)
  const empty = evaluateFloatBleed({ sharpnessUnder: 2, sharpnessThrough: 0.1 })
  assert.equal(empty.checks.textPresent, false)
})

test('rect helpers grow within the window and centre inside a rect', () => {
  assert.deepEqual(
    growRect({ x: 10, y: 8, width: 100, height: 18 }, 30, { width: 120, height: 900 }),
    {
      x: 0,
      y: 0,
      width: 120,
      height: 56
    }
  )
  assert.deepEqual(centredRect({ x: 0, y: 0, width: 400, height: 100 }, 160, 18), {
    x: 120,
    y: 41,
    width: 160,
    height: 18
  })
})

test('the bleed sample starts below the sheen of the surface', () => {
  const surface = { x: 0, y: 0, width: 200, height: 100 }
  assert.deepEqual(belowSheen({ x: 30, y: 30, width: 140, height: 40 }, surface), {
    x: 30,
    y: 37,
    width: 140,
    height: 33
  })
  assert.throws(() => belowSheen({ x: 30, y: 10, width: 140, height: 20 }, surface), /sheen/)
})

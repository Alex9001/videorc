// Floating-glass checks for `probe:ui-glass --surfaces` (plan 072).
//
// A floating surface (menu, popover, hover card, tooltip, dialog, toast) is a
// raised piece of the window glass. The probe paints the real `glass-float`
// utility over a text-free patch of the window and over app text, region-
// captures both states, and these pure helpers score the samples. Calibration
// and the populations: docs/acceptance/2026-09-28-glass-floating-surfaces.md.
//
//   lift         OKLCH lightness of the surface minus the window glass at the
//                same rect, per backdrop. The old near-opaque popover coat
//                measured about -0.1 in dark (a black slab on grey glass).
//   contrast     the text tokens against the surface over white and black
//                backdrops (the plan 050 thresholds)
//   opaque       the surface reads the same over every backdrop. It fails
//                closed on a capture something else obscured (a backdrop
//                stacked over the window washed the whole frame once) and on
//                a coat that went translucent.
//   bleed        app text under the surface must not read through it:
//                sharpness with the surface stays under the window glass
//                ceiling, while the same rect without it proves there was
//                text to hide. (A CSS frost cannot do this job: it never
//                reaches the screen on the vibrancy windows.)

import { contrastRatio, oklchLightness } from './image-stats.mjs'

export const FLOAT_GLASS_THRESHOLDS = Object.freeze({
  lift: Object.freeze({ dark: Object.freeze([-0.02, 0.12]), light: Object.freeze([-0.04, 0.06]) }),
  maxSurfaceSpread: 0.01,
  minTextUnder: 20,
  maxSharpnessThrough: 0.5,
  minPrimaryContrast: 7,
  minSecondaryContrast: 4.5
})

const round = (value, digits = 3) => Number(value.toFixed(digits))

/** Grows a rect (window points) on every side, clamped to the window. */
export function growRect(rect, by, bounds) {
  const x = Math.max(0, rect.x - by)
  const y = Math.max(0, rect.y - by)
  const right = Math.min(bounds.width, rect.x + rect.width + by)
  const bottom = Math.min(bounds.height, rect.y + rect.height + by)
  return { x, y, width: right - x, height: bottom - y }
}

/** A centred sub-rect of at most `width` × `height` inside `rect`. */
export function centredRect(rect, width, height) {
  const w = Math.min(width, rect.width)
  const h = Math.min(height, rect.height)
  return {
    x: rect.x + (rect.width - w) / 2,
    y: rect.y + (rect.height - h) / 2,
    width: w,
    height: h
  }
}

// Mirrors the `transparent 35%` stop of the glass-float sheen in styles.css:
// the gradient's 8-bit banding reads as detail, so the bleed sample starts
// below it.
export const SHEEN_FRACTION = 0.35

/** The part of `rect` below the sheen of a surface painted at `surface`. */
export function belowSheen(rect, surface) {
  const top = Math.max(rect.y, surface.y + surface.height * SHEEN_FRACTION + 2)
  const bottom = rect.y + rect.height
  if (bottom - top < 6) throw new Error('The text sample sits inside the surface sheen.')
  return { x: rect.x, y: top, width: rect.width, height: bottom - top }
}

/**
 * Scores one patch: `windowMeans` and `surfaceMeans` map a backdrop variant
 * (red, blue, white, black, text) to the mean sRGB colour of the same rect
 * without and with the surface. `text` holds the theme's primary and
 * secondary text colours.
 */
export function evaluateFloatPatch({ theme, windowMeans, surfaceMeans, text }) {
  const variants = Object.keys(surfaceMeans).filter((variant) => windowMeans[variant])
  if (!variants.length) throw new Error('No backdrop variant was measured in both states.')
  const surfaceLightness = variants.map((variant) => oklchLightness(surfaceMeans[variant]))
  const lifts = variants.map(
    (variant, index) => surfaceLightness[index] - oklchLightness(windowMeans[variant])
  )
  const surfaceSpread = Math.max(...surfaceLightness) - Math.min(...surfaceLightness)
  const contrastBackdrops = ['white', 'black'].filter((variant) => surfaceMeans[variant])
  if (!contrastBackdrops.length) throw new Error('Contrast needs the white or black backdrop.')
  const primaryContrast = Math.min(
    ...contrastBackdrops.map((variant) => contrastRatio(text.primary, surfaceMeans[variant]))
  )
  const secondaryContrast = Math.min(
    ...contrastBackdrops.map((variant) => contrastRatio(text.secondary, surfaceMeans[variant]))
  )
  const [minLift, maxLift] = FLOAT_GLASS_THRESHOLDS.lift[theme]
  const liftMin = Math.min(...lifts)
  const liftMax = Math.max(...lifts)
  const checks = {
    lift: liftMin >= minLift && liftMax <= maxLift,
    opaque: surfaceSpread <= FLOAT_GLASS_THRESHOLDS.maxSurfaceSpread,
    primaryContrast: primaryContrast >= FLOAT_GLASS_THRESHOLDS.minPrimaryContrast,
    secondaryContrast: secondaryContrast >= FLOAT_GLASS_THRESHOLDS.minSecondaryContrast
  }
  return {
    metrics: {
      liftMin: round(liftMin),
      liftMax: round(liftMax),
      surfaceSpread: round(surfaceSpread),
      primaryContrast: round(primaryContrast, 2),
      secondaryContrast: round(secondaryContrast, 2)
    },
    checks,
    pass: Object.values(checks).every(Boolean)
  }
}

/** Scores the bleed: app text under the surface must not stay legible. */
export function evaluateFloatBleed({ sharpnessUnder, sharpnessThrough }) {
  const checks = {
    textPresent: sharpnessUnder >= FLOAT_GLASS_THRESHOLDS.minTextUnder,
    noBleed: sharpnessThrough <= FLOAT_GLASS_THRESHOLDS.maxSharpnessThrough
  }
  return {
    metrics: {
      sharpnessUnder: round(sharpnessUnder, 2),
      sharpnessThrough: round(sharpnessThrough, 2)
    },
    checks,
    pass: Object.values(checks).every(Boolean)
  }
}

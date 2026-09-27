import { describe, expect, it } from 'vitest'

import { chromiumFeaturesToDisable, mergeDisabledFeatures } from './chromium-disabled-features'

describe('Chromium disabled features', () => {
  it('keeps renderer audio in the main process on macOS only (plan 069)', () => {
    expect(chromiumFeaturesToDisable('darwin')).toEqual(['AudioServiceOutOfProcess'])
    expect(chromiumFeaturesToDisable('win32')).toEqual([])
    expect(chromiumFeaturesToDisable('linux')).toEqual([])
  })

  it('sets the switch when none exists', () => {
    expect(mergeDisabledFeatures('', ['AudioServiceOutOfProcess'])).toBe('AudioServiceOutOfProcess')
  })

  it('merges with an existing value instead of overwriting it', () => {
    expect(mergeDisabledFeatures('CalculateNativeWinOcclusion', ['AudioServiceOutOfProcess'])).toBe(
      'CalculateNativeWinOcclusion,AudioServiceOutOfProcess'
    )
    expect(mergeDisabledFeatures(' A , ,B ', ['C'])).toBe('A,B,C')
  })

  it('leaves the switch alone when every feature is already disabled or none is requested', () => {
    expect(mergeDisabledFeatures('X,AudioServiceOutOfProcess', ['AudioServiceOutOfProcess'])).toBe(
      undefined
    )
    expect(mergeDisabledFeatures('X', [])).toBe(undefined)
  })
})

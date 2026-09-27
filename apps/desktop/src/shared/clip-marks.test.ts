import { describe, expect, it } from 'vitest'

import { clipMarkedToast, formatClipMarkClock } from './clip-marks'

describe('clip mark clock', () => {
  it('reads m:ss below an hour and h:mm:ss from one hour', () => {
    expect(formatClipMarkClock(0)).toBe('0:00')
    expect(formatClipMarkClock(61.9)).toBe('1:01')
    expect(formatClipMarkClock(754.2)).toBe('12:34')
    expect(formatClipMarkClock(3600)).toBe('1:00:00')
    expect(formatClipMarkClock(3725)).toBe('1:02:05')
    expect(formatClipMarkClock(-4)).toBe('0:00')
  })
})

describe('clip marked toast', () => {
  it('says where a saved mark landed', () => {
    expect(
      clipMarkedToast({ sessionId: 's', atSeconds: 754.2, source: 'manual', saved: true })
    ).toEqual({ kind: 'success', title: 'Clip marked at 12:34', description: undefined })
    expect(
      clipMarkedToast({ sessionId: 's', atSeconds: 3725, source: 'voice', saved: true })
    ).toMatchObject({ kind: 'success', title: 'Clip marked at 1:02:05' })
  })

  it('explains an unsaved mark instead of confirming it', () => {
    const toast = clipMarkedToast({
      sessionId: 's',
      atSeconds: 61.5,
      source: 'voice',
      saved: false,
      reason: 'recording-off'
    })
    expect(toast.kind).toBe('warning')
    expect(toast.title).toBe("Recording is off, so this clip can't be saved.")
  })
})

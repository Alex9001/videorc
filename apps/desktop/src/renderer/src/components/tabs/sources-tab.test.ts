import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { systemAudioSwitchView, type SystemAudioSwitchInput } from '@/lib/system-audio'
import { SystemAudioSettings } from './sources-tab'

const noop = (): void => {}

function render(input: Partial<SystemAudioSwitchInput>, macOS = true): string {
  const view = systemAudioSwitchView({
    device: { status: 'available' },
    requested: false,
    sessionActive: false,
    confirmed: null,
    issue: null,
    ...input
  })
  return renderToStaticMarkup(
    createElement(SystemAudioSettings, {
      view,
      gainDb: -6,
      macOS,
      onEnabledChange: noop,
      onGainChange: noop,
      onOpenPermissions: noop
    })
  )
}

describe('Sources System audio settings (plan 069)', () => {
  it('shows the switch, the level at -6 dB and the helper line', () => {
    const markup = render({})
    expect(markup).toContain('System audio')
    expect(markup).toContain('aria-label="System audio"')
    expect(markup).toContain('Level')
    expect(markup).toContain('value="-6"')
    expect(markup).toContain(
      'Everything your computer plays, except Videorc. Use headphones so your mic doesn&#x27;t pick it up twice.'
    )
    expect(markup).toContain(
      'Your Mac&#x27;s volume and mute don&#x27;t change what&#x27;s recorded.'
    )
  })

  it('states the Mac volume fact only on macOS', () => {
    expect(render({}, false)).not.toContain('volume and mute')
  })

  it('keeps Windows copy free of Mac and Screen Recording wording', () => {
    const idle = render({}, false)
    expect(idle).toContain('Everything your computer plays, except Videorc.')
    expect(idle).not.toContain('Screen Recording')
    const failed = render(
      { requested: true, sessionActive: true, confirmed: false, issue: 'unavailable' },
      false
    )
    expect(failed).toContain('System audio could not start.')
    expect(failed).not.toContain('Open Settings')
    const bypassed = render(
      { requested: true, sessionActive: true, confirmed: false, issue: 'bypassed' },
      false
    )
    expect(bypassed).toContain(
      'System audio is off for this session because the microphone is on a fallback input.'
    )
  })

  it('disables the switch and the level without Screen Recording permission', () => {
    const markup = render({ device: { status: 'permission-required' } })
    expect(markup).toContain('Needs Screen Recording permission')
    expect(markup).toContain('Open Settings')
    expect(markup).toMatch(/role="switch"[^>]*disabled=""/)
  })
})

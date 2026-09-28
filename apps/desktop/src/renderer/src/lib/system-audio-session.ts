import type { AudioTrack, HealthEvent } from '@/lib/backend'

// System audio session facts (plan 069 S5) the Studio provider derives. The
// provider sits in the eager chunk, so this module stays tiny; the switch's
// view logic lives in lib/system-audio, which only lazy surfaces import.

export const SYSTEM_AUDIO_LOST_CODE = 'system-audio-lost'
export const SYSTEM_AUDIO_UNAVAILABLE_CODE = 'system-audio-unavailable'

export type SystemAudioIssue = 'lost' | 'unavailable' | 'bypassed'

/**
 * What the running session actually mixes, from `recording.status`:
 * `true`/`false` once a track reports its `mixSources`, `null` while no track
 * does (a backend that predates plan 069, or no session). Null means "not
 * reported", and callers fall back to the requested state.
 */
export function confirmedSystemAudioMix(tracks: AudioTrack[] | undefined): boolean | null {
  const reporting = (tracks ?? []).filter((track) => Array.isArray(track.mixSources))
  if (reporting.length === 0) return null
  return reporting.some((track) => track.mixSources?.includes('system-audio') === true)
}

/**
 * A system-audio health event, reduced to the one fact the UI shows. The
 * Windows bypass (plan 069 S8: the mic fell back to a direct input, so the
 * session cannot mix system audio) is inlined to keep the eager chunk small.
 */
export function systemAudioIssueFromHealthEvent({
  code
}: Pick<HealthEvent, 'code'>): SystemAudioIssue | null {
  if (code === SYSTEM_AUDIO_LOST_CODE) return 'lost'
  if (code === SYSTEM_AUDIO_UNAVAILABLE_CODE) return 'unavailable'
  if (code === 'system-audio-mic-fallback-bypass') return 'bypassed'
  return null
}

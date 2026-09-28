export type SessionRuntimeActivity = 'recording' | 'live-stream'

export type SessionRuntimeNotice =
  | {
      kind: 'recording-failed'
      activity: SessionRuntimeActivity
      message: string
      sessionId?: string
      outputPath?: string
      at: number
    }
  | {
      kind: 'microphone-input-lost'
      audioIssues?: { code: string; message: string }[]
      activity: SessionRuntimeActivity
      phase: 'active' | 'ending' | 'ended'
      message: string
      sessionId?: string
      at: number
    }

export function sessionRuntimeNoticeTitle(notice: SessionRuntimeNotice): string {
  if (notice.kind === 'recording-failed') {
    return notice.activity === 'live-stream'
      ? 'Live session stopped unexpectedly'
      : 'Recording stopped unexpectedly'
  }

  if (notice.audioIssues?.some((issue) => issue.code !== 'microphone-input-lost')) {
    const sources = new Set(
      notice.audioIssues.map((issue) =>
        issue.code.startsWith('microphone-')
          ? 'microphone'
          : issue.code === 'system-audio-lost'
            ? 'system'
            : 'both'
      )
    )
    const subject =
      sources.size > 1 || sources.has('both')
        ? 'Microphone and system audio lost'
        : sources.has('system')
          ? 'System audio lost'
          : 'Microphone audio could not be recorded'
    return notice.phase === 'ended' ? `${subject}: saved session has missing audio` : subject
  }

  if (notice.phase === 'ended') {
    return notice.activity === 'live-stream'
      ? 'Microphone stopped during the live session'
      : 'Microphone stopped: saved recording contains silence'
  }

  if (notice.phase === 'ending') {
    return notice.activity === 'live-stream'
      ? 'Microphone stopped as the live session ends'
      : 'Microphone stopped: finishing recording with silence'
  }

  return notice.activity === 'live-stream'
    ? 'Microphone stopped: live session continues with silence'
    : 'Microphone stopped: recording continues with silence'
}

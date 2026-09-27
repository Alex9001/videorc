import { spawnSync } from 'node:child_process'

// FLV commonly omits stream durations. Incident artifacts must measure both
// ends from real media packets, never treat unavailable duration as a pass.
function timestampMicros(value) {
  if (typeof value !== 'string' || value.trim() === '') return NaN
  const micros = Math.round(Number(value) * 1_000_000)
  return Number.isSafeInteger(micros) ? micros : NaN
}

export function incidentPacketTail(packets) {
  const last = { video: null, audio: null }
  if (!Array.isArray(packets)) return { pass: false, reason: 'Media packet timing unavailable' }
  for (const packet of packets) {
    if (!packet || typeof packet !== 'object')
      return { pass: false, reason: 'Invalid media packet timing row' }
    if (!['video', 'audio'].includes(packet.codec_type)) continue
    const pts = timestampMicros(packet.pts_time)
    const duration = timestampMicros(packet.duration_time)
    if (!Number.isFinite(pts)) return { pass: false, reason: 'Media packet PTS unavailable' }
    // FLV may learn the frame rate only after initial packets. The terminal
    // presentation packet must have a measured duration; earlier N/A values
    // do not prevent observing that final packet's end.
    if (last[packet.codec_type] === null || pts >= last[packet.codec_type].pts)
      last[packet.codec_type] = { pts, duration }
  }
  if (last.video === null || last.audio === null)
    return { pass: false, reason: 'Both video and audio packet ends are required' }
  if (
    Object.values(last).some((packet) => !Number.isFinite(packet.duration) || packet.duration <= 0)
  )
    return { pass: false, reason: 'Terminal media packet duration unavailable' }
  const ends = Object.fromEntries(
    Object.entries(last).map(([kind, packet]) => [kind, packet.pts + packet.duration])
  )
  if (Object.values(ends).some((end) => !Number.isSafeInteger(end)))
    return { pass: false, reason: 'Media packet end exceeds safe microsecond range' }
  // ffprobe reports decimal microseconds. Compare that integer timebase so an
  // exact 100ms boundary cannot become 100.000000000001ms in binary arithmetic.
  const mismatchMicros = Math.abs(ends.video - ends.audio)
  if (!Number.isSafeInteger(mismatchMicros))
    return { pass: false, reason: 'Media packet difference exceeds safe microsecond range' }
  const tailMismatchMs = mismatchMicros / 1000
  return {
    pass: mismatchMicros <= 100_000,
    tailMismatchMs,
    videoEndSeconds: ends.video / 1_000_000,
    audioEndSeconds: ends.audio / 1_000_000,
    provenance:
      'Terminal presentation packet timestamp plus its measured duration, separately for video and audio',
    reason:
      mismatchMicros <= 100_000
        ? null
        : `Packet A/V tail mismatch ${tailMismatchMs.toFixed(1)}ms exceeds 100ms`
  }
}

export function probeIncidentPacketTail(filePath, ffprobePath) {
  const result = spawnSync(
    ffprobePath,
    [
      '-v',
      'error',
      '-show_entries',
      'packet=codec_type,pts_time,duration_time',
      '-of',
      'json',
      filePath
    ],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }
  )
  if (result.status !== 0 || result.error)
    return { pass: false, reason: 'Bounded packet timing probe failed' }
  try {
    return incidentPacketTail(JSON.parse(result.stdout).packets)
  } catch {
    return { pass: false, reason: 'Invalid packet timing report' }
  }
}

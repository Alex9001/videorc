import { incidentPacketTail } from './windows-incident-packet-tail.mjs'

export const openh264ComparisonCases = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 }
].flatMap((profile) =>
  ['pattern', 'terminal-noise'].map((content) => ({
    ...profile,
    content,
    fps: 30,
    seconds: 3,
    bitrateKbps: 6000
  }))
)

export function openh264ComparisonArgs(profile, skip, video, audio, output) {
  if (![0, 1].includes(skip)) throw new Error('Frame skipping must be explicitly zero or one')
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-n',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'yuv420p',
    '-video_size',
    `${profile.width}x${profile.height}`,
    '-framerate',
    String(profile.fps),
    '-i',
    video,
    '-f',
    'f32le',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-i',
    audio,
    '-vf',
    `setpts=PTS-STARTPTS,fps=${profile.fps},setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libopenh264',
    '-rc_mode',
    'bitrate',
    '-allow_skip_frames',
    String(skip),
    '-b:v',
    `${profile.bitrateKbps}k`,
    '-maxrate',
    `${profile.bitrateKbps}k`,
    '-bufsize',
    `${profile.bitrateKbps * 2}k`,
    '-g',
    String(profile.fps * 2),
    '-force_key_frames',
    'expr:gte(t,n_forced*2)',
    '-flags',
    '+global_header',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-bsf:v',
    'h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1',
    '-fps_mode',
    'vfr',
    '-af',
    'aresample=async=1:first_pts=0,apad',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-shortest',
    '-f',
    'flv',
    output
  ]
}

export function measureOpenh264Comparison(profile, packets, wallMs) {
  if (!Array.isArray(packets) || !Number.isFinite(wallMs) || wallMs <= 0)
    throw new Error('Missing bounded encoding measurement')
  const video = packets.filter((packet) => packet?.codec_type === 'video')
  if (
    !video.length ||
    video.some(
      (packet) =>
        typeof packet.pts_time !== 'string' ||
        packet.pts_time.trim() === '' ||
        !Number.isFinite(Number(packet.pts_time)) ||
        typeof packet.size !== 'string' ||
        packet.size.trim() === '' ||
        !Number.isInteger(Number(packet.size)) ||
        Number(packet.size) <= 0
    )
  )
    throw new Error('Invalid video packet measurement')
  const bytes = video.reduce((sum, packet) => sum + Number(packet.size), 0)
  const ordered = video
    .map((packet) => ({ pts: Number(packet.pts_time), bytes: Number(packet.size) }))
    .sort((a, b) => a.pts - b.pts)
  let first = 0,
    windowBytes = 0,
    maxTwoSecondBytes = 0
  for (let last = 0; last < ordered.length; last++) {
    windowBytes += ordered[last].bytes
    while (ordered[last].pts - ordered[first].pts >= 2) windowBytes -= ordered[first++].bytes
    maxTwoSecondBytes = Math.max(maxTwoSecondBytes, windowBytes)
  }
  const tail = incidentPacketTail(packets)
  if (!Number.isFinite(tail.tailMismatchMs)) throw new Error(tail.reason)
  return {
    expectedVideoFrames: profile.fps * profile.seconds,
    encodedVideoFrames: video.length,
    missingVideoFrames: profile.fps * profile.seconds - video.length,
    packetTail: tail,
    encodedVideoBytes: bytes,
    videoKbpsPerInputDuration: (bytes * 8) / profile.seconds / 1000,
    maxTwoSecondVideoKbps: (maxTwoSecondBytes * 8) / 2 / 1000,
    requestedMaxrateKbps: profile.bitrateKbps,
    requestedBufferKbits: profile.bitrateKbps * 2,
    // A VBV buffer permits bursts; report both raw rate and its rate+buffer envelope.
    twoSecondRatePlusBufferEnvelopeExceeded:
      (maxTwoSecondBytes * 8) / 1000 > profile.bitrateKbps * 2 + profile.bitrateKbps * 2,
    wallMs,
    encodingFramesPerSecond: (video.length * 1000) / wallMs,
    inputDurationOverEncodeWallTime: (profile.seconds * 1000) / wallMs
  }
}

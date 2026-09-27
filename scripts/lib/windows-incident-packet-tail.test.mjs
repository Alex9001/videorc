import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ffmpegAvailable } from './ffmpeg-available.mjs'
import { probeMedia } from './recording-analyzer.mjs'
import { incidentPacketTail, probeIncidentPacketTail } from './windows-incident-packet-tail.mjs'

const ffmpeg = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobe = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const encoders =
  spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10000 }).stdout ??
  ''
const encoder = ['libx264', 'libopenh264', 'h264_videotoolbox'].find((name) =>
  encoders.includes(name)
)

test('packet-tail gate rejects missing ends and invalid timing instead of passing unknown FLV duration', () => {
  for (const packets of [
    null,
    [],
    [null],
    [{ codec_type: 'audio', pts_time: null, duration_time: '0.021' }],
    [{ codec_type: 'video', pts_time: '', duration_time: '0.033' }],
    [{ codec_type: 'video', pts_time: '0', duration_time: '0.033' }],
    [{ codec_type: 'audio', pts_time: 'N/A', duration_time: '0.021' }]
  ])
    assert.equal(incidentPacketTail(packets).pass, false)
})

test(
  'real FLV packet ends expose excess audio tail even when stream durations are absent',
  {
    skip: encoder && ffmpegAvailable(ffprobe) ? false : 'FFmpeg/ffprobe unavailable'
  },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'videorc-incident-tail-'))
    try {
      for (const audioDuration of [2, 2.4]) {
        const path = join(directory, `audio-${audioDuration}.flv`)
        const generated = spawnSync(
          ffmpeg,
          [
            '-v',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=160x90:rate=30:duration=2',
            '-f',
            'lavfi',
            '-i',
            `sine=frequency=880:sample_rate=48000:duration=${audioDuration}`,
            '-c:v',
            encoder,
            '-c:a',
            'aac',
            '-f',
            'flv',
            path
          ],
          { timeout: 30000, maxBuffer: 1024 * 1024 }
        )
        assert.equal(generated.status, 0, generated.stderr?.toString())
        const media = await probeMedia(path, { ffprobePath: ffprobe })
        assert.equal(media.video.duration, null)
        assert.equal(media.audio[0].duration, null)
        const measured = probeIncidentPacketTail(path, ffprobe)
        assert.equal(measured.pass, audioDuration === 2, JSON.stringify(measured))
        assert.ok(Number.isFinite(measured.tailMismatchMs))
        if (audioDuration > 2) assert.ok(measured.tailMismatchMs > 350)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  openh264ComparisonArgs,
  openh264ComparisonCases,
  measureOpenh264Comparison
} from './windows-openh264-comparison.mjs'

test('OpenH264 A/B retains identical finite input and shipping encode options except skip/output', () => {
  assert.equal(openh264ComparisonCases.length, 4)
  const profile = openh264ComparisonCases[0]
  const one = openh264ComparisonArgs(profile, 1, 'same.yuv', 'same.pcm', 'same.flv')
  const zero = openh264ComparisonArgs(profile, 0, 'same.yuv', 'same.pcm', 'same.flv')
  assert.deepEqual(
    one
      .map((value, index) => (value !== zero[index] ? index : null))
      .filter((value) => value !== null),
    [one.indexOf('-allow_skip_frames') + 1]
  )
  assert.equal(one[one.indexOf('-maxrate') + 1], '6000k')
  assert.equal(one[one.indexOf('-bufsize') + 1], '12000k')
  assert.equal(one[one.indexOf('-g') + 1], '60')
  assert.equal(one.includes('-profile:v'), false, 'Windows OpenH264 leaves profile to encoder')
})
test('measurement exposes missing terminal frames and bandwidth cost without declaring qualification', () => {
  const profile = { fps: 30, seconds: 3, bitrateKbps: 6000 }
  const video = Array.from({ length: 84 }, (_, i) => ({
    codec_type: 'video',
    pts_time: String(i / 30),
    duration_time: String(1 / 30),
    size: '1000'
  }))
  const packets = [
    ...video,
    { codec_type: 'audio', pts_time: '2.98', duration_time: '0.02', size: '100' }
  ]
  const measured = measureOpenh264Comparison(profile, packets, 1000)
  assert.equal(measured.missingVideoFrames, 6)
  assert.equal(measured.packetTail.pass, false)
  assert.ok(measured.packetTail.tailMismatchMs > 190)
  assert.equal(measured.encodedVideoBytes, 84000)
  assert.equal(measured.encodingFramesPerSecond, 84)
  assert.throws(() => measureOpenh264Comparison(profile, video, 1000), /Both video and audio/)
})

test('missing and empty packet values fail closed rather than becoming zero', () => {
  const profile = { fps: 30, seconds: 3, bitrateKbps: 6000 }
  for (const bad of [
    { pts_time: null, size: '100' },
    { pts_time: '', size: '100' },
    { pts_time: '0', size: null },
    { pts_time: '0', size: '' }
  ])
    assert.throws(
      () =>
        measureOpenh264Comparison(
          profile,
          [{ codec_type: 'video', duration_time: '0.03', ...bad }],
          100
        ),
      /Invalid video packet/
    )
})

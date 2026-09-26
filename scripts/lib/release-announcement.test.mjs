import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAnnouncementIdentity, sendReleaseAnnouncement } from './release-announcement.mjs'
test('confirmed send is not repeated and ambiguous send is not retried', async () => {
  const common = {
    identity: {},
    content: 'release',
    begin: async () => ({ status: 'applied' }),
    send: () => assert.fail('must not resend'),
    confirm: () => assert.fail()
  }
  assert.equal(
    (
      await sendReleaseAnnouncement({
        ...common,
        existing: { status: 'confirmed', messageId: '123' }
      })
    ).reused,
    true
  )
  await assert.rejects(sendReleaseAnnouncement({ ...common, existing: { status: 'unknown' } }), {
    code: 'announcement-unknown'
  })
})
test('unknown intent precedes network side effect; lost response retains unknown', async () => {
  const calls = []
  await assert.rejects(
    sendReleaseAnnouncement({
      identity: {},
      content: 'release',
      begin: async () => {
        calls.push('unknown')
        return { status: 'applied' }
      },
      send: async () => {
        calls.push('send')
        throw new Error('lost response')
      },
      confirm: () => assert.fail()
    }),
    /lost response/
  )
  assert.deepEqual(calls, ['unknown', 'send'])
})
test('held platform is excluded from live announcement identity', () => {
  const request = {
    identity: { releaseIds: { windows: '1.2.3-alpha.1' } },
    platforms: {
      windows: { phase: 'live', production: { complete: true } },
      linux: { phase: 'failed' }
    }
  }
  assert.throws(
    () =>
      buildAnnouncementIdentity({
        request,
        platform: 'windows',
        channel: 'discord',
        entry: { version: '1.2.3-alpha.1', platforms: ['windows', 'linux'] }
      }),
    { code: 'announcement-held-platform' }
  )
})

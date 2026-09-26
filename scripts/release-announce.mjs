import { randomUUID } from 'node:crypto'
import { createReleaseClient } from './lib/release-client.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { requireRelease } from './lib/release-github.mjs'
import { buildAnnouncementIdentity, sendReleaseAnnouncement } from './lib/release-announcement.mjs'
import { buildDiscordReleaseMessage } from './notify-discord-release.mjs'

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((value) => value !== '--'),
    options: {
      request: { type: 'string' },
      platform: { type: 'string' },
      'dry-run': { type: 'boolean' },
      authorized: { type: 'boolean' },
      channel: { type: 'string', default: 'discord' },
      'message-id': { type: 'string' }
    }
  })
  const client = createReleaseClient()
  try {
    const requestId = values.request ?? process.env.RELEASE_REQUEST_ID
    const platform = values.platform ?? process.env.RELEASE_PLATFORM
    const state = await client.snapshot()
    const request = state.requests[requestId]
    requireRelease(request, 'announcement-request', 'Choose the exact release request.')
    const response = await fetch('https://www.videorc.com/api/changelog', {
      signal: AbortSignal.timeout(30_000)
    })
    requireRelease(response.ok, 'announcement-changelog', 'Published changelog is unavailable.')
    const changelog = await response.json()
    const entry = changelog.entries.find(
      (candidate) => candidate.version === request.identity.releaseIds[platform]
    )
    requireRelease(
      entry,
      'announcement-changelog',
      'Exact release is absent from public changelog.'
    )
    const identity = buildAnnouncementIdentity({
      request,
      platform,
      channel: values.channel,
      entry
    })
    const content =
      values.channel === 'discord'
        ? buildDiscordReleaseMessage(entry)
        : `# ${entry.title}\n\n${entry.summary}\n\n${entry.body}\n`
    if (
      values['dry-run'] ||
      (values.channel === 'discord' && !values.authorized && !values['message-id'])
    ) {
      console.log(content)
      return
    }
    if (values.channel === 'blog') {
      const directory = join('dist', 'release-blog-drafts')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `${entry.version}-${platform}.md`), content)
      console.log(
        'Exact published changelog draft written; external blog publication remains pending.'
      )
      return
    }
    requireRelease(
      values.authorized,
      'announcement-authorization',
      'Sending requires --authorized from a release invocation that authorized announcements.'
    )
    const webhook = process.env.VIDEORC_DISCORD_RELEASE_WEBHOOK
    requireRelease(
      webhook && /^https:\/\/(discord.com|discordapp.com)\/api\/webhooks\//.test(webhook),
      'announcement-webhook',
      'Configure the Discord webhook through the release environment.'
    )
    const operation = (type, announcement) =>
      client.submit({
        id: randomUUID(),
        expectedRevision: state.revision,
        type,
        requestId,
        platform,
        announcement
      })
    if (values['message-id']) {
      requireRelease(
        /^\d+$/.test(values['message-id']),
        'announcement-message',
        'Discord message ID must be numeric.'
      )
      const response = await fetch(`${webhook}/messages/${values['message-id']}`, {
        signal: AbortSignal.timeout(30_000)
      })
      requireRelease(
        response.ok,
        'announcement-reconcile',
        'Remote message could not be inspected.'
      )
      const message = await response.json()
      requireRelease(
        message.content === content,
        'announcement-content',
        'Remote message does not match exact published content.'
      )
      await operation('announcement-result', {
        ...identity,
        status: 'confirmed',
        messageId: message.id
      })
      return
    }
    const result = await sendReleaseAnnouncement({
      identity,
      existing: request.platforms[platform].announcements[identity.key],
      content,
      begin: (receipt) => operation('announcement-intent', receipt),
      confirm: (receipt) => operation('announcement-result', receipt),
      send: async (message) => {
        const url = new URL(webhook)
        url.searchParams.set('wait', 'true')
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: message, flags: 4, allowed_mentions: { parse: [] } }),
          signal: AbortSignal.timeout(30_000)
        })
        requireRelease(
          response.ok,
          'announcement-send-unknown',
          'Discord send did not confirm success. Reconcile before retrying.'
        )
        return response.json()
      }
    })
    console.log(JSON.stringify(result))
  } finally {
    /* No local Windows storage or signing credential is needed. */
  }
}
main().catch((error) => {
  console.error(`release-announce: ${error.code ?? 'error'}: ${error.message}`)
  process.exitCode = 1
})

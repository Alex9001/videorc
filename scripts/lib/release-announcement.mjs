import { releaseDigest } from './release-state.mjs'
import { requireRelease } from './release-github.mjs'

export function buildAnnouncementIdentity({ request, platform, channel, entry }) {
  const phase = request.platforms[platform]
  requireRelease(
    phase?.phase === 'live' &&
      phase.production?.complete === true &&
      entry.version === request.identity.releaseIds[platform] &&
      entry.platforms.includes(platform),
    'announcement-not-live',
    'Announce only the exact verified live release.'
  )
  requireRelease(
    entry.platforms.every((name) => request.platforms[name]?.phase === 'live'),
    'announcement-held-platform',
    'Published copy includes a platform this request has not verified live.'
  )
  const contentHash = releaseDigest(entry)
  return {
    key: releaseDigest({ releaseId: entry.version, platform, channel, contentHash }),
    channel,
    contentHash
  }
}

export async function sendReleaseAnnouncement({
  identity,
  existing,
  content,
  begin,
  send,
  confirm
}) {
  if (existing?.status === 'confirmed')
    return { status: 'confirmed', messageId: existing.messageId, reused: true }
  requireRelease(
    !existing,
    'announcement-unknown',
    'Previous send may have succeeded. Reconcile the remote message before retrying.'
  )
  const intent = await begin(identity)
  requireRelease(
    intent.status === 'applied',
    'announcement-owned',
    'Another sender owns this announcement; reconcile its outcome.'
  )
  const message = await send(content) // Any error leaves durable unknown, never an automatic resend.
  requireRelease(
    typeof message.id === 'string' && message.id.length > 0,
    'announcement-response',
    'Remote send returned no message identity; reconcile before retrying.'
  )
  await confirm({ ...identity, status: 'confirmed', messageId: message.id })
  return { status: 'confirmed', messageId: message.id }
}

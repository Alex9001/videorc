import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

export const RELEASE_REPOSITORY = 'TheOrcDev/videorc'
export const RELEASE_ENVIRONMENT = 'windows-alpha-release'
export const RELEASE_WORKFLOWS = Object.freeze({
  build: '.github/workflows/release-windows-alpha.yml',
  sign: '.github/workflows/sign-windows-alpha.yml',
  pilot: '.github/workflows/promote-windows-alpha.yml',
  public: '.github/workflows/promote-windows-alpha.yml',
  'macos-finalize': '.github/workflows/finalize-macos-beta.yml'
})

export class ReleaseError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReleaseError'
    this.code = code
  }
}
export function requireRelease(condition, code, message) {
  if (!condition) throw new ReleaseError(code, message)
}

// gh inherits the operator's existing credential. Never put it in a workflow.
export function createReleaseGithub({ execute = execFileSync, sleep = delay } = {}) {
  return {
    async api(path, { method = 'GET', body, retries = 3 } = {}) {
      requireRelease(
        path.startsWith('/') &&
          !path
            .split('?')[0]
            .split('/')
            .some((segment) => segment === '..' || segment === '.'),
        'github-path',
        'Invalid GitHub API path.'
      )
      for (let attempt = 0; ; attempt++) {
        try {
          const args = ['api', path, '--method', method]
          if (body !== undefined) args.push('--input', '-')
          const output = execute('gh', args, {
            encoding: 'utf8',
            input: body === undefined ? undefined : JSON.stringify(body),
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60_000,
            maxBuffer: 32 * 1024 * 1024
          })
          return output.trim() ? JSON.parse(output) : null
        } catch (error) {
          const details = String(error.stderr ?? '')
          // Only reads are automatically retried. A timed-out write may have committed.
          if (
            method === 'GET' &&
            attempt < retries &&
            /HTTP (429|502|503|504)|rate limit/i.test(details)
          ) {
            await sleep(Math.min(30_000, 1000 * 2 ** attempt))
            continue
          }
          throw new ReleaseError(
            method === 'GET' ? 'github-read-failed' : 'github-write-unknown',
            /HTTP 403/.test(details)
              ? 'GitHub denied this identity. Check reviewer capability and token permissions; no bypass was attempted.'
              : `GitHub ${method} failed; ${method === 'GET' ? 'check authentication and connectivity' : 'reconcile remote state before retrying'}.`
          )
        }
      }
    }
  }
}

export async function githubPages(github, path, field) {
  const result = []
  for (let page = 1; ; page++) {
    const data = await github.api(
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`
    )
    const entries = field ? data[field] : data
    requireRelease(Array.isArray(entries), 'github-response', 'GitHub returned an invalid list.')
    result.push(...entries)
    if (entries.length < 100) return result
  }
}

export async function readReleaseRun(github, runId, attempt = null) {
  requireRelease(
    /^[1-9][0-9]*$/.test(String(runId)),
    'run-id',
    'An exact numeric run ID is required.'
  )
  const base = `/repos/${RELEASE_REPOSITORY}/actions/runs/${runId}`
  const run = await github.api(base)
  const selectedAttempt = attempt ?? run.run_attempt
  const jobs = await githubPages(github, `${base}/attempts/${selectedAttempt}/jobs`, 'jobs')
  const pending = await github.api(`${base}/pending_deployments`)
  return { run, jobs, pending }
}

// Pure, inspectable decision. All observations must come from the API/registry,
// not a run name or an unsigned caller assertion.
export function deploymentApprovalDecision({
  expected,
  run,
  jobs,
  pending,
  source,
  request = null,
  acceptance = null
}) {
  const refuse = (reason) => ({ approve: false, reason, environmentIds: [] })
  if (run.repository?.full_name !== RELEASE_REPOSITORY) return refuse('repository-mismatch')
  if (String(run.id) !== String(expected.runId) || run.run_attempt !== expected.attempt)
    return refuse('run-or-attempt-mismatch')
  const path =
    expected.stage === 'legacy-sign' ? RELEASE_WORKFLOWS.build : RELEASE_WORKFLOWS[expected.stage]
  if (!path || run.path !== path) return refuse('workflow-or-stage-mismatch')
  if (run.event !== 'workflow_dispatch' || run.head_branch !== 'main')
    return refuse('untrusted-dispatch')
  if (run.head_sha !== expected.toolingSha || source.sha !== expected.sourceSha)
    return refuse('source-mismatch')
  if (
    source.releaseId !== expected.releaseId ||
    source.version !== expected.releaseId.replace(/-(alpha|beta)\.\d+$/, '')
  )
    return refuse('release-mismatch')
  if (request) {
    if (
      request.id !== expected.requestId ||
      request.sourceSha !== source.sha ||
      request.toolingSha !== run.head_sha ||
      request.superseded
    )
      return refuse('request-ineligible')
  } else if (source.currentMainSha !== source.sha || run.head_sha !== source.sha)
    return refuse('stale-legacy-source')
  if (
    !/^\d+\.\d+\.\d+-alpha\.1$/.test(source.releaseId) ||
    !source.changelog?.platforms?.includes('windows')
  )
    return refuse('windows-release-required')
  const requiredJobs =
    expected.stage === 'legacy-sign'
      ? ['Build and test unsigned candidate payload']
      : ['Verify exact request before protected review']
  if (
    requiredJobs.some(
      (name) => !jobs.some((job) => job.name === name && job.conclusion === 'success')
    )
  )
    return refuse('prerequisite-failed-or-missing')
  if (
    expected.stage === 'public' &&
    (!acceptance ||
      !['PASS', 'waived'].includes(acceptance.status) ||
      acceptance.sourceSha !== source.sha ||
      acceptance.releaseId !== source.releaseId ||
      acceptance.installerSha256 !== expected.installerSha256)
  )
    return refuse('acceptance-required')
  const target = pending.filter((entry) => entry.environment?.name === RELEASE_ENVIRONMENT)
  if (target.length === 0) return refuse('already-reviewed-or-not-pending')
  if (target.length !== 1 || pending.length !== 1) return refuse('unexpected-environment')
  if (target[0].current_user_can_approve !== true) return refuse('reviewer-not-authorized')
  if (!Number.isSafeInteger(target[0].environment.id)) return refuse('environment-id-invalid')
  return {
    approve: true,
    reason: 'exact-request-eligible',
    environmentIds: [target[0].environment.id]
  }
}

export async function approveReleaseDeployment(github, observation, { dryRun = false } = {}) {
  const decision = deploymentApprovalDecision(observation)
  if (!decision.approve || dryRun) return decision
  const { expected } = observation
  await github.api(
    `/repos/${RELEASE_REPOSITORY}/actions/runs/${expected.runId}/pending_deployments`,
    {
      method: 'POST',
      body: {
        environment_ids: decision.environmentIds,
        state: 'approved',
        comment: `Videorc exact-release review: ${expected.releaseId}; source ${expected.sourceSha}; run ${expected.runId}/${expected.attempt}; stage ${expected.stage}. Physical acceptance is separate.`
      }
    }
  )
  return { ...decision, submitted: true }
}

export async function readSourceIdentity(github, sourceSha, releaseId) {
  requireRelease(
    /^[a-f0-9]{40}$/.test(sourceSha) && /^\d+\.\d+\.\d+-(alpha|beta)\.\d+$/.test(releaseId),
    'source-identity',
    'Full source SHA and exact release ID are required.'
  )
  const base = `/repos/${RELEASE_REPOSITORY}`
  const [pkg, entry, main] = await Promise.all([
    github.api(`${base}/contents/apps/desktop/package.json?ref=${sourceSha}`),
    github.api(`${base}/contents/changelog/${releaseId}.md?ref=${sourceSha}`),
    github.api(`${base}/commits/main`)
  ])
  const packageJson = JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf8'))
  const { parseChangelogEntry } = await import('./changelog.mjs')
  const changelog = parseChangelogEntry(Buffer.from(entry.content, 'base64').toString('utf8'), {
    filename: `${releaseId}.md`
  })
  return {
    sha: sourceSha,
    releaseId: changelog.version,
    version: packageJson.version,
    currentMainSha: main.sha,
    changelog
  }
}

export async function preflightReleaseReviewer(github) {
  const [actor, environment] = await Promise.all([
    github.api('/user'),
    github.api(`/repos/${RELEASE_REPOSITORY}/environments/${RELEASE_ENVIRONMENT}`)
  ])
  const reviewers = (environment.protection_rules ?? [])
    .filter((rule) => rule.type === 'required_reviewers')
    .flatMap((rule) => rule.reviewers ?? [])
  const direct = reviewers.some((entry) => entry.type === 'User' && entry.reviewer?.id === actor.id)
  requireRelease(
    direct && environment.prevent_self_review !== true,
    'reviewer-preflight',
    'Current GitHub session is not a directly eligible self-reviewing release reviewer. Resolve the exact environment capability before starting a new Windows build.'
  )
  return {
    actor: actor.login,
    environment: RELEASE_ENVIRONMENT,
    capability: 'eligible-reviewer; pending deployment is checked again before approval'
  }
}

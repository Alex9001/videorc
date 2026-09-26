import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deploymentApprovalDecision,
  approveReleaseDeployment,
  createReleaseGithub
} from './release-github.mjs'
const sha = 'a'.repeat(40)
const observation = () => ({
  expected: {
    runId: 42,
    attempt: 1,
    toolingSha: sha,
    sourceSha: sha,
    releaseId: '1.2.3-alpha.1',
    stage: 'legacy-sign'
  },
  run: {
    id: 42,
    run_attempt: 1,
    repository: { full_name: 'TheOrcDev/videorc' },
    path: '.github/workflows/release-windows-alpha.yml',
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: sha
  },
  jobs: [{ name: 'Build and test unsigned candidate payload', conclusion: 'success' }],
  pending: [
    { environment: { name: 'windows-alpha-release', id: 7 }, current_user_can_approve: true }
  ],
  source: {
    sha,
    currentMainSha: sha,
    releaseId: '1.2.3-alpha.1',
    version: '1.2.3',
    changelog: { platforms: ['windows'] }
  }
})
test('eligible exact run uses structured deployment review', async () => {
  const calls = []
  const result = await approveReleaseDeployment(
    { api: async (...args) => calls.push(args) },
    observation()
  )
  assert.equal(result.submitted, true)
  assert.deepEqual(calls[0][1].body.environment_ids, [7])
  assert.equal(calls[0][1].body.state, 'approved')
})
for (const [name, mutate] of Object.entries({
  source: (o) => {
    o.run.head_sha = 'b'.repeat(40)
  },
  run: (o) => {
    o.run.id++
  },
  attempt: (o) => {
    o.run.run_attempt++
  },
  stage: (o) => {
    o.expected.stage = 'public'
  },
  environment: (o) => {
    o.pending[0].environment.name = 'production'
  },
  unauthorized: (o) => {
    o.pending[0].current_user_can_approve = false
  },
  failed: (o) => {
    o.jobs[0].conclusion = 'failure'
  },
  missing: (o) => {
    o.jobs = []
    o.expected.prerequisiteJobs = []
  },
  reviewed: (o) => {
    o.pending = []
  },
  stale: (o) => {
    o.source.currentMainSha = 'b'.repeat(40)
  },
  wrongPlatform: (o) => {
    o.source.changelog.platforms = ['macos']
  },
  superseded: (o) => {
    o.request = { id: 'request-a', sourceSha: sha, toolingSha: sha, superseded: true }
    o.expected.requestId = 'request-a'
  }
}))
  test(`refuses ${name} before any write`, async () => {
    const o = observation()
    mutate(o)
    assert.equal(
      (await approveReleaseDeployment({ api: () => assert.fail('unexpected write') }, o)).approve,
      false
    )
  })
test('dry run and ambiguous response never repeat approval', async () => {
  let calls = 0
  const github = createReleaseGithub({
    execute: () => {
      calls++
      throw new Error('lost response')
    }
  })
  assert.equal(
    (await approveReleaseDeployment(github, observation(), { dryRun: true })).approve,
    true
  )
  assert.equal(calls, 0)
  await assert.rejects(approveReleaseDeployment(github, observation()), {
    code: 'github-write-unknown'
  })
  assert.equal(calls, 1)
})
test('rate limited reads use bounded backoff', async () => {
  let calls = 0
  const waits = []
  const github = createReleaseGithub({
    execute: () => {
      if (++calls < 3) throw Object.assign(new Error(), { stderr: 'HTTP 429' })
      return '{}'
    },
    sleep: async (ms) => waits.push(ms)
  })
  await github.api('/user')
  assert.deepEqual(waits, [1000, 2000])
})
test('adapter permits the GitHub compare delimiter but denies traversal segments', async () => {
  const github = createReleaseGithub({ execute: () => '{}' })
  assert.deepEqual(await github.api(`/repos/TheOrcDev/videorc/compare/${sha}...${sha}`), {})
  await assert.rejects(github.api('/repos/../secrets'), { code: 'github-path' })
})

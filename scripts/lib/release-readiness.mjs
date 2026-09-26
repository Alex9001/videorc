import { randomUUID } from 'node:crypto'
import { requireRelease, RELEASE_REPOSITORY, preflightReleaseReviewer } from './release-github.mjs'

export async function verifyReadonlyStateCredential(store) {
  requireRelease(
    await store.read('capability.json'),
    'readiness-probe',
    'Controller conditional storage probe has not completed.'
  )
  let denied = false
  try {
    await store.write(`probes/readonly-denial-${randomUUID()}.json`, {
      harmlessAuthorityProbe: true
    })
  } catch (error) {
    denied = error.code === 'control-write' && /HTTP 403/.test(error.message)
  }
  requireRelease(
    denied,
    'readiness-state-writer',
    'Worker state credential is not demonstrably read-only: its harmless canary PUT must return HTTP 403.'
  )
  return { stateRead: 'PASS', stateWriteDenied: 'PASS' }
}

export async function inspectReleaseReadiness(github) {
  const checks = []
  const check = (name, pass) => checks.push({ name, status: pass ? 'PASS' : 'FAIL' })
  const branch = await github.api(`/repos/${RELEASE_REPOSITORY}/branches/main`)
  check('protected-main', branch.protected === true)
  for (const name of ['release-control-submit', 'release-control', 'release-publication']) {
    try {
      const environment = await github.api(`/repos/${RELEASE_REPOSITORY}/environments/${name}`)
      const policies = await github.api(
        `/repos/${RELEASE_REPOSITORY}/environments/${name}/deployment-branch-policies`
      )
      check(
        `${name}:main-only`,
        environment.deployment_branch_policy?.custom_branch_policies === true &&
          !environment.deployment_branch_policy?.protected_branches &&
          policies.branch_policies.length === 1 &&
          policies.branch_policies[0].name === 'main' &&
          policies.branch_policies[0].type === 'branch'
      )
      check(
        `${name}:no-review-or-wait`,
        !(environment.protection_rules ?? []).some(
          (rule) =>
            rule.type === 'required_reviewers' ||
            (rule.type === 'wait_timer' && rule.wait_timer > 0)
        )
      )
      const secretNames = (
        await github.api(`/repos/${RELEASE_REPOSITORY}/environments/${name}/secrets`)
      ).secrets.map((secret) => secret.name)
      const role =
        name === 'release-control'
          ? 'WRITE'
          : name === 'release-control-submit'
            ? 'SUBMIT'
            : 'FINALIZE'
      check(
        `${name}:credential-names`,
        ['', 'DATA_'].every((part) =>
          ['ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'].every((suffix) =>
            secretNames.includes(`VIDEORC_RELEASE_CONTROL_${part}${role}_S3_${suffix}`)
          )
        )
      )
    } catch {
      check(`${name}:configured`, false)
    }
  }
  const variables = (
    await github.api(`/repos/${RELEASE_REPOSITORY}/actions/variables?per_page=100`)
  ).variables
  check(
    'controller-flag-enabled',
    variables.some(
      (value) => value.name === 'VIDEORC_RELEASE_CONTROLLER_ENABLED' && value.value === 'true'
    )
  )
  for (const workflow of [
    'release-windows-alpha.yml',
    'promote-windows-alpha.yml',
    'release-macos.yml'
  ]) {
    const runs = (
      await github.api(
        `/repos/${RELEASE_REPOSITORY}/actions/workflows/${workflow}/runs?per_page=100`
      )
    ).workflow_runs
    check(
      `${workflow}:no-inflight-at-cutover`,
      runs.every((run) => run.status === 'completed')
    )
  }
  try {
    await preflightReleaseReviewer(github)
    check('authorized-windows-reviewer', true)
  } catch {
    check('authorized-windows-reviewer', false)
  }
  return {
    status: checks.every((entry) => entry.status === 'PASS')
      ? 'CONFIGURED_EXTERNAL_EVIDENCE_REQUIRED'
      : 'NOT_READY',
    checks,
    externalEvidenceRequired: [
      'actual worker state PUT denial',
      'conditional storage probe',
      'cold/warm candidate and interrupted hosted rehearsals',
      'physical acceptance or maintained owner waiver',
      'no unresolved D3/publication generation'
    ]
  }
}

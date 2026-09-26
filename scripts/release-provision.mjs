import { publicationOriginIdentity } from './release-control.mjs'
import { inspectReleaseReadiness, verifyReadonlyStateCredential } from './lib/release-readiness.mjs'
import { createReleaseControlStore, controlStoreConfig } from './lib/release-control-store.mjs'
// Declarative, read-only by default. Never copies secrets or enables the new
// writer automatically. Readiness is an explicit rollout decision after rehearsal.
import { parseArgs } from 'node:util'
import { createReleaseGithub, RELEASE_REPOSITORY, requireRelease } from './lib/release-github.mjs'

const environments = ['release-control-submit', 'release-control', 'release-publication']
const contract = {
  environments: Object.fromEntries(
    environments.map((name) => [
      name,
      {
        wait_timer: 0,
        prevent_self_review: false,
        reviewers: [],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
      }
    ])
  ),
  repositoryVariables: {
    VIDEORC_RELEASE_CONTROLLER_ENABLED: 'false',
    VIDEORC_RELEASE_CONTROL_PREFIX: 'videorc-release-control/v1'
  },
  requiredPrivateControlVariables: [
    'VIDEORC_RELEASE_CONTROL_S3_BUCKET',
    'VIDEORC_RELEASE_CONTROL_S3_REGION',
    'VIDEORC_RELEASE_CONTROL_S3_ENDPOINT_URL',
    'VIDEORC_RELEASE_CONTROL_S3_FORCE_PATH_STYLE',
    'VIDEORC_RELEASE_CONTROL_DATA_S3_BUCKET',
    'VIDEORC_RELEASE_CONTROL_DATA_S3_REGION',
    'VIDEORC_RELEASE_CONTROL_DATA_S3_ENDPOINT_URL',
    'VIDEORC_RELEASE_CONTROL_DATA_S3_FORCE_PATH_STYLE'
  ],
  credentialRoles: {
    submit: {
      environment: 'release-control-submit',
      prefixAccess: [
        'STATE project: storage:read only (configuration requires credentials; submit never writes state)',
        'DATA project: read/conditional-create intents/*; no state authority'
      ]
    },
    write: {
      environment: 'release-control',
      prefixAccess: [
        'STATE project: sole conditional writer for state.json, capability.json, results/*, probes/*',
        'DATA project: read intents/evidence/journals; conditional probe data-probes/*'
      ]
    },
    read: {
      environment: 'repository protected-main jobs',
      prefixAccess: [
        'STATE project: storage:read only',
        'DATA project: storage:read only; no authority to append receipts'
      ]
    },
    sign: {
      environment: 'windows-alpha-release',
      prefixAccess: [
        'STATE project: storage:read only for state.json/results/*',
        'DATA project: read/conditional-create intents/* and evidence/*/windows/candidate.json'
      ]
    },
    finalize: {
      environment: 'release-publication',
      prefixAccess: [
        'STATE project: storage:read only',
        'DATA project: read/conditional-create intents, bundles, publication-plans, evidence, journals, mirror-sync, mirror-prepared; list these prefixes',
        'NO state authority'
      ]
    },
    localMacos: {
      environment: 'authorized local release host',
      prefixAccess: [
        'STATE project: storage:read only',
        'DATA project: read/conditional-create local-builds/*, intents/*, payload/*, bundles/*, exact macOS evidence',
        'NO state authority; operator announcement and production commands use GitHub without storage keys'
      ]
    }
  },
  publicationEnvironment: {
    signingOidc: 'none',
    publicStorage:
      'dedicated release-writer keys for configured origins; no candidate signing credentials',
    reviewers: 'none',
    protectedMainOnly: true
  },
  rolloutGates: [
    'conditional create/update probe on dedicated private control destination',
    'three exact candidate rehearsals (one cold, two warm; one interrupted)',
    'Windows runtime/packaged gates',
    'real acceptance remains required',
    'no in-flight legacy publisher or D3 unresolved publication',
    'all public-writer entrypoints inventoried; legacy direct Linux publication disabled',
    'recovery and mirror catch-up demonstrated on isolated storage',
    'authorized reviewer capability verified'
  ]
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((value) => value !== '--'),
    options: {
      'apply-environments': { type: 'boolean' },
      json: { type: 'boolean' },
      readiness: { type: 'boolean' },
      'origin-identity': { type: 'boolean' },
      'verify-worker-authority': { type: 'boolean' }
    }
  })
  const github = createReleaseGithub()
  if (values['origin-identity']) {
    const variables = (
      await github.api(`/repos/${RELEASE_REPOSITORY}/actions/variables?per_page=100`)
    ).variables
    console.log(
      publicationOriginIdentity(
        Object.fromEntries(variables.map(({ name, value }) => [name, value]))
      )
    )
    return
  }
  if (values['verify-worker-authority']) {
    const store = createReleaseControlStore(controlStoreConfig())
    try {
      console.log(JSON.stringify(await verifyReadonlyStateCredential(store)))
      return
    } finally {
      store.close()
    }
  }
  if (values.readiness) {
    const report = await inspectReleaseReadiness(github)
    console.log(JSON.stringify(report, null, 2))
    if (report.status === 'NOT_READY') process.exitCode = 1
    return
  }
  const actual = await github.api(`/repos/${RELEASE_REPOSITORY}/environments`)
  const plan = {
    ...contract,
    existingEnvironments: actual.environments.map(({ name }) => name),
    changesApplied: false
  }
  if (values['apply-environments']) {
    const branch = await github.api(`/repos/${RELEASE_REPOSITORY}/branches/main`)
    requireRelease(
      branch.protected,
      'provision-main',
      'Main must be protected before creating release environments.'
    )
    for (const [name, body] of Object.entries(contract.environments)) {
      const existing = actual.environments.find((entry) => entry.name === name)
      requireRelease(
        !existing ||
          !(existing.protection_rules ?? []).some((rule) => rule.type === 'required_reviewers'),
        'provision-existing-reviewers',
        'Provisioner refuses to remove existing reviewer protection; reconcile that environment explicitly.'
      )
      await github.api(`/repos/${RELEASE_REPOSITORY}/environments/${name}`, { method: 'PUT', body })
      const policies = await github.api(
        `/repos/${RELEASE_REPOSITORY}/environments/${name}/deployment-branch-policies`
      )
      requireRelease(
        policies.branch_policies.every(
          (policy) => policy.name === 'main' && policy.type === 'branch'
        ),
        'provision-extra-branches',
        'Existing environment permits other branches/tags; reconcile explicitly before cutover.'
      )
      if (!policies.branch_policies.length)
        await github.api(
          `/repos/${RELEASE_REPOSITORY}/environments/${name}/deployment-branch-policies`,
          { method: 'POST', body: { name: 'main', type: 'branch' } }
        )
    }
    plan.changesApplied = true
  }
  console.log(JSON.stringify(plan, null, 2))
}
main().catch((error) => {
  console.error(`release-provision: ${error.code ?? 'error'}: ${error.message}`)
  process.exitCode = 1
})

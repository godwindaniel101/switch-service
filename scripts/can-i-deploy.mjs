#!/usr/bin/env node
// THE DEPLOY GATE.
//
// It asks the broker one question: does every other service agree with this
// version? A red answer means do not deploy.
//
// Run this in EVERY repository. A green gate in one repository says nothing
// about the other repository.
//
// Environment:
//   PACT_ENVIRONMENT            compare against what is live there
//                               (omit to compare against the main branch)
//   PACT_RETRY_WHILE_UNKNOWN    "true" to wait for a pending verification
//   PACT_RETRY_TIMEOUT_SECONDS  how long to wait (default 300)
import { brokerFetch, brokerUrl, fail, gitVersion, pacticipantName } from './broker.mjs'

const me = pacticipantName()
const version = gitVersion()
const environment = process.env.PACT_ENVIRONMENT ?? null
const retryWhileUnknown = process.env.PACT_RETRY_WHILE_UNKNOWN === 'true'
const retryTimeoutMs = Number(process.env.PACT_RETRY_TIMEOUT_SECONDS ?? 300) * 1_000
const POLL_MS = 10_000

function buildQuery(useEnvironment = Boolean(environment)) {
  const params = new URLSearchParams()
  params.append('q[][pacticipant]', me)
  params.append('q[][version]', version)
  params.append('latestby', 'cvp')
  if (useEnvironment) {
    // Compare against what is actually live in that environment.
    params.append('environment', environment)
  } else {
    // Compare against the main branch of the other side.
    params.append('latest', 'true')
    params.append('mainBranch', 'true')
  }
  return params.toString()
}

async function ask(useEnvironment = Boolean(environment)) {
  const result = await brokerFetch(`/matrix?${buildQuery(useEnvironment)}`)
  if (!result.ok) {
    console.error(JSON.stringify(result.body, null, 2))
    fail(`the broker answered ${result.status}`)
  }
  return {
    summary: result.body?.summary ?? {},
    rows: result.body?.matrix ?? [],
  }
}

function printRows(rows) {
  for (const row of rows) {
    const consumer = row?.consumer?.name ?? '?'
    const provider = row?.provider?.name ?? '?'
    const verified = row?.verificationResult?.success
    const mark = verified === true ? 'pass' : verified === false ? 'FAIL' : 'unknown'
    console.log(`  ${mark.padEnd(8)} ${consumer} -> ${provider}`)
  }
}

console.log(`asking ${brokerUrl}`)
console.log(`  pacticipant ${me}`)
console.log(`  version     ${version}`)
console.log(`  against     ${environment ?? 'the main branch of the other side'}`)

const deadline = Date.now() + retryTimeoutMs
let answer = await ask()

// THE FIRST DEPLOY.
//
// Asking "can I deploy to production" cannot be answered while production is
// empty: the broker has no version there to compare against. That is a
// deadlock, because only a deploy can put the first version there.
//
// Recording a deployment to escape it would be a lie about what is running.
// So fall back to the main branch instead, which is a real comparison, and say
// clearly that it happened. The environment answer takes over by itself as soon
// as the first deploy is recorded.
const environmentIsEmpty =
  environment &&
  typeof answer.summary.reason === 'string' &&
  answer.summary.reason.includes('no version is currently recorded as deployed')

if (environmentIsEmpty) {
  console.log(
    `\n  nothing is recorded as deployed to ${environment} yet, so there is\n` +
      '  nothing there to be incompatible with. Comparing against the main\n' +
      '  branch instead. This stops by itself once the first deploy is recorded\n' +
      '  with "npm run pact:record-deployment".',
  )
  answer = await ask(false)
}

// A verification that has not happened yet reads as "unknown". In continuous
// integration that is normal for a short time: the broker webhook has to start
// the provider build, and that build takes minutes. Waiting is correct.
//
// Waiting is NOT the same as passing. When the wait runs out the gate is still
// red.
while (
  retryWhileUnknown &&
  (answer.summary.unknown ?? 0) > 0 &&
  answer.summary.deployable !== true &&
  Date.now() < deadline
) {
  const secondsLeft = Math.round((deadline - Date.now()) / 1_000)
  console.log(
    `  ${answer.summary.unknown} verification(s) are still unknown, ` +
      `waiting up to ${secondsLeft}s more`,
  )
  await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  answer = await ask()
}

printRows(answer.rows)
console.log(
  `\n  compatible ${answer.summary.success ?? 0}` +
    `  failed ${answer.summary.failed ?? 0}` +
    `  unknown ${answer.summary.unknown ?? 0}`,
)

// A matrix with NO ROWS AT ALL is not a pass.
//
// The broker answers `deployable: true` with "There are no missing
// dependencies" when it knows nothing about this version, because nothing is
// missing when nothing is expected. That is a green light for a version that
// has published no contract and had no verification, which is the opposite of
// what this gate is for. A typo in the version number produces it, and so does
// a dirty tree that invents a version nobody published.
const rowCount =
  (answer.summary.success ?? 0) +
  (answer.summary.failed ?? 0) +
  (answer.summary.unknown ?? 0)

if (answer.summary.deployable === true && rowCount === 0) {
  console.log('\ncan-i-deploy: NO')
  console.log(
    '\n  The broker holds NO contract rows for this version, so it said "there\n' +
      '  are no missing dependencies". Nothing is missing because nothing is\n' +
      '  known, and that is not the same as safe.\n\n' +
      `  version asked about: ${version}\n` +
      '   - is that the version the consumer tests published?\n' +
      '   - was the tree dirty, so the version got a "-dirty" suffix?\n' +
      '   - if this service genuinely has no contracts yet, set\n' +
      '     PACT_ALLOW_NO_CONTRACTS=true to allow it deliberately\n',
  )
  process.exit(process.env.PACT_ALLOW_NO_CONTRACTS === 'true' ? 0 : 1)
}

if (answer.summary.deployable === true) {
  console.log('\ncan-i-deploy: YES\n')
  process.exit(0)
}

console.log('\ncan-i-deploy: NO')
if (answer.summary.reason) console.log(`  reason: ${answer.summary.reason}`)

if ((answer.summary.failed ?? 0) > 0) {
  console.log(
    '\n  A verification FAILED. The contract is broken.\n' +
      '   - read the provider build log to see which expectation failed\n' +
      '   - repair the provider, or change the consumer expectation first\n' +
      '   - never delete an expectation to get a green build\n',
  )
} else {
  console.log(
    '\n  Nothing failed, but nothing is verified either. Unknown is not a pass:\n' +
      '   - has the consumer published a pact for this version?\n' +
      '   - has the provider verified it and published the result?\n' +
      '   - is the broker webhook set up? without it the provider never learns\n' +
      '   - in CI, set PACT_RETRY_WHILE_UNKNOWN=true to wait for it\n',
  )
}
process.exit(1)

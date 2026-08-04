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

function buildQuery() {
  const params = new URLSearchParams()
  params.append('q[][pacticipant]', me)
  params.append('q[][version]', version)
  params.append('latestby', 'cvp')
  if (environment) {
    // Compare against what is actually live in that environment.
    params.append('environment', environment)
  } else {
    // Compare against the main branch of the other side.
    params.append('latest', 'true')
    params.append('mainBranch', 'true')
  }
  return params.toString()
}

async function ask() {
  const result = await brokerFetch(`/matrix?${buildQuery()}`)
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

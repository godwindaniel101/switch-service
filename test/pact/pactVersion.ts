import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * The version and the branch of this build.
 *
 * The rule from the pact-contract-testing skill: never write a version in the
 * code. It comes from git, or from the environment in continuous integration.
 */

/**
 * Both values come from scripts/pact-version.mjs.
 *
 * That file is the single source of truth for this repository. If this test
 * computed the version by itself, the version that publishes a verification
 * result could drift from the version that can-i-deploy asks about, and the
 * gate would answer "unknown" for no visible reason.
 */
export function gitVersion(): string {
  return run(`node ${resolve(__dirname, '../../scripts/pact-version.mjs')}`)
}

export function gitBranch(): string {
  return run(`node ${resolve(__dirname, '../../scripts/pact-version.mjs')} branch`)
}

export const brokerUrl = (
  process.env.PACT_BROKER_BASE_URL ?? 'http://localhost:9292'
).replace(/\/+$/, '')

export const brokerUsername = process.env.PACT_BROKER_USERNAME ?? 'pact'
export const brokerPassword = process.env.PACT_BROKER_PASSWORD ?? 'pact'

/**
 * The broker cannot answer can-i-deploy without a published verification
 * result. Publish by default, and allow a local run to opt out.
 */
export const publishVerificationResult =
  process.env.PACT_SKIP_PUBLISH_VERIFICATION !== 'true'

function run(command: string): string {
  return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

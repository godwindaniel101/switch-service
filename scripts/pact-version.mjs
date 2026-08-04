#!/usr/bin/env node
// THE single source of truth for the version of this repository.
//
// The broker refuses to change the content of a pact that is already published
// under a version. That rule is correct: can-i-deploy cannot be reliable if a
// version can mean two different contracts. Therefore a changed contract needs
// a new version.
//
// The version comes from one of three places, in this order:
//   1. PACT_VERSION, for continuous integration.
//   2. The git commit, which is the normal answer.
//   3. A hash of the contract content, when there is no git repository yet.
//
// The third case keeps local work honest: change the contract, get a new
// version, publish without a fight.
//
// Both the shell scripts and the provider test read this file, so the
// consumer version and the provider version can never drift apart.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

export function resolveVersion() {
  if (process.env.PACT_VERSION) return process.env.PACT_VERSION

  const fromGit = versionFromGit()
  if (fromGit) return fromGit

  return versionFromContent()
}

export function resolveBranch() {
  if (process.env.PACT_BRANCH) return process.env.PACT_BRANCH
  try {
    return run('git rev-parse --abbrev-ref HEAD')
  } catch {
    return 'main'
  }
}

function versionFromGit() {
  try {
    const sha = run('git rev-parse --short HEAD')
    if (!sha) return null
    const dirty = run('git status --porcelain').length > 0
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return null
  }
}

/**
 * A version that follows the contract content.
 *
 * The same contract gives the same version, so a repeated publication is
 * quiet. A changed contract gives a new version, so the broker accepts it.
 */
function versionFromContent() {
  const dir = path.join(projectRoot, 'pacts')
  if (!fs.existsSync(dir)) return '0.0.0-local'

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
  if (files.length === 0) return '0.0.0-local'

  const hash = crypto.createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update(fs.readFileSync(path.join(dir, file)))
  }
  return `0.0.0-local-${hash.digest('hex').slice(0, 10)}`
}

function run(command) {
  return execSync(command, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim()
}

// When run directly, print the version. The provider test reads it this way,
// so there is exactly one implementation.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(here, 'pact-version.mjs')) {
  const which = process.argv[2] === 'branch' ? resolveBranch() : resolveVersion()
  process.stdout.write(which)
}

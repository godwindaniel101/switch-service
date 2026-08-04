// Shared helpers for the Pact Broker scripts.
//
// These scripts talk to the broker over HTTP with no extra dependency. The
// broker is the only exchange between the repositories, so the small amount of
// code here is worth more than a large command line tool.
import fs from 'node:fs'
import path from 'node:path'

import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const projectRoot = path.resolve(here, '..')

export const brokerUrl = (
  process.env.PACT_BROKER_BASE_URL ?? 'http://localhost:9292'
).replace(/\/+$/, '')

const username = process.env.PACT_BROKER_USERNAME ?? 'pact'
const password = process.env.PACT_BROKER_PASSWORD ?? 'pact'

export const authHeader =
  'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')

export function pacticipantName() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  )
  return pkg.name
}

// The version and the branch come from pact-version.mjs, which is the single
// source of truth for this repository. The provider test reads the same file.
export { resolveVersion as gitVersion, resolveBranch as gitBranch } from './pact-version.mjs'

export async function brokerFetch(pathname, init = {}) {
  const response = await fetch(`${brokerUrl}${pathname}`, {
    ...init,
    headers: {
      authorization: authHeader,
      accept: 'application/hal+json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { ok: response.ok, status: response.status, body }
}

export function readPactFiles() {
  const dir = path.join(projectRoot, 'pacts')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      file: f,
      content: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
    }))
}

export function fail(message) {
  console.error(`\n  ${message}\n`)
  process.exit(1)
}

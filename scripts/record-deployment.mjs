#!/usr/bin/env node
// Tells the broker that this version is now live in an environment.
//
// Without this record, the "deployed" consumer version selector finds nothing,
// and can-i-deploy cannot compare against what is actually running.
import { brokerFetch, fail, gitVersion, pacticipantName } from './broker.mjs'

const me = pacticipantName()
const version = gitVersion()
const environment = process.env.PACT_ENVIRONMENT ?? 'local'

// The record endpoint takes the environment's UUID, NOT its name. Posting to
// .../environment/production answers 404 with "The requested document was not
// found on this server", which reads as "the version is missing" and sends you
// looking in the wrong place entirely.
//
// The version resource lists one record-deployment link per environment, each
// already carrying the right UUID, so read the answer instead of building the
// URL by hand.
const versionPath = `/pacticipants/${encodeURIComponent(me)}/versions/${encodeURIComponent(version)}`
const versionResource = await brokerFetch(versionPath)

if (!versionResource.ok) {
  fail(
    `the broker has no version ${version} for ${me} (status ${versionResource.status}). ` +
      'publish the contract before recording a deployment.',
  )
}

const links = versionResource.body?._links?.['pb:record-deployment'] ?? []
const candidates = Array.isArray(links) ? links : [links]
const target = candidates.find((link) => link?.name === environment)

if (!target?.href) {
  const known = candidates.map((l) => l?.name).filter(Boolean).join(', ') || 'none'
  fail(
    `the broker has no environment called "${environment}". it knows: ${known}. ` +
      'create it with the webhooks script in platform-infra.',
  )
}

const result = await brokerFetch(new URL(target.href).pathname, {
  method: 'POST',
  body: JSON.stringify({}),
})

if (!result.ok) {
  console.error(JSON.stringify(result.body, null, 2))
  fail(`could not record the deployment (status ${result.status})`)
}

console.log(`recorded ${me} ${version} as deployed to ${environment}`)

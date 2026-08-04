#!/usr/bin/env node
// Tells the broker that this version is now live in an environment.
//
// Without this record, the "deployed" consumer version selector finds nothing
// and can-i-deploy cannot compare against what is actually running.
import { brokerFetch, fail, gitVersion, pacticipantName } from './broker.mjs'

const me = pacticipantName()
const version = gitVersion()
const environment = process.env.PACT_ENVIRONMENT ?? 'local'

const result = await brokerFetch(
  `/pacticipants/${encodeURIComponent(me)}/versions/${encodeURIComponent(
    version,
  )}/deployed-versions/environment/${encodeURIComponent(environment)}`,
  { method: 'POST', body: JSON.stringify({}) },
)

if (!result.ok) {
  console.error(JSON.stringify(result.body, null, 2))
  fail(
    `could not record the deployment (status ${result.status}). ` +
      `does the environment "${environment}" exist in the broker?`,
  )
}

console.log(`recorded ${me} ${version} as deployed to ${environment}`)

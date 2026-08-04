#!/usr/bin/env node
// Publishes every pact that THIS repository produced as a consumer.
//
// A pact file in this repository is a build artifact. The broker holds the
// durable copy. The provider repository reads it from the broker, never from
// a file, and never from git.
import {
  brokerFetch,
  brokerUrl,
  fail,
  gitBranch,
  gitVersion,
  pacticipantName,
  readPactFiles,
} from './broker.mjs'

const me = pacticipantName()
const version = gitVersion()
const branch = gitBranch()

const all = readPactFiles()
if (all.length === 0) {
  fail('no pact file found. run "npm run pact:consumer" first')
}

// Publish only the contracts where this repository is the consumer. A pact
// file that names a different consumer does not belong to this repository.
const mine = all.filter((p) => p.content?.consumer?.name === me)
if (mine.length === 0) {
  fail(
    `found ${all.length} pact file(s), but none names "${me}" as the consumer. ` +
      'check the consumer name in the pact test',
  )
}

const payload = {
  pacticipantName: me,
  pacticipantVersionNumber: version,
  branch,
  contracts: mine.map((p) => ({
    consumerName: p.content.consumer.name,
    providerName: p.content.provider.name,
    specification: 'pact',
    contentType: 'application/json',
    content: Buffer.from(JSON.stringify(p.content)).toString('base64'),
    // "merge" keeps interactions that a different test file published for the
    // same version. Two test files, one contract.
    onConflict: 'merge',
  })),
}

console.log(`publishing to ${brokerUrl}`)
console.log(`  consumer ${me}`)
console.log(`  version  ${version}`)
console.log(`  branch   ${branch}`)
for (const c of payload.contracts) {
  console.log(`  contract ${c.consumerName} -> ${c.providerName}`)
}

const result = await brokerFetch('/contracts/publish', {
  method: 'POST',
  body: JSON.stringify(payload),
})

if (!result.ok) {
  console.error(JSON.stringify(result.body, null, 2))
  fail(`the broker refused the publication with status ${result.status}`)
}

const notices = result.body?.notices ?? []
for (const notice of notices) {
  console.log(`  ${notice.type ?? 'info'}: ${notice.text}`)
}

if (version.endsWith('-dirty')) {
  console.log(
    '\n  warning: the tree is dirty, so the version has a "-dirty" suffix.\n' +
      '  commit your work before you publish a contract that another team will use.',
  )
}

console.log('\npublication complete\n')

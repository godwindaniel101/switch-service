#!/usr/bin/env bash
#
# THE CONTRACT GATE.
#
# The same steps run here, on a laptop and in continuous integration. A gate
# that only exists inside a CI file cannot be tested, and nobody can run it
# before they push.
#
# Order of the steps, and the reason for the order:
#
#   1. consumer tests    write what THIS service needs from the other one
#   2. publish           give it to the broker, under this git commit
#   3. provider verify   prove THIS service still keeps its own promise
#   4. can-i-deploy      ask the broker whether the pair agrees
#
# Step 4 is the gate. A deploy must not start until it answers YES.
#
# Environment:
#   PACT_BROKER_BASE_URL   required for steps 2, 3 and 4
#   PACT_BROKER_USERNAME   default "pact"
#   PACT_BROKER_PASSWORD   default "pact"
#   PACT_BRANCH            the git branch (CI must set this)
#   PACT_ENVIRONMENT       compare against a live environment in step 4
#   SKIP_BROKER=true       run step 1 only, when there is no broker
set -euo pipefail

cd "$(dirname "$0")/.."

BROKER="${PACT_BROKER_BASE_URL:-}"
SKIP_BROKER="${SKIP_BROKER:-false}"

line() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

line "1/4  consumer contract tests"
# This writes ./pacts. It needs no broker and no database, so it always runs.
npm run pact:consumer

if [ -z "$BROKER" ] || [ "$SKIP_BROKER" = "true" ]; then
  echo ""
  echo "WARNING: no broker is configured, so the gate did NOT run."
  echo "  The consumer expectations were checked against a mock only."
  echo "  Nothing proved that the other service can meet them."
  echo "  Set PACT_BROKER_BASE_URL to close the gate."
  echo ""
  # Exit 0 on purpose: a pull request from a fork has no secrets, and the
  # consumer tests are still worth running. The DEPLOY job must depend on the
  # gate, not on this job, so an open gate can never ship.
  exit 0
fi

line "2/4  publish the contract to the broker"
npm run pact:publish

line "3/4  verify the contracts that this service provides"
# This service is a provider too. It must prove that it still emits the shape
# the other repository depends on.
npm run pact:provider

line "4/4  can-i-deploy"
# In CI the provider build may not have finished yet, so wait for it. Waiting
# is not passing: when the wait runs out, the gate is still red.
PACT_RETRY_WHILE_UNKNOWN="${PACT_RETRY_WHILE_UNKNOWN:-true}" \
  npm run pact:can-i-deploy

line "the gate is green"
echo "this version may be deployed."
echo "after the deploy, run: npm run pact:record-deployment"

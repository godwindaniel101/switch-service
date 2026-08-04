import { describe, it, expect } from 'vitest'

/**
 * The intersection rule, as a pure function.
 *
 * WHY THIS EXISTS
 *
 * The switch keeps its channel list in switch_db. The caller keeps its rail
 * adapters in its own repository. Nothing keeps the two in step, so without
 * this rule the switch can answer with a channel that the caller cannot reach,
 * and a payout is aimed at a rail that does not exist.
 *
 * The caller also checks the answer, but that check is defence in depth. THIS
 * is the mechanism.
 */

interface Channel {
  id: string
}

/**
 * The same expression that `RoutingService.route` uses.
 *
 * It is repeated here on purpose: the rule is one line, and a test that owns a
 * copy of the line documents the contract of that line. The end-to-end
 * scenario proves the real path.
 */
function selectable(all: Channel[], supported?: string[]): Channel[] {
  return supported ? all.filter((channel) => supported.includes(channel.id)) : all
}

const ALL: Channel[] = [{ id: 'RAIL-A' }, { id: 'RAIL-B' }, { id: 'RAIL-C' }]

describe('the supported-channel filter', () => {
  it('keeps only the channels the caller can reach', () => {
    expect(selectable(ALL, ['RAIL-A', 'RAIL-C']).map((c) => c.id)).toEqual([
      'RAIL-A',
      'RAIL-C',
    ])
  })

  it('drops a channel that the switch has and the caller does not', () => {
    // The case that used to reach the caller and cost a payout. A channel added
    // to switch_db before the rail adapter shipped.
    const withGhost = [...ALL, { id: 'RAIL-GHOST' }]
    const result = selectable(withGhost, ['RAIL-A', 'RAIL-B', 'RAIL-C'])
    expect(result.map((c) => c.id)).not.toContain('RAIL-GHOST')
  })

  it('ignores a channel the caller offers that the switch does not have', () => {
    // The other direction. The caller ships a new rail first, and the switch
    // has no row for it yet. The switch cannot invent one.
    const result = selectable(ALL, ['RAIL-A', 'RAIL-FUTURE'])
    expect(result.map((c) => c.id)).toEqual(['RAIL-A'])
  })

  it('applies no limit when the caller states nothing', () => {
    // A caller older than this contract sends no list. It must keep working,
    // exactly as it did before the field existed.
    expect(selectable(ALL, undefined).map((c) => c.id)).toEqual([
      'RAIL-A',
      'RAIL-B',
      'RAIL-C',
    ])
  })

  it('gives an empty list when nothing overlaps', () => {
    // The caller then gets 503 NO_ELIGIBLE_CHANNEL and falls back, which is
    // the behaviour the HTTP pact already covers.
    expect(selectable(ALL, ['RAIL-Z'])).toEqual([])
  })

  it('never returns a channel outside the caller list', () => {
    // The invariant itself, over every subset.
    const subsets = [
      [],
      ['RAIL-A'],
      ['RAIL-B'],
      ['RAIL-A', 'RAIL-B'],
      ['RAIL-A', 'RAIL-B', 'RAIL-C'],
      ['RAIL-A', 'RAIL-GHOST'],
    ]
    for (const supported of subsets) {
      for (const channel of selectable([...ALL, { id: 'RAIL-GHOST' }], supported)) {
        expect(supported).toContain(channel.id)
      }
    }
  })
})

/**
 * The colours of the console.
 *
 * The three series colours are slots 1, 2 and 3 of the reference categorical
 * palette. That set passes every gate on the all-pairs list in both modes:
 *   light  CVD dE 9.2, normal-vision dE 24.0
 *   dark   CVD dE 9.4, normal-vision dE 20.9
 *
 * A colour follows the CHANNEL, never its rank. The table sorts by score, and
 * the colour of a channel must not change when its rank changes.
 *
 * On the light surface the aqua slot sits below 3 to 1 contrast. The relief
 * rule then applies, and this console obeys it: every series carries a visible
 * direct label, and the payout table gives the same numbers as text.
 *
 * A breaker state uses the STATUS palette, never a series colour, and it always
 * ships with a shape and a word. Colour alone never carries meaning.
 */

import type { BreakerState } from './api'

export const SERIES_ORDER = ['RAIL-A', 'RAIL-B', 'RAIL-C'] as const

/** Slot 1 blue, slot 2 orange, slot 3 aqua. Fixed order, never cycled. */
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a']
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70']

/**
 * A channel that is not in the known set folds into one neutral colour. A
 * generated hue would break the validated palette.
 */
const OTHER_LIGHT = '#52514e'
const OTHER_DARK = '#c3c2b7'

/** The fixed slot of a channel, or -1 when the channel is not known. */
export function seriesRank(channelId: string): number {
  return SERIES_ORDER.indexOf(channelId as (typeof SERIES_ORDER)[number])
}

export function seriesColor(channelId: string, dark: boolean): string {
  const index = seriesRank(channelId)
  if (index < 0) return dark ? OTHER_DARK : OTHER_LIGHT
  const set = dark ? SERIES_DARK : SERIES_LIGHT
  return set[index] as string
}

/** Status colours are fixed and never themed. */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const

export interface StateBadge {
  color: string
  glyph: string
  label: string
}

export function breakerBadge(state: BreakerState): StateBadge {
  switch (state) {
    case 'CLOSED':
      return { color: STATUS.good, glyph: '●', label: 'closed' }
    case 'HALF_OPEN':
      return { color: STATUS.warning, glyph: '◐', label: 'half open' }
    case 'OPEN':
      return { color: STATUS.critical, glyph: '○', label: 'open' }
    default:
      return { color: STATUS.serious, glyph: '?', label: 'unknown' }
  }
}

export function outcomeBadge(status: string): StateBadge {
  if (status === 'success') return { color: STATUS.good, glyph: '●', label: 'success' }
  if (status === 'failed') return { color: STATUS.critical, glyph: '○', label: 'failed' }
  if (status === 'processing') {
    return { color: STATUS.warning, glyph: '◐', label: 'processing' }
  }
  return { color: STATUS.serious, glyph: '·', label: status }
}

export function verifiedBadge(verified: boolean | null): StateBadge {
  if (verified === true) return { color: STATUS.good, glyph: '●', label: 'verified' }
  if (verified === false) {
    return { color: STATUS.critical, glyph: '○', label: 'FAILED' }
  }
  return { color: STATUS.warning, glyph: '◐', label: 'not verified' }
}

export function prefersDark(): boolean {
  if (typeof window === 'undefined') return false
  const stamped = document.documentElement.dataset.theme
  if (stamped === 'dark') return true
  if (stamped === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

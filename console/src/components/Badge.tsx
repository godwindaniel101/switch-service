import type { ReactNode } from 'react'
import type { StateBadge } from '../theme'

/**
 * A state badge: a colour, a shape and a word, always together.
 *
 * Colour alone never carries meaning, so the glyph and the label are not
 * optional. The children hold the extra text that a call site adds after the
 * label.
 */
export function Badge({
  badge,
  children,
}: {
  badge: StateBadge
  children?: ReactNode
}) {
  return (
    <span className="badge">
      <span className="glyph" style={{ color: badge.color }}>
        {badge.glyph}
      </span>
      {badge.label}
      {children}
    </span>
  )
}

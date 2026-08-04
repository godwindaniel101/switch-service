import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * A time line for the sliding window.
 *
 * Rules that this chart follows:
 *   - ONE y axis. Two measures of a different scale get two charts, never two
 *     scales on one chart.
 *   - 2px lines, recessive grid, no marker on every point.
 *   - A gap where a bucket holds no payout. A gap is the truth. A zero would
 *     draw a fall that never happened.
 *   - A legend for every series, plus a direct label at the end of each line,
 *     so identity is never colour alone.
 *   - A crosshair and a tooltip, because an HTML chart is interactive.
 *   - Text wears a text token. The colour lives on the mark and on the small
 *     square beside the label.
 */

export interface Series {
  id: string
  color: string
  points: Array<number | null>
}

export interface LineChartProps {
  series: Series[]
  /** One label for each x position, oldest first. */
  xLabels: string[]
  height?: number
  /** Turns a value into the text of the tooltip and of the axis. */
  format: (value: number) => string
  /** Fixes the top of the y axis. Without it the chart uses the data. */
  yMax?: number
  yMin?: number
  emptyMessage?: string
}

const PAD = { top: 12, right: 62, bottom: 20, left: 44 }
const MARKER_R = 4.5

export function LineChart({
  series,
  xLabels,
  height = 168,
  format,
  yMax,
  yMin = 0,
  emptyMessage = 'no payout in this window yet',
}: LineChartProps) {
  const holder = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  useEffect(() => {
    const node = holder.current
    if (!node) return
    // Measure, so the stroke stays 2px. A stretched viewBox would thicken it.
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width
      if (next && next > 0) setWidth(next)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const count = xLabels.length
  const plotW = Math.max(10, width - PAD.left - PAD.right)
  const plotH = Math.max(10, height - PAD.top - PAD.bottom)

  const top = useMemo(() => {
    if (yMax !== undefined) return yMax
    let max = 0
    for (const s of series) {
      for (const value of s.points) {
        if (value !== null && Number.isFinite(value)) max = Math.max(max, value)
      }
    }
    // A flat zero axis is unreadable. Give it a small ceiling.
    return max <= 0 ? 1 : max * 1.12
  }, [series, yMax])

  const hasData = series.some((s) => s.points.some((p) => p !== null))

  const xAt = useCallback(
    (index: number) => (count <= 1 ? 0 : (index / (count - 1)) * plotW),
    [count, plotW],
  )

  const yAt = useCallback(
    (value: number) => {
      const span = top - yMin || 1
      const ratio = (value - yMin) / span
      return plotH - Math.max(0, Math.min(1, ratio)) * plotH
    },
    [plotH, top, yMin],
  )

  /** Breaks the path where the data is missing, so a gap stays a gap. */
  const pathOf = useCallback(
    (points: Array<number | null>): string => {
      let path = ''
      let open = false
      points.forEach((value, index) => {
        if (value === null || !Number.isFinite(value)) {
          open = false
          return
        }
        const command = open ? 'L' : 'M'
        path += `${command}${xAt(index).toFixed(2)},${yAt(value).toFixed(2)}`
        open = true
      })
      return path
    },
    [xAt, yAt],
  )

  const ticks = useMemo(() => {
    const steps = 3
    return Array.from({ length: steps + 1 }, (_, i) => yMin + ((top - yMin) * i) / steps)
  }, [top, yMin])

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    if (count === 0) return
    const box = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - box.left - PAD.left
    if (x < -8 || x > plotW + 8) {
      setHoverIndex(null)
      return
    }
    const ratio = count <= 1 ? 0 : x / plotW
    const index = Math.round(ratio * (count - 1))
    setHoverIndex(Math.max(0, Math.min(count - 1, index)))
  }

  const tooltip =
    hoverIndex === null
      ? null
      : {
          left: Math.min(
            Math.max(PAD.left + xAt(hoverIndex) - 66, 0),
            Math.max(0, width - 148),
          ),
          when: xLabels[hoverIndex] ?? '',
          rows: series.map((s) => ({
            id: s.id,
            color: s.color,
            value: s.points[hoverIndex] ?? null,
          })),
        }

  return (
    <div className="plot" ref={holder}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="channel performance over the sliding window"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {/* Recessive grid. A hairline, never a strong line. */}
          {ticks.map((value) => (
            <g key={value}>
              <line
                x1={0}
                x2={plotW}
                y1={yAt(value)}
                y2={yAt(value)}
                stroke="var(--grid)"
                strokeWidth={1}
              />
              <text
                x={-8}
                y={yAt(value)}
                textAnchor="end"
                dominantBaseline="middle"
                fill="var(--text-muted)"
                fontSize={10.5}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {format(value)}
              </text>
            </g>
          ))}

          <line
            x1={0}
            x2={plotW}
            y1={plotH}
            y2={plotH}
            stroke="var(--axis)"
            strokeWidth={1}
          />

          {hoverIndex !== null && (
            <line
              x1={xAt(hoverIndex)}
              x2={xAt(hoverIndex)}
              y1={0}
              y2={plotH}
              stroke="var(--axis)"
              strokeWidth={1}
            />
          )}

          {series.map((s) => (
            <path
              key={s.id}
              d={pathOf(s.points)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {/* A marker only under the crosshair, never on every point. */}
          {hoverIndex !== null &&
            series.map((s) => {
              const value = s.points[hoverIndex]
              if (value === null || value === undefined) return null
              return (
                <circle
                  key={`${s.id}-marker`}
                  cx={xAt(hoverIndex)}
                  cy={yAt(value)}
                  r={MARKER_R}
                  fill={s.color}
                  // A 2px ring of the surface, so overlapping marks stay apart.
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              )
            })}

          {/* A direct label at the end of each line. Identity is never colour
              alone, and this also covers the light-mode contrast relief. */}
          {series.map((s) => {
            const lastIndex = lastDefined(s.points)
            if (lastIndex === null) return null
            const value = s.points[lastIndex] as number
            return (
              <g
                key={`${s.id}-label`}
                transform={`translate(${xAt(lastIndex) + 8},${yAt(value)})`}
              >
                <rect x={0} y={-4} width={8} height={8} rx={2} fill={s.color} />
                <text
                  x={12}
                  y={0}
                  dominantBaseline="middle"
                  fill="var(--text-secondary)"
                  fontSize={10.5}
                >
                  {s.id.replace('RAIL-', '')}
                </text>
              </g>
            )
          })}

          <text
            x={0}
            y={plotH + 14}
            fill="var(--text-muted)"
            fontSize={10}
          >
            {xLabels[0] ?? ''}
          </text>
          <text
            x={plotW}
            y={plotH + 14}
            textAnchor="end"
            fill="var(--text-muted)"
            fontSize={10}
          >
            now
          </text>
        </g>
      </svg>

      {!hasData && <div className="empty">{emptyMessage}</div>}

      {tooltip && hasData && (
        <div className="tip" style={{ left: tooltip.left, top: 0 }}>
          <div className="when">{tooltip.when}</div>
          {tooltip.rows.map((row) => (
            <div className="row" key={row.id}>
              <span className="key" style={{ background: row.color }} />
              <span className="who">{row.id}</span>
              <span className="num">
                {row.value === null ? 'no data' : format(row.value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function lastDefined(points: Array<number | null>): number | null {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const value = points[i]
    if (value !== null && value !== undefined && Number.isFinite(value)) return i
  }
  return null
}

/** The legend. Always present when there are two or more series. */
export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null
  return (
    <div className="legend">
      {series.map((s) => (
        <span className="item" key={s.id}>
          <span className="key" style={{ background: s.color }} />
          {s.id}
        </span>
      ))}
    </div>
  )
}

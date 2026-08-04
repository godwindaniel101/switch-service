/** The wall-clock time of an ISO stamp. A bad stamp shows a dash, never NaN. */
export function clockOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString(undefined, { hour12: false })
}

export type TodayWindowTarget = { workspace: string; member?: string; date?: string }

const WORKSPACE_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Validates renderer input before it becomes a window route. */
export function parseTodayWindowTarget(raw: unknown): TodayWindowTarget {
  const target = raw as Partial<Record<keyof TodayWindowTarget, unknown>> | null
  const member = target?.member
  const date = target?.date
  if (
    !target ||
    typeof target.workspace !== 'string' ||
    !WORKSPACE_PATTERN.test(target.workspace) ||
    (member !== undefined && (typeof member !== 'string' || !member || member.length > 256)) ||
    (date !== undefined && (typeof date !== 'string' || !DATE_PATTERN.test(date)))
  ) {
    throw new Error('Invalid Today window target')
  }
  return {
    workspace: target.workspace,
    ...(member ? { member } : {}),
    ...(date ? { date } : {})
  }
}

/** The Today window's route; `window=today` marks it auxiliary in the renderer. */
export function getTodayWindowPath(target: TodayWindowTarget): string {
  const search = new URLSearchParams({ window: 'today' })
  if (target.member) search.set('member', target.member)
  if (target.date) search.set('date', target.date)
  return `/${target.workspace}/today-window?${search}`
}

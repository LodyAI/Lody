export type RendererSendExitReply = { ready: boolean; pending: boolean; unsaved?: boolean }

/** Approval is a separate phase: denying exit must leave every renderer usable. */
export async function runRendererSendExit<T>(
  targets: readonly T[],
  ports: {
    check(target: T): Promise<RendererSendExitReply>
    unavailable(unsaved: boolean): Promise<void>
    confirm(): Promise<boolean>
    drain(target: T): Promise<RendererSendExitReply>
  }
): Promise<boolean> {
  const checks = await Promise.all(targets.map((target) => ports.check(target)))
  if (checks.some((reply) => !reply.ready)) {
    await ports.unavailable(checks.some((reply) => reply.unsaved === true))
    return false
  }
  if (checks.some((reply) => reply.pending) && !(await ports.confirm())) return false
  const stopped = await Promise.all(targets.map((target) => ports.drain(target)))
  if (stopped.some((reply) => !reply.ready)) {
    await ports.unavailable(stopped.some((reply) => reply.unsaved === true))
    return false
  }
  return true
}

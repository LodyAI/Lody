export type RendererSendExitReply = { ready: boolean; pending: boolean }

/** Approval is a separate phase: denying exit must leave every renderer usable. */
export async function runRendererSendExit<T>(
  targets: readonly T[],
  ports: {
    check(target: T): Promise<RendererSendExitReply>
    unavailable(): Promise<void>
    confirm(): Promise<boolean>
    drain(target: T): Promise<RendererSendExitReply>
  }
): Promise<boolean> {
  const checks = await Promise.all(targets.map((target) => ports.check(target)))
  if (checks.some((reply) => !reply.ready)) {
    await ports.unavailable()
    return false
  }
  if (checks.some((reply) => reply.pending) && !(await ports.confirm())) return false
  const stopped = await Promise.all(targets.map((target) => ports.drain(target)))
  return stopped.every((reply) => reply.ready)
}

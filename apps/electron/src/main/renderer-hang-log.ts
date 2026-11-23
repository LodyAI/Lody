import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Serialized append/rotation: overlapping stack, recovery and sample results cannot overwrite. */
export function createRendererHangLog(filePath: string, maxBytes = 2 * 1024 * 1024) {
  let pending = Promise.resolve()
  return (entry: Record<string, unknown>): Promise<void> => {
    const line = `${JSON.stringify(entry)}\n`
    const write = pending.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      const size = await fs.stat(filePath).then(
        (stat) => stat.size,
        () => 0
      )
      if (size && size + Buffer.byteLength(line) > maxBytes) {
        await fs.rm(`${filePath}.1`, { force: true })
        await fs.rename(filePath, `${filePath}.1`)
      }
      await fs.appendFile(filePath, line, { mode: 0o600 })
    })
    pending = write.catch(() => {})
    return write
  }
}

export function withDiagnosticTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

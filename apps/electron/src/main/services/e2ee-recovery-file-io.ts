import { open } from 'node:fs/promises'
import { constants } from 'node:fs'

/** Native-dialog-selected regular file only. Bounded reads also reject a file
 * growing after stat; nonblocking open prevents a FIFO from hanging main. */
export async function readRecoveryFile(
  path: string,
  assertCurrent: () => void
): Promise<Uint8Array> {
  assertCurrent()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const bytes = new Uint8Array(257)
  try {
    assertCurrent()
    const stat = await file.stat()
    if (!stat.isFile() || stat.size === 0 || stat.size > 256)
      throw new Error('invalid-recovery-file')
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length !== stat.size) throw new Error('invalid-recovery-file')
    assertCurrent()
    return bytes.slice(0, length)
  } finally {
    bytes.fill(0)
    await file.close()
  }
}

/** Path comes only from a main-owned native dialog. Refuse replacement, including
 * symlinks. A successful local save is not a completed cloud backup. */
export async function saveRecoveryFile(
  path: string,
  bytes: Uint8Array,
  assertCurrent: () => void
): Promise<void> {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 256)
    throw new Error('invalid-recovery-file')
  assertCurrent()
  const file = await open(path, 'wx+', 0o600)
  const readBack = new Uint8Array(bytes.length + 1)
  try {
    assertCurrent()
    await file.writeFile(bytes)
    await file.sync()
    const { bytesRead } = await file.read(readBack, 0, readBack.length, 0)
    if (bytesRead !== bytes.length || !bytes.every((byte, i) => readBack[i] === byte))
      throw new Error('recovery-file-readback-mismatch')
    assertCurrent()
  } finally {
    readBack.fill(0)
    await file.close()
  }
}

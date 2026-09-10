/** Keep OS access failures distinct from a missing file. */
export function localFileActionError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'not_found' : error.code
  }
  return error instanceof Error ? error.message : String(error)
}

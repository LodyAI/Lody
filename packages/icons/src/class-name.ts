/**
 * Keep caller classes after the icon's compiled classes, matching the normal
 * StyleX primitive contract without depending on @lody/ui internals.
 */
export function appendClassName(
  compiled: string | undefined,
  caller: string | undefined
): string | undefined {
  if (!caller) return compiled;
  return compiled ? `${compiled} ${caller}` : caller;
}

const RELATIVE = /^\.{1,2}\//
const HAS_EXTENSION = /\.[cm]?[jt]sx?$|\.json$/

/**
 * Retries an extensionless relative import from a `.ts` module as `.ts`.
 * Bare specifiers, imports that already name a file, and imports from
 * JavaScript are left to Node unchanged.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (
      error?.code !== 'ERR_MODULE_NOT_FOUND' ||
      !RELATIVE.test(specifier) ||
      HAS_EXTENSION.test(specifier) ||
      !context.parentURL?.endsWith('.ts')
    ) {
      throw error
    }
    return nextResolve(`${specifier}.ts`, context)
  }
}

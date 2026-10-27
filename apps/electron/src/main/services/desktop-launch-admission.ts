/**
 * Separates port ownership from the ability to consume a launch. The desktop
 * lease exists before Host admission and application import, so early handoff
 * requests wait instead of being counted as delivered into a buffer that a
 * refused startup will never bind.
 */
export function createDesktopLaunchAdmission(deliver: (url: string) => void) {
  const admitted = Promise.withResolvers<boolean>()

  return {
    /** Resolves once startup can consume a launch; the first decision wins. */
    async accept(url: string): Promise<boolean> {
      // Always await so concurrent handoffs are delivered in arrival order; a
      // later ready fast path must not overtake requests that were already waiting.
      if (!(await admitted.promise)) return false
      deliver(url)
      return true
    },
    markReady: () => admitted.resolve(true),
    markRejected: () => admitted.resolve(false)
  }
}

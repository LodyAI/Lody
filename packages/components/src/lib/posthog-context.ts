import { createContext, useContext } from 'react';
import type { PostHogClient } from './deferred-posthog';

/* Local replacement for `@posthog/react`'s context/hook. That package's ESM
   entry statically `import`s `posthog-js`, so importing it in every feature
   file would drag the ~200KB SDK back into the boot chunk. The client we
   supply is the deferred proxy: reads forward to the real SDK once its lazy
   import resolves, and capture-style calls are queued until then. The public
   API surface the codebase uses is only `usePostHog()` → `client`. */

export interface PostHogContextValue {
  client: PostHogClient;
}

export const PostHogContext = createContext<PostHogContextValue | null>(null);

export function usePostHog(): PostHogClient | undefined {
  /* Mirrors `@posthog/react`'s hook: no provider → undefined, never a throw.
     Callers pass the value into the `PostHogAnalyticsClient` helpers, which
     no-op on a missing client. */
  return useContext(PostHogContext)?.client;
}

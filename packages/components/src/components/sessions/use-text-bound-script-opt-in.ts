import { useCallback, useState } from 'react';

/**
 * A user's "Run scripts" consent for one exact HTML text. Consent covers only the
 * text it was given for: new content (an agent rewrite, a refreshed file) reads
 * as not opted in until the user opts in again.
 */
export function useTextBoundScriptOptIn(text: string | null) {
  const [optedInFor, setOptedInFor] = useState<string | null>(null);
  const optedIn = text !== null && optedInFor === text;
  const toggle = useCallback(() => setOptedInFor(optedIn ? null : text), [optedIn, text]);
  const revoke = useCallback(() => setOptedInFor(null), []);
  return { optedIn, toggle, revoke };
}

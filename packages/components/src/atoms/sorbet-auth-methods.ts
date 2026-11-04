import { atom } from 'jotai';

/**
 * Bumped when a Provider definition is created or deleted.
 *
 * A definition only becomes a sign-in method once the agent is asked again, and the
 * capability row keeps whatever probe last wrote. Sign-in discovery therefore treats a
 * new revision as "my cached list may be incomplete" and probes once more.
 */
export const sorbetAuthMethodsRevisionAtom = atom(0);

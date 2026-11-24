import { createContext } from 'react';

/**
 * Host-provided `lody.*` capabilities for genui surfaces. The map is the
 * `lody` namespace itself: `{ sendPrompt: (text) => ... }` becomes
 * `lody.sendPrompt('...')` inside the confined evaluator. The manifest is
 * static per Lody release — surfaces calling an absent member get a
 * diagnostic, matching every other catalog violation.
 */
export const GenuiCapabilitiesContext = createContext<Record<string, unknown>>({});

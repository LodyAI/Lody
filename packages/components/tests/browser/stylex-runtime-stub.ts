/** StyleX for the uncompiled browser route bundle. Styles are presentation there,
 * so every rule compiles to nothing and every token reads as an empty value. */
const tokens: Record<string, string> = new Proxy({}, { get: () => '' });
export const create = <T>(styles: T) => styles;
export const props = () => ({});
export const defineVars = () => tokens;
export const defineConsts = () => tokens;
export const createTheme = () => ({});
export const firstThatWorks = (...values: unknown[]) => values[0];
export const keyframes = () => '';

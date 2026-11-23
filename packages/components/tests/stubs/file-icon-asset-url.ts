/**
 * Test stub for `components/icons/file-icons/asset-url`.
 *
 * The real module resolves 324 SVGs through Vite's `new URL(..., import.meta.url)`
 * directory glob. No test asserts on an icon's URL, so paying for that graph in
 * every test file buys nothing. Aliased in `vitest.config.ts`.
 */

export const getFileIconUrl = (iconName: string): string => `/test-file-icon/${iconName}.svg`;

export const getFolderIconUrl = (iconName: string): string => `/test-folder-icon/${iconName}.svg`;

/**
 * Asset URLs for the file-type icon SVGs.
 *
 * `new URL(<template containing a variable>, import.meta.url)` is how Vite emits
 * an asset whose name is only known at runtime — but it gets there by eagerly
 * globbing the whole directory into the module graph. That is 324 extra modules
 * dragged in by every consumer of `FileIcon`, which is fine for a bundle (they
 * have to be emitted anyway) and ruinous under Vitest, where the graph is
 * re-evaluated for every test file.
 *
 * Keeping the two `new URL` calls alone in this module lets the test config
 * alias it to a stub without also stubbing the extension mapping or the cached
 * component factory, both of which real tests do exercise. Do not add anything
 * else here, and do not inline these back into `index.tsx`.
 */

export const getFileIconUrl = (iconName: string): string =>
  new URL(`./files/${iconName}.svg`, import.meta.url).href;

export const getFolderIconUrl = (iconName: string): string =>
  new URL(`./folders/${iconName}.svg`, import.meta.url).href;

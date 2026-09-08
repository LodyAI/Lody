/**
 * Typed `build.modulePreload.resolveDependencies` policy for `vite.config.ts`.
 * Keep the HTML href allowlist in sync with `scripts/finalize-prerender-html.mjs`.
 *
 * HTML hosts: keep only the hydration runtime so every prerendered document
 * does not modulepreload the whole route graph.
 *
 * JS hosts (lazy route imports): keep every dependency. Vite injects
 * extracted CSS through the same preload wrapper; dropping `pricing-*.css`
 * / `legal-*.css` here would load the route component without its sheet
 * on client-side navigation.
 */

export function isCriticalModulePreloadHref(href: string): boolean {
  return /(?:^|\/)(?:index|rolldown-runtime|react-dom|react|jsx-runtime|preload-helper)-[^/]+\.js(?:\?|$)/u.test(
    href
  );
}

export type ModulePreloadHostType = 'html' | 'js' | 'css';

export type ModulePreloadResolveContext = {
  hostId?: string;
  hostType?: ModulePreloadHostType;
};

export function resolveModulePreloadDependencies(
  _filename: string,
  deps: string[],
  context: ModulePreloadResolveContext = {}
): string[] {
  if (context.hostType !== 'html') {
    return deps;
  }
  return deps.filter(isCriticalModulePreloadHref);
}

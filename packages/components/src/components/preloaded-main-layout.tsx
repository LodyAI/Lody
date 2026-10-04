import { lazy, Suspense, useRef, type ComponentProps } from 'react';
import { BootShell } from './boot-shell';
import type { MainLayout } from './main-layout';

let prepared: typeof MainLayout | undefined;
let loading: Promise<{ default: typeof MainLayout }> | undefined;

/**
 * Load code without mounting workspace UI or running its effects.
 *
 * A rejection is not cached: an idle warm-up (the login page) can fail offline,
 * and a cached rejected promise would then fail the real mount too, where a
 * fresh `import()` would have retried.
 */
export function preloadMainLayout() {
  return (loading ??= import('./main-layout').then(
    (module) => {
      prepared = module.MainLayout;
      return { default: module.MainLayout };
    },
    (error: unknown) => {
      loading = undefined;
      throw error;
    }
  ));
}

const LazyMainLayout = lazy(preloadMainLayout);

export function PreloadedMainLayout(props: ComponentProps<typeof MainLayout>) {
  // React.lazy first encounters even a previously fulfilled native Promise as
  // pending. A prepared module can render directly, avoiding that suspension.
  const Layout = useRef(prepared ?? LazyMainLayout).current;
  // Every entry path needs the same frame while the layout chunk is pending.
  return (
    <Suspense fallback={<BootShell />}>
      <Layout {...props} />
    </Suspense>
  );
}

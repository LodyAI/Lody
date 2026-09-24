import { lazy, useRef, type ComponentProps } from 'react';
import type { MainLayout } from './main-layout';

let prepared: typeof MainLayout | undefined;
let loading: Promise<{ default: typeof MainLayout }> | undefined;

/** Load code without mounting workspace UI or running its effects. */
export function preloadMainLayout() {
  return (loading ??= import('./main-layout').then((module) => {
    prepared = module.MainLayout;
    return { default: module.MainLayout };
  }));
}

const LazyMainLayout = lazy(preloadMainLayout);

export function PreloadedMainLayout(props: ComponentProps<typeof MainLayout>) {
  // React.lazy first encounters even a previously fulfilled native Promise as
  // pending. A prepared module can render directly, avoiding that suspension.
  const Layout = useRef(prepared ?? LazyMainLayout).current;
  return <Layout {...props} />;
}

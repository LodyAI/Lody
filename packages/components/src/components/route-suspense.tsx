import { Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingPlaceholder } from '@/components/loading-placeholder';

type RouteSuspenseScope = 'viewport' | 'content';

/**
 * Suspense boundary for lazily imported route components.
 *
 * The fallback must never be `null`. These boundaries wrap the app's largest
 * chunks — `main-layout` above all — and a `null` fallback renders nothing at
 * all while that chunk is fetched, so the window falls through to the bare
 * `<body>` canvas: the white flash a user sees for a few seconds right after
 * signing in, on a cold start, or on a slow connection.
 *
 * `scope` mirrors `LoadingPlaceholder`'s variants. `viewport` is for a boundary
 * that owns the whole window (the lazy layout itself). `content` is for one
 * nested inside a mounted layout, where the pane can be shorter than the
 * viewport: with a top safe-area inset (the iPad shell) a `100dvh` placeholder
 * measures 48px taller than its pane, so `overflow-hidden` clips it and the
 * spinner lands 24px below the pane's centre.
 */
export function RouteSuspense({
  children,
  scope = 'viewport',
}: {
  children: ReactNode;
  scope?: RouteSuspenseScope;
}) {
  return <Suspense fallback={<RouteSuspenseFallback scope={scope} />}>{children}</Suspense>;
}

function RouteSuspenseFallback({ scope }: { scope: RouteSuspenseScope }) {
  const { t } = useTranslation();

  return <LoadingPlaceholder variant={scope} deferIndicator title={t('common.loading')} />;
}

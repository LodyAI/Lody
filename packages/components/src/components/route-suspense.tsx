import { Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingPlaceholder } from '@/components/loading-placeholder';

export type RouteSuspenseScope = 'viewport' | 'content';

/**
 * Suspense boundary for lazily imported route components.
 *
 * The fallback must never be `null`. These boundaries wrap the app's largest
 * chunks — `main-layout` above all — and a `null` fallback renders nothing at
 * all while that chunk is fetched, so the window falls through to the bare
 * `<body>` canvas: the white flash a user sees for a few seconds right after
 * signing in, on a cold start, or on a slow connection.
 *
 * `scope` mirrors `LoadingPlaceholder`'s variants and is not interchangeable:
 * `viewport` is for a boundary that owns the whole window (the lazy layout
 * itself), `content` for one nested inside an already-mounted layout, where a
 * full-viewport placeholder would paint over the live sidebar.
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

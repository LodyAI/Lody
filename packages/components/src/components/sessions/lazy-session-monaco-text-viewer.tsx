import * as stylex from '@stylexjs/stylex';
import { lazy, Suspense, type ComponentProps } from 'react';
import { Spinner } from '@lody/ui/spinner';
import type { SessionMonacoTextViewer } from './session-monaco-text-viewer';

export type SessionMonacoTextViewerProps = ComponentProps<typeof SessionMonacoTextViewer>;

const styles = stylex.create({
  loading: {
    display: 'flex',
    height: '100%',
    minHeight: 0,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

const LazyMonacoViewer = lazy(() =>
  import('./session-monaco-text-viewer').then((module) => ({
    default: module.SessionMonacoTextViewer,
  }))
);

/**
 * Code-splits the Monaco editor bundle: `session-monaco-text-viewer` and
 * everything it imports (`monaco-editor` JS/CSS, workers, language
 * registrations) load only when a text surface actually mounts the
 * viewer. The fallback paints a centered spinner while the chunk loads.
 */
export function LazySessionMonacoTextViewer(props: SessionMonacoTextViewerProps) {
  return (
    <Suspense
      fallback={
        <div {...stylex.props(styles.loading)} role="status">
          <Spinner label={null} />
        </div>
      }
    >
      <LazyMonacoViewer {...props} />
    </Suspense>
  );
}

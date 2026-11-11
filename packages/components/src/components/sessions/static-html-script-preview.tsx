import * as stylex from '@stylexjs/stylex';
import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useStableCallback } from '@/hooks/use-stable-callback';
import {
  buildStaticHtmlPreviewDocument,
  getStaticHtmlPreviewLogicalUrl,
} from './static-html-preview-document';
import { useManagedPreviewFrame } from './use-managed-preview-frame';

const styles = stylex.create({
  host: { width: '100%', height: '100%', minHeight: 0, flex: '1 1 0%', backgroundColor: '#fff' },
});

const noop = () => undefined;

/**
 * Executable preview of a self-contained HTML file outside a session (the mobile
 * project file browser). It is the managed static-document frame without the
 * session-scoped visual comments: same frame policy, runtime handshake, and
 * navigation policy as `ManagedPreviewSurface`, via `useManagedPreviewFrame`.
 * Render it only after the user explicitly chose to run scripts.
 */
export function StaticHtmlScriptPreview({
  path,
  text,
  onNavigationRequest,
}: {
  readonly path: string;
  readonly text: string;
  /** Any navigation other than an in-document `#fragment` must leave this preview. */
  readonly onNavigationRequest: (url: string) => void;
}) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const documentHtml = useMemo(() => buildStaticHtmlPreviewDocument(text), [text]);
  const logicalUrl = useMemo(() => getStaticHtmlPreviewLogicalUrl(path), [path]);
  const handleNavigationRequest = useStableCallback(onNavigationRequest);
  useManagedPreviewFrame({
    hostRef,
    sessionId: null,
    viewerUrl: logicalUrl,
    logicalUrl,
    documentHtml,
    // Mounted only after the user pressed "Run scripts" for this exact text.
    scriptsOptedIn: true,
    title: t('sessions.fileViewer.htmlPreview.scriptFrameTitle', 'HTML preview (scripts running)'),
    annotationEnabled: false,
    invalidRuntimeUrlMessage: '',
    onAnnotationAvailabilityChange: noop,
    onRuntimeError: noop,
    onLoadingChange: noop,
    onBrowserStateChange: noop,
    onNavigationRequest: handleNavigationRequest,
  });
  return <div ref={hostRef} {...stylex.props(styles.host)} data-lody-static-html-script-preview />;
}

import * as stylex from '@stylexjs/stylex';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { buildStaticHtmlPreviewDocument } from './static-html-preview-document';

const styles = stylex.create({
  frame: {
    width: '100%',
    height: '100%',
    minHeight: 0,
    flex: 1,
    borderWidth: 0,
    backgroundColor: 'white',
  },
});

const FRAME_PERMISSIONS =
  "accelerometer 'none'; autoplay 'none'; camera 'none'; clipboard-read 'none'; " +
  "clipboard-write 'none'; display-capture 'none'; encrypted-media 'none'; " +
  "fullscreen 'none'; geolocation 'none'; gyroscope 'none'; microphone 'none'; midi 'none'";

/**
 * Executable preview for a complete, self-contained HTML file outside a live
 * session surface (for example the mobile project file browser). It uses the
 * same policy-owned document and sandbox as the managed static preview: scripts
 * run in an opaque origin with no same-origin, form, popup, modal, storage, or
 * top-navigation privileges, and the injected CSP blocks network access.
 */
export function ScriptedHtmlPreview({ text }: { readonly text: string }) {
  const { t } = useTranslation();
  const document = useMemo(() => buildStaticHtmlPreviewDocument(text), [text]);
  return (
    <iframe
      {...stylex.props(styles.frame)}
      title={t('sessions.fileViewer.preview.show', 'Preview')}
      sandbox="allow-scripts"
      // React 19 forwards unknown lowercase attributes; engines without
      // credentialless frames ignore it.
      {...{ credentialless: '' }}
      referrerPolicy="no-referrer"
      allow={FRAME_PERMISSIONS}
      srcDoc={document}
      data-lody-scripted-html-preview="true"
    />
  );
}

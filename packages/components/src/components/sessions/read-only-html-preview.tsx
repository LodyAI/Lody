import * as stylex from '@stylexjs/stylex';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { buildReadOnlyHtmlPreviewDocument } from './static-html-preview-document';

const styles = stylex.create({
  frame: { width: '100%', height: '100%', minHeight: 0, flex: 1, borderWidth: 0 },
});

export function ReadOnlyHtmlPreview({ text }: { readonly text: string }) {
  const { t } = useTranslation();
  const document = useMemo(() => buildReadOnlyHtmlPreviewDocument(text), [text]);
  return (
    <iframe
      {...stylex.props(styles.frame)}
      title={t('sessions.fileViewer.preview.show', 'Preview')}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={document}
    />
  );
}

import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontSize, themeLineHeight, themeSpace } from '../../style/theme-scale.stylex';
import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import { FileTreeProviderView } from '@/components/sessions/components/file-tree-view';
import type { FileWorkspaceProvider, FileWorkspaceSnapshot } from '@/lib/file-workspace-provider';
import { ScrollArea } from '@lody/ui/scroll-area';
import { cn } from '@/lib/utils';

type ProjectFileBrowserProps = {
  readonly provider: FileWorkspaceProvider | null;
  readonly pending?: boolean;
  readonly message?: string;
  readonly className?: string;
};

type FileContentState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | { status: 'ready'; path: string; snapshot: FileWorkspaceSnapshot }
  | { status: 'error'; path: string; message: string };

export function ProjectFileBrowser({
  provider,
  pending,
  message,
  className,
}: ProjectFileBrowserProps) {
  const { t } = useTranslation();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<FileContentState>({ status: 'idle' });

  useEffect(() => {
    if (!provider || !selectedPath) {
      setContent({ status: 'idle' });
      return undefined;
    }

    let cancelled = false;
    setContent({ status: 'loading', path: selectedPath });
    void provider
      .openFile(selectedPath)
      .then((result) => {
        if (cancelled) return;
        if (result.status === 'unavailable') {
          setContent({
            status: 'error',
            path: selectedPath,
            message: result.message ?? t('workspace.projects.fileUnavailable', 'File unavailable'),
          });
          return;
        }
        setContent({ status: 'ready', path: selectedPath, snapshot: result.snapshot });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setContent({
          status: 'error',
          path: selectedPath,
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [provider, selectedPath, t]);

  return (
    <div className={cn(stylex.props(styles.root).className, className)}>
      <div {...stylex.props(styles.tree)}>
        <FileTreeProviderView
          fileProvider={provider}
          fileProviderPending={pending}
          fileProviderMessage={message}
          handleOpenFile={setSelectedPath}
        />
      </div>
      <ProjectFileContent content={content} />
    </div>
  );
}

function ProjectFileContent({ content }: { readonly content: FileContentState }) {
  const { t } = useTranslation();

  if (content.status === 'idle') {
    return (
      <div {...stylex.props(styles.empty)}>
        <FileText {...stylex.props(styles.fileIcon)} />
        {t('workspace.projects.selectFilePrompt', 'Select a file to preview it.')}
      </div>
    );
  }

  if (content.status === 'loading') {
    return (
      <div {...stylex.props(styles.loading)}>
        <Spinner {...stylex.props(styles.spinner)} />
        {t('workspace.projects.loadingFile', 'Loading file')}
      </div>
    );
  }

  if (content.status === 'error') {
    return (
      <div {...stylex.props(styles.error)}>
        <FileText {...stylex.props(styles.fileIcon)} />
        <span>{content.message}</span>
      </div>
    );
  }

  if (content.snapshot.kind !== 'text') {
    return (
      <div {...stylex.props(styles.empty)}>
        <FileText {...stylex.props(styles.fileIcon)} />
        {t('workspace.projects.binaryPreviewUnavailable', 'Preview is unavailable for this file.')}
      </div>
    );
  }

  return (
    <div {...stylex.props(styles.content)}>
      <div {...stylex.props(styles.path)}>{content.path}</div>
      <ScrollArea {...stylex.props(styles.scroller)}>
        <pre {...stylex.props(styles.text)}>{content.snapshot.text}</pre>
      </ScrollArea>
    </div>
  );
}

const styles = stylex.create({
  root: {
    display: 'grid',
    minHeight: '440px',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 768px)': '280px minmax(0, 1fr)',
    },
    overflow: 'hidden',
  },
  tree: {
    minHeight: 0,
    borderBottomWidth: { default: 1, '@media (min-width: 768px)': 0 },
    borderBottomStyle: 'solid',
    borderRightWidth: { default: 0, '@media (min-width: 768px)': 1 },
    borderRightStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
  },
  empty: {
    display: 'flex',
    minHeight: 0,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
    padding: themeSpace[6],
    textAlign: 'center',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  loading: {
    display: 'flex',
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
    padding: themeSpace[6],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  error: {
    display: 'flex',
    minHeight: 0,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
    padding: themeSpace[6],
    textAlign: 'center',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.destructive,
  },
  fileIcon: { width: themeSpace[5], height: themeSpace[5] },
  spinner: { width: themeSpace[4], height: themeSpace[4] },
  content: { display: 'flex', minHeight: 0, flexDirection: 'column' },
  path: {
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  scroller: { minHeight: 0, flex: '1 1 0%' },
  text: {
    minHeight: '100%',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    padding: themeSpace[3],
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontSize: themeFontSize.xs,
    lineHeight: themeSpace[5],
    color: themeColors.foreground,
  },
});

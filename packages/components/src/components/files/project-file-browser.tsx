import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { Spinner } from '@/ui/spinner';
import { useTranslation } from 'react-i18next';
import { FileTreeProviderView } from '@/components/sessions/components/file-tree-view';
import type { FileWorkspaceProvider, FileWorkspaceSnapshot } from '@/lib/file-workspace-provider';
import { ScrollArea } from '@/ui/scroll-area';
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
    <div
      className={cn(
        'grid min-h-[440px] grid-cols-1 overflow-hidden md:grid-cols-[280px_minmax(0,1fr)]',
        className
      )}
    >
      <div className="min-h-0 border-b border-border/60 md:border-b-0 md:border-r">
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
      <div className="flex min-h-0 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <FileText className="h-5 w-5" />
        {t('workspace.projects.selectFilePrompt', 'Select a file to preview it.')}
      </div>
    );
  }

  if (content.status === 'loading') {
    return (
      <div className="flex min-h-0 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner className="h-4 w-4" />
        {t('workspace.projects.loadingFile', 'Loading file')}
      </div>
    );
  }

  if (content.status === 'error') {
    return (
      <div className="flex min-h-0 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-destructive">
        <FileText className="h-5 w-5" />
        <span>{content.message}</span>
      </div>
    );
  }

  if (content.snapshot.kind !== 'text') {
    return (
      <div className="flex min-h-0 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <FileText className="h-5 w-5" />
        {t('workspace.projects.binaryPreviewUnavailable', 'Preview is unavailable for this file.')}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-border/60 px-3 py-2 font-mono text-xs text-muted-foreground">
        {content.path}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <pre className="min-h-full whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-foreground">
          {content.snapshot.text}
        </pre>
      </ScrollArea>
    </div>
  );
}

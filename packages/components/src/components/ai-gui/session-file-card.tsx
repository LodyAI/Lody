import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Clock,
  Download,
  Eye,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileJson,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Loader2,
} from 'lucide-react';
import type { SessionFilePayload } from '@lody/shared';
import { cn } from '@/lib/utils';
import {
  formatFileSize,
  getSessionFileDisplayState,
  getSessionFileKind,
  type SessionFileDisplayState,
  type SessionFileKind,
} from '@/lib/session-file-presentation';

const KIND_ICON: Record<SessionFileKind, typeof FileIcon> = {
  text: FileText,
  code: FileCode,
  data: FileJson,
  archive: FileArchive,
  spreadsheet: FileSpreadsheet,
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  document: FileText,
  binary: FileIcon,
};

export type SessionFileCardProps = {
  file: SessionFilePayload;
  /** Resolved display name of the machine holding the bytes (transport='local'). */
  pendingMachineName?: string;
  /** Click opens the in-app preview (text-previewable, available files only). */
  onPreview?: (file: SessionFilePayload) => void;
  /** Click downloads the file (non-previewable, available files only). */
  onDownload?: (file: SessionFilePayload) => void;
  /** True while a download triggered from this card is in flight. */
  isDownloading?: boolean;
  className?: string;
};

const buildSubtitle = ({
  state,
  sizeLabel,
  pendingMachineName,
  t,
}: {
  state: SessionFileDisplayState;
  sizeLabel: string;
  pendingMachineName?: string;
  t: ReturnType<typeof useTranslation>['t'];
}): string => {
  if (state === 'pending') {
    return pendingMachineName
      ? t('sessions.fileUploadingFromMachine', 'Uploading from {{machine}}…', {
          machine: pendingMachineName,
        })
      : t('sessions.fileUploading', 'Uploading…');
  }
  if (state === 'expired') {
    return t('sessions.fileExpired', 'File expired · {{size}}', { size: sizeLabel });
  }
  // Available files show just the size; the action (preview vs download) is
  // conveyed by the trailing icon + hover affordance, not verbose copy.
  return sizeLabel;
};

const buildActionIcon = ({
  state,
  isDownloading,
}: {
  state: SessionFileDisplayState;
  isDownloading: boolean;
}): ReactNode => {
  if (state === 'pending') {
    return <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />;
  }
  if (state === 'expired') {
    return <Clock className="h-4 w-4" aria-hidden="true" />;
  }
  if (state === 'downloadable') {
    return isDownloading ? (
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
    ) : (
      <Download className="h-4 w-4" aria-hidden="true" />
    );
  }
  // previewable
  return isDownloading ? (
    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
  ) : (
    <Eye className="h-4 w-4" aria-hidden="true" />
  );
};

/**
 * Pure file-attachment card. The action (preview vs download vs nothing) is
 * derived from the block's transport + retention state, never from props the
 * caller has to keep in sync — so a single card type renders every variant.
 */
export function SessionFileCard({
  file,
  pendingMachineName,
  onPreview,
  onDownload,
  isDownloading = false,
  className,
}: SessionFileCardProps) {
  const { t } = useTranslation();
  const state = getSessionFileDisplayState(file);
  const kind = getSessionFileKind(file.fileName, file.mimeType);
  const Icon = KIND_ICON[kind];

  const sizeLabel = formatFileSize(file.sizeBytes);
  const isInteractive = state === 'previewable' || state === 'downloadable';

  const handleClick = () => {
    if (state === 'previewable') {
      onPreview?.(file);
    } else if (state === 'downloadable') {
      onDownload?.(file);
    }
  };

  const subtitle = buildSubtitle({ state, sizeLabel, pendingMachineName, t });
  const actionIcon = buildActionIcon({ state, isDownloading });

  const isMuted = state === 'expired' || state === 'pending';

  return (
    <button
      type="button"
      onClick={isInteractive ? handleClick : undefined}
      disabled={!isInteractive}
      aria-label={file.fileName}
      className={cn(
        'group flex w-full max-w-sm items-center gap-3 rounded-xl border px-3 py-2.5 text-left',
        'border-border/60 bg-card/80 transition-[background-color,border-color,box-shadow] duration-150',
        isInteractive &&
          'cursor-pointer hover:border-border hover:bg-accent/50 hover:shadow-sm active:scale-[0.99]',
        !isInteractive && 'cursor-default',
        isMuted && 'opacity-70',
        className
      )}
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-lg transition-colors',
          isMuted
            ? 'bg-muted text-muted-foreground'
            : 'bg-muted/70 text-muted-foreground group-hover:bg-background group-hover:text-foreground'
        )}
      >
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium leading-tight text-foreground">
          {file.fileName}
        </span>
        <span className="truncate text-xs leading-tight text-muted-foreground tabular-nums">
          {subtitle}
        </span>
      </span>
      {actionIcon ? (
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
            /* One rest tone for every icon in a turn — an interactive affordance
               resting DIMMER than the static chrome around it read as disabled.
               Hover still brightens it. */
            isInteractive
              ? 'text-muted-foreground group-hover:bg-background group-hover:text-foreground'
              : 'text-muted-foreground'
          )}
        >
          {actionIcon}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Wraps one or more adjacent file cards. Decision #3: adjacent file blocks are
 * aggregated into a single vertical list at the view layer — there is no
 * `file_group` block type. Pure presentation; the parent supplies already-
 * grouped cards.
 */
export function SessionFileCardList({
  children,
  align = 'start',
}: {
  children: ReactNode;
  align?: 'start' | 'end';
}) {
  return (
    <div
      className={cn(
        'flex w-full flex-col gap-2',
        /* An assistant attachment (`align="start"`) is a top-level conversation
           row: the horizontal gutter belongs to `ConversationColumn` and the row
           gap to `cardSiblingGap`. User attachments keep their own insets. */
        align === 'end' ? 'items-end px-2 pt-1' : 'items-start'
      )}
    >
      {children}
    </div>
  );
}

/** Lightweight error/unavailable inline state for the card (e.g. preview 4xx). */
export function SessionFileCardError({ message }: { message: string }) {
  return (
    <div className="flex w-full max-w-sm items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{message}</span>
    </div>
  );
}

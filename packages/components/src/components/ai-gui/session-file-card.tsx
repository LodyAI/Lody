import { type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Clock, Download, Eye } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, focus, radius, space } from '@lody/ui/tokens/scales.stylex';
import type { SessionFilePayload } from '@lody/shared';
import { cn } from '@/lib/utils';
import { FileSheet } from './session-file-sheet';
import { evidenceSurface } from './surface';
import {
  formatFileSize,
  getSessionFileDisplayState,
  getSessionFileKind,
  isHtmlSessionFile,
  type SessionFileDisplayState,
} from '@/lib/session-file-presentation';

export type SessionFileCardProps = {
  file: SessionFilePayload;
  /** Static publications own their retention independently of the source upload. */
  retention?: 'workspace' | 'publication';
  /** Resolved display name of the machine holding the bytes (transport='local'). */
  pendingMachineName?: string;
  /** Click opens the in-app preview (text-previewable, available files only). */
  onPreview?: (file: SessionFilePayload) => void;
  /**
   * Downloads the file. The card's primary action when the file is not
   * previewable, and the secondary action on an HTML card — whose preview
   * opens a rendered surface, so the source bytes have no other route.
   */
  onDownload?: (file: SessionFilePayload) => void;
  /** True while a download triggered from this card is in flight. */
  isDownloading?: boolean;
  className?: string;
};

const buildSubtitle = ({
  state,
  sizeLabel,
  metaLabel,
  pendingMachineName,
  t,
}: {
  state: SessionFileDisplayState;
  sizeLabel: string;
  metaLabel: string;
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
  // Available files show their type and size; the action (preview vs download) is
  // conveyed by the trailing icon + hover affordance, not verbose copy.
  return metaLabel;
};

const buildActionIcon = ({
  state,
  isDownloading,
}: {
  state: SessionFileDisplayState;
  isDownloading: boolean;
}): ReactNode => {
  if (state === 'pending') {
    return <Spinner className="h-4 w-4" aria-hidden="true" />;
  }
  if (state === 'expired') {
    return <Clock className="h-4 w-4" aria-hidden="true" />;
  }
  if (state === 'downloadable') {
    return isDownloading ? (
      <Spinner className="h-4 w-4" aria-hidden="true" />
    ) : (
      <Download className="h-4 w-4" aria-hidden="true" />
    );
  }
  // previewable — a download in flight belongs to the separate download
  // button, so the preview affordance keeps reading as a preview.
  return <Eye className="h-4 w-4" aria-hidden="true" />;
};

/*
 * A delivered file is evidence, so it rests quietly under the answer it belongs
 * to — but it is also the thing the agent made, and it reads as one: a small
 * sheet of paper (`FileSheet`) laid on a tinted tray. There are exactly two
 * surfaces. The tray is the page's region rung, with no outline and no shadow;
 * the sheet is the only thing that casts one, so no edge is ever drawn twice.
 * The name is the only line at full ink; the type and size sit one step under it
 * ("PDF · 2.4 MB"). Colour stays out: it is reserved for outcomes, and a PDF is
 * not one. Earlier attempts at an object failed by stacking outlines and
 * competing parts (see the hierarchy Spec); this one holds the count at tray,
 * sheet, name, size and action.
 */

const card = stylex.create({
  root: {
    position: 'relative',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'stretch',
    columnGap: space[1],
    width: '100%',
    maxWidth: '24rem',
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: colors.secondaryBackground,
    textAlign: 'start',
    transitionProperty: 'background-color, transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  interactive: {
    backgroundColor: {
      default: colors.secondaryBackground,
      ':hover': `color-mix(in srgb, ${colors.secondaryBackground}, ${colors.label} 4%)`,
    },
    transform: { default: 'none', ':active': 'scale(0.99)' },
  },
  failed: {
    backgroundColor: `color-mix(in srgb, ${colors.secondaryBackground}, ${colors.destructive} 8%)`,
  },
  main: {
    display: 'flex',
    alignItems: 'center',
    columnGap: '10px',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    paddingBlock: space[1.5],
    paddingInlineStart: space[2],
    paddingInlineEnd: space[1.5],
    textAlign: 'start',
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    // The ring is inset: the card clips overflow, so an outer ring would be cut off.
    boxShadow: {
      default: 'none',
      ':focus-visible': `inset 0 0 0 ${focus.ringWidth} ${colors.accent}`,
    },
  },
  pointer: { cursor: 'pointer' },
  inert: { cursor: 'default' },
  body: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
  },
  clip: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  figures: { fontVariantNumeric: 'tabular-nums' },
  action: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: `calc(${space[8]} - ${space[1]})`,
    height: `calc(${space[8]} - ${space[1]})`,
    borderRadius: radius.mini,
    color: colors.secondaryLabel,
    transitionProperty: 'color, background-color',
    transitionDuration: duration.fast,
  },
  /* One rest tone for every icon in a turn: an affordance resting dimmer than the
     chrome around it read as disabled. Hover brightens it and sinks the chip into
     a well; `hoverFill` would vanish against the card's own hover tint. */
  actionLive: {
    color: {
      default: colors.secondaryLabel,
      [stylex.when.ancestor(':hover')]: colors.label,
      [stylex.when.ancestor(':focus-visible')]: colors.label,
    },
    backgroundColor: {
      default: 'transparent',
      [stylex.when.ancestor(':hover')]: colors.wellBackground,
      [stylex.when.ancestor(':focus-visible')]: colors.wellBackground,
    },
  },
  /* A control of its own beside the card's main button (the HTML source download). */
  actionPress: {
    alignSelf: 'center',
    marginInlineEnd: space[1.5],
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    backgroundColor: { default: 'transparent', ':hover': colors.wellBackground },
    cursor: { default: 'pointer', ':disabled': 'not-allowed' },
    opacity: { default: 1, ':disabled': 0.6 },
  },
  actionFailed: { color: colors.label },
});

/** The extension a type label prints: short and plain, or nothing (the size stands alone). */
const getExtensionLabel = (fileName: string): string | null => {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = base.slice(dot + 1);
  return /^[A-Za-z0-9]{1,4}$/.test(extension) ? extension : null;
};

/** "PDF · 2.4 MB": what the file is, then how big. A name with no short extension shows the size alone. */
export const formatSessionFileMeta = (fileName: string, sizeBytes: number): string => {
  const extension = getExtensionLabel(fileName);
  const size = formatFileSize(sizeBytes);
  return extension ? `${extension.toUpperCase()} · ${size}` : size;
};

/** The control that sits beside a card's main button, in the card's own action style. */
export const SESSION_FILE_CARD_ACTION_CLASS = stylex.props(card.action, card.actionPress).className;

/** The delivered card layout, also used while attachment preparation is pending. */
export function SessionFileCardLayout({
  inline = false,
  fileName,
  mimeType,
  subtitle,
  actionIcon,
  isInteractive = false,
  isMuted = false,
  failed = false,
  onClick,
  secondaryAction,
  progress,
  className,
}: {
  inline?: boolean;
  fileName: string;
  /** With the name, picks the kind of page the sheet draws. */
  mimeType?: string;
  subtitle: string;
  actionIcon: ReactNode;
  isInteractive?: boolean;
  isMuted?: boolean;
  failed?: boolean;
  onClick?: () => void;
  secondaryAction?: ReactNode;
  progress?: ReactNode;
  className?: string;
}) {
  const Frame = inline ? 'span' : 'div';
  return (
    <Frame
      className={cn(
        stylex.props(card.root, isInteractive && card.interactive, failed && card.failed).className,
        className
      )}
    >
      <button
        type="button"
        onClick={isInteractive ? onClick : undefined}
        disabled={!isInteractive}
        aria-label={fileName}
        className={
          stylex.props(stylex.defaultMarker(), card.main, isInteractive ? card.pointer : card.inert)
            .className
        }
      >
        <FileSheet
          kind={getSessionFileKind(fileName, mimeType)}
          live={isInteractive}
          muted={isMuted}
        />
        <span {...stylex.props(card.body)}>
          <span {...stylex.props(evidenceSurface.name, card.clip)}>{fileName}</span>
          <span
            {...stylex.props(
              evidenceSurface.subtitle,
              failed && evidenceSurface.failed,
              card.clip,
              card.figures
            )}
            title={subtitle}
          >
            {subtitle}
          </span>
        </span>
        {actionIcon ? (
          <span
            {...stylex.props(
              card.action,
              isInteractive && card.actionLive,
              failed && card.actionFailed
            )}
          >
            {actionIcon}
          </span>
        ) : null}
      </button>
      {secondaryAction}
      {progress}
    </Frame>
  );
}

/**
 * Pure file-attachment card. The action (preview vs download vs nothing) is
 * derived from the block and its storage owner's retention policy. Publication
 * copies never inherit the original workspace upload's expiration.
 */
export function SessionFileCard({
  file,
  retention = 'workspace',
  pendingMachineName,
  onPreview,
  onDownload,
  isDownloading = false,
  className,
}: SessionFileCardProps) {
  const { t } = useTranslation();
  const state =
    retention === 'publication'
      ? file.textPreview
        ? 'previewable'
        : 'downloadable'
      : getSessionFileDisplayState(file);

  const sizeLabel = formatFileSize(file.sizeBytes);
  const isInteractive = state === 'previewable' || state === 'downloadable';

  const handleClick = () => {
    if (state === 'previewable') {
      onPreview?.(file);
    } else if (state === 'downloadable') {
      onDownload?.(file);
    }
  };

  const subtitle = buildSubtitle({
    state,
    sizeLabel,
    metaLabel: formatSessionFileMeta(file.fileName, file.sizeBytes),
    pendingMachineName,
    t,
  });
  const actionIcon = buildActionIcon({ state, isDownloading });

  const isMuted = state === 'expired' || state === 'pending';

  /* An HTML attachment's click opens the RENDERED page (browser surface or live
     file preview), which carries no control for the source bytes — so that one
     card offers download as a second, always-visible action rather than hiding
     the source behind the preview it replaces. Every other previewable file
     opens the preview dialog, which already downloads from inside. */
  const showDownloadAction = state === 'previewable' && isHtmlSessionFile(file) && !!onDownload;
  const downloadLabel = t('sessions.fileActions.download', 'Download file');

  return (
    <SessionFileCardLayout
      fileName={file.fileName}
      mimeType={file.mimeType}
      subtitle={subtitle}
      actionIcon={actionIcon}
      isInteractive={isInteractive}
      isMuted={isMuted}
      onClick={handleClick}
      className={className}
      secondaryAction={
        showDownloadAction ? (
          <button
            type="button"
            onClick={() => onDownload?.(file)}
            disabled={isDownloading}
            aria-busy={isDownloading}
            aria-label={downloadLabel}
            title={downloadLabel}
            className={SESSION_FILE_CARD_ACTION_CLASS}
          >
            {isDownloading ? (
              <Spinner className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Download className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        ) : null
      }
    />
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

import type { CodeCollabContentUnavailableReason } from '@lody/shared';
import * as stylex from '@stylexjs/stylex';
import { Copy, ExternalLink, FolderOpen, Loader2, Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
// The action model is shared with the file tree context menu and the side
// panel ⋯ menu; the card is one consumer of it, not its owner.
import type { SessionFileErrorActions } from '@/lib/session-file-actions';
import { Button } from '@lody/ui/button';

const spin = stylex.keyframes({ to: { transform: 'rotate(360deg)' } });
const styles = stylex.create({
  frame: {
    display: 'flex',
    minHeight: '100%',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingBlock: '24px',
    paddingInline: '16px',
  },
  card: {
    width: '100%',
    maxWidth: '20rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    borderRadius: '0.75rem',
    backgroundColor: 'hsl(var(--card))',
    paddingBlock: '14px',
    paddingInline: '16px',
    boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  },
  title: {
    color: 'hsl(var(--foreground))',
    fontSize: '0.875rem',
    fontWeight: 600,
    lineHeight: '1.25rem',
  },
  description: {
    marginTop: '4px',
    color: 'hsl(var(--muted-foreground))',
    fontSize: '13px',
    lineHeight: '1.25rem',
  },
  actions: { display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '12px' },
  actionIcon: { width: '14px', height: '14px', flexShrink: 0 },
  spinner: {
    width: '14px',
    height: '14px',
    flexShrink: 0,
    animationName: spin,
    animationDuration: '1s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  technicalDetails: {
    marginTop: '12px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    paddingTop: '10px',
    color: 'hsl(var(--muted-foreground))',
    fontSize: '0.75rem',
    lineHeight: '1rem',
  },
  summary: {
    cursor: 'pointer',
    userSelect: 'none',
    fontWeight: 500,
    color: 'color-mix(in oklab, hsl(var(--foreground)) 80%, transparent)',
  },
  technicalText: {
    marginTop: '8px',
    overflowWrap: 'break-word',
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.25rem',
  },
});

type Translation = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

export type SessionFileErrorKind =
  | 'outside-workspace'
  | 'not-found'
  | 'permission-denied'
  | 'temporarily-locked'
  | 'temporarily-unavailable'
  | 'too-large'
  | 'unsupported'
  | 'content-unavailable'
  | 'unknown';

/**
 * Only the errors whose advice is "open it outside Lody" get the actions. On a
 * missing, denied, or offline file every button would fail, so they stay off.
 */
export function offersFileActions(kind: SessionFileErrorKind): boolean {
  return kind === 'too-large' || kind === 'unsupported';
}

export type SessionFileErrorPresentation = {
  readonly kind: SessionFileErrorKind;
  readonly title: string;
  readonly description: string;
  readonly technicalDetails?: string;
};

function providerReasonPresentation(
  reason: CodeCollabContentUnavailableReason,
  t: Translation
): SessionFileErrorPresentation {
  switch (reason) {
    case 'deleted':
      return {
        kind: 'not-found',
        title: t('sessions.fileError.notFound.title', 'File not found'),
        description: t(
          'sessions.fileError.notFound.description',
          'This file may have been moved, renamed, or deleted. Open it again from the file list if it still exists.'
        ),
      };
    case 'permission-denied':
      return {
        kind: 'permission-denied',
        title: t('sessions.fileError.permissionDenied.title', 'Access denied'),
        description: t(
          'sessions.fileError.permissionDenied.description',
          'Lody does not have permission to read this file. Check the file or workspace permissions and try again.'
        ),
      };
    case 'locked':
      return {
        kind: 'temporarily-locked',
        title: t('sessions.fileError.locked.title', 'File is temporarily locked'),
        description: t(
          'sessions.fileError.locked.description',
          'Another process is using this file. Wait a moment, then try opening it again.'
        ),
      };
    case 'transient-io':
      return {
        kind: 'temporarily-unavailable',
        title: t('sessions.fileError.temporary.title', 'File is temporarily unavailable'),
        description: t(
          'sessions.fileError.temporary.description',
          'The host could not read this file right now. Check that the host is online, then try again.'
        ),
      };
    case 'text-too-large':
    case 'blob-too-large':
      return {
        kind: 'too-large',
        title: t('sessions.fileError.tooLarge.title', 'File is too large to preview'),
        description: t(
          'sessions.fileError.tooLarge.description',
          'This file exceeds the preview limit. Open it directly on the host machine instead.'
        ),
      };
    case 'line-too-long':
      return {
        kind: 'unsupported',
        title: t('sessions.fileError.lineTooLong.title', 'File cannot be previewed'),
        description: t(
          'sessions.fileError.lineTooLong.description',
          'This file contains a line that is too long for the editor. Reformat it or open it on the host machine.'
        ),
      };
    case 'unsupported-encoding':
      return {
        kind: 'unsupported',
        title: t('sessions.fileError.encoding.title', 'Encoding is not supported'),
        description: t(
          'sessions.fileError.encoding.description',
          'This file is not encoded as UTF-8. Convert it to UTF-8 before opening it in Lody.'
        ),
      };
    case 'unsupported-special':
      return {
        kind: 'unsupported',
        title: t('sessions.fileError.unsupported.title', 'File type is not supported'),
        description: t(
          'sessions.fileError.unsupported.description',
          'This is a special system file that cannot be displayed safely in Lody.'
        ),
      };
    case 'path-collision':
      return {
        kind: 'unsupported',
        title: t('sessions.fileError.pathCollision.title', 'File path is ambiguous'),
        description: t(
          'sessions.fileError.pathCollision.description',
          'Another file has the same path with different letter casing. Rename one of the files and try again.'
        ),
      };
    case 'metadata-only':
    case 'missing-text-frontiers':
    case 'missing-blob-digest':
    case 'blob-expired':
      return {
        kind: 'content-unavailable',
        title: t('sessions.fileError.contentUnavailable.title', 'File content is not available'),
        description: t(
          'sessions.fileError.contentUnavailable.description',
          'The file is listed in this session, but its content has not been synced or is no longer available. Ask the host to refresh the file data.'
        ),
      };
    case 'unknown':
      return {
        kind: 'unknown',
        title: t('sessions.fileError.unknown.title', 'Could not open this file'),
        description: t(
          'sessions.fileError.unknown.description',
          'Lody could not read this file. Try again, or check the file on the host machine.'
        ),
      };
  }
  return assertNever(reason);
}

export function getSessionFileErrorPresentation(
  message: string,
  reason: CodeCollabContentUnavailableReason | undefined,
  t: Translation
): SessionFileErrorPresentation {
  const normalized = message.trim().toLowerCase();
  // The path boundary is checked BEFORE the reason mapping. File Preview v3
  // reports a rejected path as `permission-denied` (there is no dedicated
  // unavailable reason for it), and "Access denied" would misdescribe it — the
  // file is readable, it is just outside what Lody may read for this session.
  if (
    normalized.includes('path escapes workspace root') ||
    normalized.includes('resolved path escapes workspace root') ||
    normalized.includes('workspace-path-rejected') ||
    normalized.includes('outside the workspace')
  ) {
    return {
      kind: 'outside-workspace',
      title: t('sessions.fileError.outsideWorkspace.title', 'File is outside the workspace'),
      description: t(
        'sessions.fileError.outsideWorkspace.description',
        'For security, Lody can only read files inside this session’s workspace and Lody’s own temporary directories. Choose a file from the workspace and try again.'
      ),
    };
  }

  // Also ahead of the reason mapping, and for the same reason the path check is:
  // the machine reports an owner-session mismatch as `permission_denied`, so the
  // reason alone renders it as "Access denied" — a permanent-sounding verdict on
  // a file nobody was ever denied. It is a startup race. The client derives the
  // owner from `parentSessionId ?? sessionId` in synced session meta while the
  // machine derives it from the live session, and they disagree for exactly as
  // long as that meta takes to land. The only correct advice is "try again".
  // Matches both producers: `machine-rpc-server.ts` ("Code Collab RPC owner
  // session mismatch.") and `rpc.ts` ("…payload owner session mismatch.").
  if (normalized.includes('owner session mismatch')) {
    return {
      kind: 'temporarily-unavailable',
      title: t('sessions.fileError.sessionMismatch.title', 'File is not ready yet'),
      description: t(
        'sessions.fileError.sessionMismatch.description',
        'This session is still connecting to its workspace. Try opening the file again in a moment.'
      ),
    };
  }

  if (reason) {
    return providerReasonPresentation(reason, t);
  }

  if (
    normalized.includes('file was not found') ||
    normalized.includes('file not found') ||
    normalized.includes('no such file') ||
    normalized.includes('enoent') ||
    normalized.includes('enotdir')
  ) {
    return providerReasonPresentation('deleted', t);
  }
  if (
    normalized.includes('permission denied') ||
    normalized.includes('eacces') ||
    normalized.includes('eperm')
  ) {
    return providerReasonPresentation('permission-denied', t);
  }
  if (
    normalized.includes('file is locked') ||
    normalized.includes('file locked') ||
    normalized.includes('ebusy') ||
    normalized.includes('etxtbsy')
  ) {
    return providerReasonPresentation('locked', t);
  }
  if (
    normalized.includes('too large') ||
    normalized.includes('file-too-large') ||
    normalized.includes('preview limit')
  ) {
    return providerReasonPresentation('text-too-large', t);
  }
  if (
    normalized.includes('unsupported encoding') ||
    normalized.includes('invalid utf-8') ||
    normalized.includes('invalid utf8')
  ) {
    return providerReasonPresentation('unsupported-encoding', t);
  }
  if (
    normalized.includes('machine is offline') ||
    normalized.includes('host is offline') ||
    normalized.includes('local project is unavailable') ||
    normalized.includes('session worktree is unavailable') ||
    normalized.includes('file api is unavailable') ||
    normalized.includes('files are unavailable')
  ) {
    return {
      kind: 'temporarily-unavailable',
      title: t('sessions.fileError.hostUnavailable.title', 'Host is unavailable'),
      description: t(
        'sessions.fileError.hostUnavailable.description',
        'Lody cannot reach the machine that owns this file. Bring the host online and try again.'
      ),
    };
  }
  if (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('network') ||
    normalized.includes('temporary io') ||
    normalized.includes('eagain')
  ) {
    return providerReasonPresentation('transient-io', t);
  }

  return {
    ...providerReasonPresentation('unknown', t),
    ...(message.trim() ? { technicalDetails: message.trim() } : {}),
  };
}

// One row per action, all the same width. A wrapping row of buttons sized by
// their own labels was the previous layout, and in a side panel it produced
// three ragged widths on three lines — the width difference read as meaning.
const ACTION_BUTTON_CLASS = 'h-8 w-full justify-start gap-2 px-2.5 text-xs font-normal';

export function SessionFileErrorState({
  message,
  reason,
  fileActions,
}: {
  readonly message: string;
  readonly reason?: CodeCollabContentUnavailableReason;
  readonly fileActions?: SessionFileErrorActions;
}) {
  const { t } = useTranslation();
  const presentation = getSessionFileErrorPresentation(message, reason, t);
  const actions = fileActions && offersFileActions(presentation.kind) ? fileActions : undefined;
  return <SessionFileNoticeCard presentation={presentation} fileActions={actions} />;
}

/** Shared presentation for files that cannot be displayed inline. */
export function SessionFileNoticeCard({
  presentation,
  fileActions: actions,
}: {
  readonly presentation: Pick<
    SessionFileErrorPresentation,
    'title' | 'description' | 'technicalDetails'
  >;
  readonly fileActions?: SessionFileErrorActions;
}) {
  const { t } = useTranslation();
  const localHost = actions?.localHost;

  return (
    <div {...stylex.props(styles.frame)}>
      {/* No status glyph: the card is one short paragraph and a stack of
          actions, and a 40px icon column indented all of it for decoration. */}
      <section data-testid="session-file-error-state" {...stylex.props(styles.card)}>
        <h2 {...stylex.props(styles.title)}>{presentation.title}</h2>
        <p {...stylex.props(styles.description)}>{presentation.description}</p>
        {actions ? (
          <div {...stylex.props(styles.actions)}>
            {actions.onShare ? (
              <Button
                size="small"
                variant="secondary"
                className={ACTION_BUTTON_CLASS}
                onClick={actions.onShare}
                disabled={actions.sharing}
              >
                {actions.sharing ? (
                  <Loader2 {...stylex.props(styles.spinner)} aria-hidden="true" />
                ) : (
                  <Share2 {...stylex.props(styles.actionIcon)} aria-hidden="true" />
                )}
                {t('sessions.fileActions.share', 'Share file…')}
              </Button>
            ) : null}
            {localHost ? (
              <>
                <Button
                  size="small"
                  variant="secondary"
                  className={ACTION_BUTTON_CLASS}
                  onClick={localHost.onOpen}
                  data-testid="session-file-error-open"
                >
                  <ExternalLink {...stylex.props(styles.actionIcon)} aria-hidden="true" />
                  {localHost.openTarget === 'browser'
                    ? t('sessions.fileActions.openInBrowser', 'Open in browser')
                    : t('sessions.fileActions.openInDefaultApp', 'Open in default app')}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  className={ACTION_BUTTON_CLASS}
                  onClick={localHost.onReveal}
                  data-testid="session-file-error-reveal"
                >
                  <FolderOpen {...stylex.props(styles.actionIcon)} aria-hidden="true" />
                  {localHost.revealLabel}
                </Button>
              </>
            ) : null}
            <Button
              size="small"
              // Without the local-host pair this is the only way out of the
              // card, so it leads instead of trailing them.
              variant={localHost || actions.onShare ? 'ghost' : 'secondary'}
              className={ACTION_BUTTON_CLASS}
              onClick={actions.onCopyPath}
              data-testid="session-file-error-copy-path"
            >
              <Copy {...stylex.props(styles.actionIcon)} aria-hidden="true" />
              {t('sessions.fileViewer.copyPath', 'Copy file path')}
            </Button>
          </div>
        ) : null}
        {presentation.technicalDetails ? (
          <details {...stylex.props(styles.technicalDetails)}>
            <summary {...stylex.props(styles.summary)}>
              {t('sessions.fileError.technicalDetails', 'Technical details')}
            </summary>
            <p {...stylex.props(styles.technicalText)}>{presentation.technicalDetails}</p>
          </details>
        ) : null}
      </section>
    </div>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled session file error reason: ${String(value)}`);
}

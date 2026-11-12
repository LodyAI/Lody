import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PendingE2eeWorkspace } from '@/lib/e2ee-workspace-storage';

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', gap: space[2], width: '100%' },
  heading: { margin: 0, color: colors.secondaryLabel, fontSize: text.footnoteSize },
  list: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderRadius: radius.large,
    backgroundColor: colors.secondaryBackground,
    overflow: 'hidden',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingBlock: space[1.5],
    paddingInline: space[2],
    borderTopWidth: { default: 1, ':first-child': 0 },
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.label,
  },
  // Aligns plain archived text with the small ghost button text in active rows.
  muted: { color: colors.secondaryLabel, paddingInline: '10px' },
  help: { margin: 0, color: colors.secondaryLabel, fontSize: text.footnoteSize, lineHeight: 1.5 },
  rowSelect: { flex: 1, minWidth: 0, overflow: 'hidden' },
});

const requestLabel = (request: PendingE2eeWorkspace) => `${request.name} · ${request.slug}`;

/**
 * Saved encrypted creation requests on this device. Archiving only moves a request
 * out of the default list; restoring brings back the same saved request.
 */
export function E2eeCreationRequestList(props: {
  requests: PendingE2eeWorkspace[];
  archivedRequests: PendingE2eeWorkspace[];
  selectedRequestId: string | null;
  disabled: boolean;
  onSelectRequest: (requestId: string) => void;
  onArchiveRequest: (requestId: string) => void;
  onRestoreRequest: (requestId: string) => void;
  /** Start with the archive expanded (Storybook and screenshots). */
  defaultArchiveOpen?: boolean;
}) {
  const { t } = useTranslation();
  const [archiveOpen, setArchiveOpen] = useState(props.defaultArchiveOpen ?? false);
  if (props.requests.length === 0 && props.archivedRequests.length === 0) return null;
  return (
    <div {...stylex.props(styles.root)} data-testid="e2ee-creation-requests">
      {props.requests.length > 0 && (
        <>
          <p {...stylex.props(styles.heading)}>{t('e2ee.create.savedRequests')}</p>
          <ul {...stylex.props(styles.list)}>
            {props.requests.map((request) => (
              <li
                key={request.requestId}
                data-request-id={request.requestId}
                {...stylex.props(styles.row)}
              >
                <div {...stylex.props(styles.rowSelect)}>
                  <Button
                    variant="ghost"
                    size="small"
                    aria-pressed={props.selectedRequestId === request.requestId}
                    disabled={props.disabled}
                    onClick={() => props.onSelectRequest(request.requestId)}
                  >
                    {requestLabel(request)}
                  </Button>
                </div>
                <Button
                  variant="secondary"
                  size="small"
                  aria-label={t('e2ee.create.archiveRequestLabel', { name: requestLabel(request) })}
                  disabled={props.disabled}
                  onClick={() => props.onArchiveRequest(request.requestId)}
                >
                  {t('e2ee.create.archiveRequest')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {props.archivedRequests.length > 0 && (
        <>
          <div>
            <Button
              variant="ghost"
              size="small"
              aria-expanded={archiveOpen}
              data-testid="e2ee-creation-archived-toggle"
              onClick={() => setArchiveOpen((open) => !open)}
            >
              {t('e2ee.create.archivedRequests', { count: props.archivedRequests.length })}
            </Button>
          </div>
          {archiveOpen && (
            <>
              <p {...stylex.props(styles.help)}>{t('e2ee.create.archivedHelp')}</p>
              <ul {...stylex.props(styles.list)}>
                {props.archivedRequests.map((request) => (
                  <li
                    key={request.requestId}
                    data-request-id={request.requestId}
                    {...stylex.props(styles.row)}
                  >
                    <span {...stylex.props(styles.rowLabel, styles.muted)}>
                      {requestLabel(request)}
                    </span>
                    <Button
                      variant="secondary"
                      size="small"
                      aria-label={t('e2ee.create.restoreRequestLabel', {
                        name: requestLabel(request),
                      })}
                      disabled={props.disabled}
                      onClick={() => props.onRestoreRequest(request.requestId)}
                    >
                      {t('e2ee.create.restoreRequest')}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

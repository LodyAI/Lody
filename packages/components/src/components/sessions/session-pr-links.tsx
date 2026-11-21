import { useState, type FormEvent } from 'react';
import * as stylex from '@stylexjs/stylex';
import { CircleAlert, CircleDashed, Unlink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  planSessionPullRequestLink,
  planSessionPullRequestUnlink,
  type SessionPullRequestLinkListItem,
} from '@lody/shared';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Dialog } from '@lody/ui/dialog';
import { SessionPrIcon } from '@/components/sidebar-row-shared';

/**
 * Outcome of linking a pasted URL: `linked` wrote the user's record; the
 * reconciler associates it once the provider confirms the PR.
 */
export type LinkPullRequestOutcome = 'linked' | 'unsupported' | 'limit' | 'failed';

type MetaWrite = (patch: Record<string, unknown>) => Promise<void>;

/** A user's own link record; the renderer never writes `pullRequests`. */
export async function linkSessionPullRequestFromUi(
  meta: Record<string, unknown> | null | undefined,
  input: string,
  write: MetaWrite,
  nowMs: () => number = Date.now
): Promise<LinkPullRequestOutcome> {
  const trimmed = input.trim();
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const plan = planSessionPullRequestLink(meta, url, 'user', nowMs());
  if (!plan.ok) return plan.reason;
  try {
    await write({ [plan.field]: plan.value });
    return 'linked';
  } catch {
    return 'failed';
  }
}

export async function unlinkSessionPullRequestFromUi(
  meta: Record<string, unknown> | null | undefined,
  url: string,
  write: MetaWrite,
  nowMs: () => number = Date.now
): Promise<boolean> {
  const plan = planSessionPullRequestUnlink(meta, url, nowMs());
  if (!plan.ok) return false;
  await write({ [plan.field]: plan.value });
  return true;
}

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: space[2],
    padding: `${space[2]} ${space[2]} ${space[1]}`,
    fontSize: text.footnoteSize,
  },
  title: { color: colors.label, fontWeight: 500 },
  count: { color: colors.secondaryLabel },
  list: { maxHeight: 280, overflowY: 'auto', padding: space[1], margin: 0, listStyle: 'none' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minHeight: '30px',
    paddingInline: space[1.5],
    borderRadius: '6px',
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    fontSize: text.footnoteSize,
  },
  open: {
    display: 'flex',
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    gap: space[2],
    paddingBlock: space[1],
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  },
  label: {
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.label,
    fontVariantNumeric: 'tabular-nums',
  },
  reason: {
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.secondaryLabel,
  },
  glyph: { width: 14, height: 14, flexShrink: 0, color: colors.secondaryLabel },
  text: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, gap: '2px' },
  labelLine: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  detail: { color: colors.secondaryLabel, lineHeight: 1.35 },
  empty: {
    padding: `${space[1]} ${space[2]} ${space[2]}`,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
  },
  form: {
    display: 'flex',
    gap: space[1.5],
    padding: space[2],
  },
  field: { flex: 1, minWidth: 0 },
  error: {
    paddingInline: space[2],
    paddingBottom: space[2],
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
  },
});

function itemLabel(item: SessionPullRequestLinkListItem): string {
  const repo = item.kind === 'associated' ? item.view.repoFullName : item.repoFullName;
  const number = item.kind === 'associated' ? item.view.number : item.number;
  return repo && number != null ? `${repo}#${number}` : item.url;
}

/**
 * Every pull request a Session holds, across repositories: the primary PR
 * first, then other associations, then links the machine has not confirmed
 * (with the reason). A pasted URL links another PR; Unlink removes one.
 */
export type SessionPullRequestLinksProps = {
  items: readonly SessionPullRequestLinkListItem[];
  onOpen?: (item: SessionPullRequestLinkListItem) => void;
  onUnlink?: (url: string) => void | Promise<void>;
  onLink?: (url: string) => Promise<LinkPullRequestOutcome>;
};

export function SessionPullRequestLinksPanel({
  items,
  onOpen,
  onUnlink,
  onLink,
}: SessionPullRequestLinksProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [error, setError] = useState<Exclude<LinkPullRequestOutcome, 'linked'> | null>(null);
  const [busy, setBusy] = useState(false);

  const reasonText = {
    checking: t('sessions.prLinks.checking', 'Checking with GitHub…'),
    unreadable: t(
      'sessions.prLinks.unreadable',
      "GitHub did not return this pull request. It may not exist, or this machine's GitHub account cannot read it."
    ),
    unsupported: t('sessions.prLinks.unsupportedRecord', 'This provider is not supported yet.'),
  } as const;
  const errorText = {
    unsupported: t(
      'sessions.prLinks.unsupported',
      'This link is not supported yet. Paste a GitHub pull request URL.'
    ),
    limit: t('sessions.prLinks.limit', 'This session already holds the most links it can keep.'),
    failed: t('sessions.prLinks.failed', 'The link could not be saved.'),
  } as const;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!onLink || !value.trim() || busy) return;
    setBusy(true);
    try {
      const outcome = await onLink(value);
      if (outcome === 'linked') {
        setValue('');
        setError(null);
      } else setError(outcome);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.header)}>
        <span {...stylex.props(styles.title)}>
          {t('sessions.prLinks.title', 'Linked pull requests')}
        </span>
        <span {...stylex.props(styles.count)}>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div {...stylex.props(styles.empty)}>
          {t('sessions.prLinks.empty', 'No pull request is linked to this session.')}
        </div>
      ) : (
        <ul {...stylex.props(styles.list)}>
          {items.map((item) => {
            const label = itemLabel(item);
            const content = (
              <>
                {item.kind === 'associated' ? (
                  <SessionPrIcon prStatus={item.view.status} prCiState={item.view.ci} />
                ) : item.reason === 'checking' ? (
                  <CircleDashed {...stylex.props(styles.glyph)} aria-hidden="true" />
                ) : (
                  <CircleAlert {...stylex.props(styles.glyph)} aria-hidden="true" />
                )}
                <span {...stylex.props(styles.text)}>
                  <span {...stylex.props(styles.labelLine)}>
                    <span {...stylex.props(styles.label)}>{label}</span>
                    {item.kind === 'associated' && item.primary ? (
                      <Badge>{t('sessions.prLinks.primary', 'Primary')}</Badge>
                    ) : null}
                    {item.kind === 'pending' && item.reason === 'checking' ? (
                      <span {...stylex.props(styles.reason)} title={reasonText.checking}>
                        {t('sessions.prLinks.checkingShort', 'Checking')}
                      </span>
                    ) : null}
                  </span>
                  {item.kind === 'pending' && item.reason !== 'checking' ? (
                    <span {...stylex.props(styles.detail)}>{reasonText[item.reason]}</span>
                  ) : null}
                </span>
              </>
            );
            return (
              <li key={item.url} {...stylex.props(styles.row)}>
                <button
                  type="button"
                  title={item.url}
                  onClick={() => onOpen?.(item)}
                  {...stylex.props(styles.open)}
                >
                  {content}
                </button>
                {onUnlink ? (
                  <Button
                    variant="ghost"
                    size="mini"
                    icon
                    aria-label={t('sessions.prLinks.unlink', 'Unlink {{label}}', { label })}
                    title={t('sessions.prLinks.unlinkTitle', 'Unlink from this session')}
                    onClick={() => void onUnlink(item.url)}
                  >
                    <Unlink aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {onLink ? (
        <>
          <form {...stylex.props(styles.form)} onSubmit={(event) => void submit(event)}>
            <div {...stylex.props(styles.field)}>
              <Input
                size="small"
                value={value}
                onChange={(event) => {
                  setValue(event.currentTarget.value);
                  setError(null);
                }}
                placeholder={t('sessions.prLinks.placeholder', 'Paste a pull request URL')}
                aria-label={t('sessions.prLinks.placeholder', 'Paste a pull request URL')}
                aria-invalid={error ? true : undefined}
              />
            </div>
            <Button type="submit" size="small" variant="secondary" disabled={busy || !value.trim()}>
              {t('sessions.prLinks.link', 'Link')}
            </Button>
          </form>
          {error ? (
            <div role="alert" {...stylex.props(styles.error)}>
              {errorText[error]}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The linked-PR list in a dialog, for the session menu when no PR is shown on the Info Bar. */
export function SessionPullRequestLinksDialog({
  open,
  onOpenChange,
  links,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  links: SessionPullRequestLinksProps;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content width={440} data-testid="session-pr-links-dialog">
        <Dialog.Header>
          <Dialog.Title>{t('sessions.prLinks.dialogTitle', 'Link pull request')}</Dialog.Title>
        </Dialog.Header>
        <SessionPullRequestLinksPanel
          {...links}
          onOpen={(item) => {
            onOpenChange(false);
            links.onOpen?.(item);
          }}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

import * as stylex from '@stylexjs/stylex';
import { CircleAlert, CircleDashed, Copy, Ellipsis, ExternalLink, Unlink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { planSessionPullRequestUnlink, type SessionPullRequestLinkListItem } from '@lody/shared';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Menu } from '@/ui/menu';
import { toast } from '@/lib/toast';
import { writeTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/native-browser';
import { SessionPrIcon } from '@/components/sidebar-row-shared';

type MetaWrite = (patch: Record<string, unknown>) => Promise<void>;

/** The user's own unlink record; the renderer never writes `pullRequests`. */
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
});

function itemLabel(item: SessionPullRequestLinkListItem): string {
  const repo = item.kind === 'associated' ? item.view.repoFullName : item.repoFullName;
  const number = item.kind === 'associated' ? item.view.number : item.number;
  return repo && number != null ? `${repo}#${number}` : item.url;
}

/**
 * Every pull request a Session holds, across repositories: the primary PR
 * first, then other associations, then links the machine has not confirmed
 * (with the reason). Each row's menu opens it on GitHub, copies its link, or
 * unlinks it from the Session.
 */
export type SessionPullRequestLinksProps = {
  items: readonly SessionPullRequestLinkListItem[];
  onOpen?: (item: SessionPullRequestLinkListItem) => void;
  onUnlink?: (url: string) => void | Promise<void>;
};

export function SessionPullRequestLinksPanel({
  items,
  onOpen,
  onUnlink,
}: SessionPullRequestLinksProps) {
  const { t } = useTranslation();
  const reasonText = {
    checking: t('sessions.prLinks.checking', 'Checking with GitHub…'),
    unreadable: t(
      'sessions.prLinks.unreadable',
      "GitHub did not return this pull request. It may not exist, or this machine's GitHub account cannot read it."
    ),
    unsupported: t('sessions.prLinks.unsupportedRecord', 'This provider is not supported yet.'),
  } as const;

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.header)}>
        <span {...stylex.props(styles.title)}>
          {t('sessions.prLinks.title', 'Linked pull requests')}
        </span>
        <span {...stylex.props(styles.count)}>{items.length}</span>
      </div>
      <ul {...stylex.props(styles.list)}>
        {items.map((item) => {
          const label = itemLabel(item);
          return (
            <li key={item.url} {...stylex.props(styles.row)}>
              <button
                type="button"
                title={item.url}
                onClick={() => onOpen?.(item)}
                {...stylex.props(styles.open)}
              >
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
              </button>
              <Menu.Root>
                <Menu.Trigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="mini"
                      icon
                      aria-label={`${t('sessions.moreActions', 'More actions')}: ${label}`}
                    />
                  }
                >
                  <Ellipsis aria-hidden="true" />
                </Menu.Trigger>
                <Menu.Content align="end">
                  <Menu.Item icon={ExternalLink} onClick={() => void openExternalUrl(item.url)}>
                    {t('sessions.prTab.openOnGitHub', 'Open on GitHub')}
                  </Menu.Item>
                  <Menu.Item
                    icon={Copy}
                    onClick={() => {
                      void writeTextToClipboard(item.url).then((copied) => {
                        if (copied) toast.success(t('today.linkCopied', 'Link copied'));
                      });
                    }}
                  >
                    {t('today.copyLink', 'Copy link')}
                  </Menu.Item>
                  {onUnlink ? (
                    <>
                      <Menu.Separator />
                      <Menu.Item icon={Unlink} onClick={() => void onUnlink(item.url)}>
                        {t('sessions.prLinks.unlink', 'Unlink')}
                      </Menu.Item>
                    </>
                  ) : null}
                </Menu.Content>
              </Menu.Root>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

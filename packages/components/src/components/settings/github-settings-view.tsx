import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { ArrowUpRight, Github, Lock, Search } from 'lucide-react';
import { Avatar } from '@lody/ui/avatar';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Spinner } from '@lody/ui/spinner';
import { Switch } from '@lody/ui/switch';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { isElectronRenderer } from '@/lib/electron';
import { openExternalUrl } from '@/lib/native-browser';
import { CompactRow, CompactSection } from './compact-layout';
import type { GitHubPersonalIdentitySettingsCardProps } from './integrations-setting';
import type { SettingsWorkspaceRepoWithStatus } from './settings-data-cache';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';
import { settingsType as type } from './type.stylex';

const INSTALLATIONS_URL = 'https://github.com/settings/installations';

/** Past this many repositories a person looks one up rather than scanning for it. */
const SEARCH_THRESHOLD = 5;

const styles = stylex.create({
  /** Private is a standing fact about every such row: a quiet glyph, not a pill per row. */
  private: { flexShrink: 0, width: '12px', height: '12px', color: colors.tertiaryLabel },
  /** Who Lody acts as, said in the helper line: the face and the handle. */
  identity: { display: 'inline-flex', alignItems: 'center', gap: space[1.5], minWidth: 0 },
  login: { color: colors.label },
  warning: { color: colors.warning },
  /** One repository: its name, whether it is private, and whether Lody may use it. */
  repo: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingInline: space[4],
    paddingBlock: '0.6em',
  },
  repoName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.label,
  },
  repoEnd: { display: 'flex', flexShrink: 0, alignItems: 'center', marginInlineStart: 'auto' },
  count: { fontVariantNumeric: 'tabular-nums' },
  footnote: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[1],
    margin: 0,
    paddingInline: space[4],
    fontSize: type.caption,
    lineHeight: 1.4,
    color: colors.secondaryLabel,
  },
});

export interface GitHubSettingsViewProps {
  canManage: boolean;
  /** The workspace session is ready for authenticated writes. */
  workspaceReady: boolean;
  connecting: boolean;
  onConnect: () => void;
  identity: GitHubPersonalIdentitySettingsCardProps;
  repos: SettingsWorkspaceRepoWithStatus[];
  reposLoading: boolean;
  onToggleRepo: (repoFullName: string, enabled: boolean) => void;
}

/**
 * Settings > GitHub on desktop. Three questions, each answered by the surface
 * that owns it: is the App installed and what can it reach (the App row states
 * it), who does Lody act as (the identity row names the account), and which
 * repositories may it use (one card per owner, each counting its own).
 */
export function GitHubSettingsView({
  canManage,
  workspaceReady,
  connecting,
  onConnect,
  identity,
  repos,
  reposLoading,
  onToggleRepo,
}: GitHubSettingsViewProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const enabledCount = useMemo(() => repos.filter((repo) => repo.enabled).length, [repos]);
  const owners = useMemo(() => groupByOwner(repos, query), [repos, query]);
  const canToggle = canManage && workspaceReady;

  const appSummary = reposLoading
    ? t('settings.integrations.github.loading')
    : repos.length === 0
      ? t('settings.integrations.github.appNotInstalled', 'Not installed')
      : t(
          'settings.integrations.github.appSummary',
          '{{enabled}} of {{total}} repositories enabled',
          {
            enabled: enabledCount,
            total: repos.length,
          }
        );

  return (
    <div {...stylex.props(surface.container)}>
      <CompactSection>
        <CompactRow
          label="GitHub App"
          helper={
            canManage
              ? appSummary
              : `${appSummary} · ${t('settings.integrations.github.adminOnlyHint')}`
          }
        >
          {canManage ? (
            <Button
              variant="secondary"
              size="small"
              onClick={onConnect}
              disabled={connecting || !workspaceReady}
            >
              {connecting ? <Spinner size="small" /> : null}
              {t('settings.integrations.github.connect')}
              {connecting ? null : <ArrowUpRight {...stylex.props(catalog.icon)} />}
            </Button>
          ) : null}
        </CompactRow>
        <IdentityRow {...identity} />
      </CompactSection>

      {reposLoading ? (
        <CompactSection title={t('settings.integrations.github.authorizedReposTitle')}>
          <p {...stylex.props(surface.cardNote)}>
            <Spinner size="small" /> {t('settings.integrations.github.loading')}
          </p>
        </CompactSection>
      ) : repos.length === 0 ? (
        <div {...stylex.props(catalog.empty)}>
          <Github {...stylex.props(catalog.emptyIcon)} aria-hidden="true" />
          <p {...stylex.props(catalog.emptyText)}>
            {t(
              'settings.integrations.github.noAuthorizedRepos',
              'No repositories authorized yet. Install the GitHub App to get started.'
            )}
          </p>
          {canManage ? (
            <Button onClick={onConnect} disabled={connecting || !workspaceReady}>
              {connecting ? <Spinner size="small" /> : null}
              {t('settings.integrations.github.install', 'Install GitHub App')}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {repos.length > SEARCH_THRESHOLD ? (
            <Input
              type="search"
              size="small"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('repos.search')}
              aria-label={t('repos.search')}
              leading={<Search {...stylex.props(catalog.icon)} aria-hidden="true" />}
            />
          ) : null}
          {owners.length === 0 ? (
            <CompactSection>
              <p {...stylex.props(surface.cardNote)}>{t('settings.integrations.github.noRepos')}</p>
            </CompactSection>
          ) : (
            owners.map((owner) => (
              <CompactSection
                key={owner.name}
                title={owner.name}
                headerRight={
                  <span {...stylex.props(styles.count)}>
                    {owner.enabled} / {owner.repos.length}
                  </span>
                }
              >
                {owner.repos.map((repo) => (
                  <div key={repo.repoFullName} {...stylex.props(styles.repo)}>
                    <span {...stylex.props(styles.repoName)} title={repo.repoFullName}>
                      {repoName(repo.repoFullName)}
                    </span>
                    {repo.private ? (
                      <Lock
                        {...stylex.props(styles.private)}
                        role="img"
                        aria-label={t('settings.integrations.github.private')}
                      >
                        <title>{t('settings.integrations.github.private')}</title>
                      </Lock>
                    ) : null}
                    <span {...stylex.props(styles.repoEnd)}>
                      <Switch
                        checked={repo.enabled}
                        onCheckedChange={(checked) => onToggleRepo(repo.repoFullName, checked)}
                        disabled={!canToggle}
                        aria-label={repo.repoFullName}
                      />
                    </span>
                  </div>
                ))}
              </CompactSection>
            ))
          )}
          <p {...stylex.props(styles.footnote)}>
            {t('settings.integrations.github.missingReposHint')}
            <Button
              variant="link"
              size="small"
              render={<a href={INSTALLATIONS_URL} target="_blank" rel="noreferrer" />}
              onClick={(event) => {
                if (isElectronRenderer()) {
                  event.preventDefault();
                  void openExternalUrl(INSTALLATIONS_URL);
                }
              }}
            >
              {t('settings.integrations.github.missingReposHintAction')}
              <ArrowUpRight {...stylex.props(catalog.iconSmall)} />
            </Button>
          </p>
        </>
      )}
    </div>
  );
}

/**
 * "Act as you". Switched on, the helper line stops describing the setting and
 * names the account instead — or says what is still missing before it can.
 */
function IdentityRow({
  enabled,
  authorizationState,
  githubAccountId,
  profile,
  settingsLoading = false,
  updating = false,
  authorizing = false,
  workspaceReady = true,
  canAuthorize = true,
  onToggle,
  onAuthorize,
}: GitHubPersonalIdentitySettingsCardProps) {
  const { t } = useTranslation();
  const authorized = authorizationState === 'authorized';
  const avatarUrl =
    profile?.avatarUrl ??
    (githubAccountId
      ? `https://avatars.githubusercontent.com/u/${githubAccountId}?v=4`
      : undefined);

  const helper = !enabled ? (
    t(
      'settings.integrations.github.personalIdentityDescription',
      'Act as you for PRs, comments, and merges.'
    )
  ) : authorized ? (
    <span {...stylex.props(styles.identity)}>
      <Avatar.Root size="mini">
        {avatarUrl ? <Avatar.Image src={avatarUrl} alt="" /> : null}
        <Avatar.Fallback>{(profile?.login ?? '?').slice(0, 1).toUpperCase()}</Avatar.Fallback>
      </Avatar.Root>
      <span>
        {profile?.login ? (
          <>
            {t('settings.integrations.github.personalIdentityActingAsPrefix', 'Acting as')}{' '}
            <span {...stylex.props(styles.login)}>@{profile.login}</span>
          </>
        ) : (
          t('settings.integrations.github.personalIdentityAuthorized', 'Connected')
        )}
      </span>
    </span>
  ) : (
    <span {...stylex.props(styles.warning)}>
      {t('settings.integrations.github.personalIdentityNeedsAuth', 'Authorization needed')} ·{' '}
      {t('settings.integrations.github.personalIdentityMissing', 'Authorize to act as you.')}
    </span>
  );

  return (
    <CompactRow
      label={t('settings.integrations.github.personalIdentityRowLabel', 'Act as you')}
      helper={helper}
    >
      {enabled && !authorized && canAuthorize ? (
        <Button
          variant="secondary"
          size="small"
          onClick={onAuthorize}
          disabled={!workspaceReady || authorizing}
        >
          {authorizing ? <Spinner size="small" /> : null}
          {t('settings.integrations.github.personalIdentityAuthorize', 'Authorize')}
        </Button>
      ) : null}
      {updating ? (
        <Spinner size="small" />
      ) : (
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          disabled={
            !workspaceReady || settingsLoading || (!canAuthorize && !authorized && !enabled)
          }
          aria-label={t('settings.integrations.github.personalIdentityRowLabel', 'Act as you')}
        />
      )}
    </CompactRow>
  );
}

function repoName(fullName: string): string {
  const slash = fullName.indexOf('/');
  return slash === -1 ? fullName : fullName.slice(slash + 1);
}

interface OwnerGroup {
  name: string;
  repos: SettingsWorkspaceRepoWithStatus[];
  enabled: number;
}

/** Repositories under the account or organisation that owns them, in the order they arrive. */
function groupByOwner(repos: SettingsWorkspaceRepoWithStatus[], query: string): OwnerGroup[] {
  const groups = new Map<string, OwnerGroup>();
  for (const repo of repos) {
    if (query && !repo.repoFullName.toLowerCase().includes(query)) continue;
    const slash = repo.repoFullName.indexOf('/');
    const name = slash === -1 ? repo.repoFullName : repo.repoFullName.slice(0, slash);
    let group = groups.get(name);
    if (!group) {
      group = { name, repos: [], enabled: 0 };
      groups.set(name, group);
    }
    group.repos.push(repo);
    if (repo.enabled) group.enabled += 1;
  }
  return [...groups.values()];
}

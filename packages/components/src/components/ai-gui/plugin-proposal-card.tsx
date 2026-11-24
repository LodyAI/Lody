import * as stylex from '@stylexjs/stylex';
import { space, radius } from '@lody/ui/tokens/scales.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { getServerNow } from '@lody/shared';

const styles = stylex.create({
  card: {
    display: 'grid',
    gap: space[2],
    padding: space[3],
    backgroundColor: colors.secondaryBackground,
    borderRadius: radius.large,
    minWidth: 0,
  },
  details: { display: 'grid', gap: space[2], margin: 0 },
  value: { margin: 0, overflowWrap: 'anywhere' },
  label: { color: colors.secondaryLabel },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
});
export type ReviewAction = 'install' | 'update' | 'enable' | 'reload';
export type ReviewState = 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded';
export interface PluginReview {
  version?: string;
  requestId: string;
  pluginId: string;
  workspaceId: string;
  sessionId: string;
  machineId: string;
  source: string;
  digest: string;
  action: ReviewAction;
  capabilities: readonly string[];
  added?: readonly string[];
  removed?: readonly string[];
  expiresAt: number;
  status: ReviewState;
}
export function PluginProposalCard(props: {
  review: PluginReview;
  decide?: (decision: 'approved' | 'rejected') => Promise<ReviewState>;
}) {
  return <Review key={JSON.stringify(props.review)} {...props} />;
}
function Review({
  review: r,
  decide,
}: {
  review: PluginReview;
  decide?: (decision: 'approved' | 'rejected') => Promise<ReviewState>;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState(r.status),
    [busy, setBusy] = useState(false),
    lock = useRef(false),
    [error, setError] = useState(false);
  useEffect(() => {
    if (state !== 'pending') return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const ms = r.expiresAt - getServerNow();
      if (ms <= 0) setState('expired');
      else timer = setTimeout(tick, Math.min(ms, 2147483647));
    };
    tick();
    return () => clearTimeout(timer);
  }, [r.expiresAt, state]);
  async function respond(choice: 'approved' | 'rejected') {
    if (!decide || lock.current || state !== 'pending') return;
    if (getServerNow() >= r.expiresAt) {
      setState('expired');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(false);
    try {
      setState(await decide(choice));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  return (
    <section {...stylex.props(styles.card)} aria-label={t('pluginProposal.review')}>
      <strong>{t(`pluginProposal.action.${r.action}`, { plugin: r.pluginId })}</strong>
      <dl {...stylex.props(styles.details)}>
        {Object.entries({
          source: r.source,
          ...(r.version ? { version: r.version } : {}),
          machine: r.machineId,
          digest: r.digest,
          request: r.requestId,
          expires: new Date(r.expiresAt).toISOString(),
          capabilities: r.capabilities.join(', ') || t('pluginProposal.none'),
          ...(r.added ? { added: r.added.join(', ') || t('pluginProposal.none') } : {}),
          ...(r.removed ? { removed: r.removed.join(', ') || t('pluginProposal.none') } : {}),
        }).map(([k, v]) => (
          <div key={k}>
            <dt {...stylex.props(styles.label)}>{t(`pluginProposal.${k}`)}</dt>
            <dd {...stylex.props(styles.value)} dir="auto">
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <p role="status">{t(`pluginProposal.status.${state}`)}</p>
      {error && <p role="alert">{t('pluginProposal.error')}</p>}
      {state === 'pending' &&
        (decide ? (
          <div {...stylex.props(styles.actions)}>
            <Button disabled={busy} onClick={() => void respond('approved')}>
              {t(`pluginProposal.approve.${r.action}`)}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void respond('rejected')}>
              {t('pluginProposal.reject')}
            </Button>
          </div>
        ) : (
          <p>{t('pluginProposal.owner')}</p>
        ))}
    </section>
  );
}

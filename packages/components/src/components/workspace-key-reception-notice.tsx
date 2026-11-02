import * as stylex from '@stylexjs/stylex';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

export type KeyReceptionWait = { workspaceId: string };
export type KeyReceptionNoticeClock = {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};
const systemClock: KeyReceptionNoticeClock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};
const styles = stylex.create({
  notice: { margin: 0, padding: space[3], color: colors.secondaryLabel, fontSize: '0.9em' },
});

/** A stable wait object denotes one failed-save episode. No I/O or admission here. */
export function WorkspaceKeyReceptionNotice({
  workspaceId,
  waiting,
  clock = systemClock,
}: {
  workspaceId: string | null | undefined;
  waiting: KeyReceptionWait | null;
  clock?: KeyReceptionNoticeClock;
}) {
  const { t } = useTranslation();
  const [visibleWait, setVisibleWait] = useState<KeyReceptionWait | null>(null);
  useEffect(() => {
    if (!waiting || waiting.workspaceId !== workspaceId) return undefined;
    const started = clock.now();
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining = 30_000 - (clock.now() - started);
      if (remaining > 0) timer = clock.setTimeout(check, remaining);
      else setVisibleWait(waiting);
    };
    timer = clock.setTimeout(check, 30_000);
    return () => clock.clearTimeout(timer);
  }, [clock, waiting, workspaceId]);
  return waiting && waiting === visibleWait && waiting.workspaceId === workspaceId ? (
    <p role="status" aria-live="polite" {...stylex.props(styles.notice)}>
      {t('e2ee.content.receivingNewKey')}
    </p>
  ) : null;
}

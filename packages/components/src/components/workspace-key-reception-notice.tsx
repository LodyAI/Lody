import * as stylex from '@stylexjs/stylex';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
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
  notice: { padding: space[3] },
  row: { display: 'flex', alignItems: 'center', gap: space[2] },
});

/** A stable wait object denotes one failed-save episode. No I/O or admission here. */
export function WorkspaceKeyReceptionNotice({
  workspaceId,
  waiting,
  clock = systemClock,
  onCheckAgain,
}: {
  workspaceId: string | null | undefined;
  waiting: KeyReceptionWait | null;
  clock?: KeyReceptionNoticeClock;
  onCheckAgain?: () => void;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState<{ wait: KeyReceptionWait; slow: boolean } | null>(null);
  useEffect(() => {
    if (!waiting || waiting.workspaceId !== workspaceId) return undefined;
    const started = clock.now();
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const elapsed = clock.now() - started;
      if (elapsed >= 5_000) setVisible({ wait: waiting, slow: elapsed >= 20_000 });
      if (elapsed < 20_000)
        timer = clock.setTimeout(check, (elapsed < 5_000 ? 5_000 : 20_000) - elapsed);
    };
    timer = clock.setTimeout(check, 5_000);
    return () => clock.clearTimeout(timer);
  }, [clock, waiting, workspaceId]);
  if (!waiting || visible?.wait !== waiting || waiting.workspaceId !== workspaceId) return null;
  return (
    <div {...stylex.props(styles.notice)}>
      <Alert.Root tone="neutral" role="note">
        <div {...stylex.props(styles.row)}>
          <Spinner size="small" role="presentation" aria-hidden="true" />
          <Alert.Description role="status">
            {t(visible.slow ? 'e2ee.content.receivingNewKeySlow' : 'e2ee.content.receivingNewKey')}
          </Alert.Description>
        </div>
        {visible.slow && onCheckAgain && (
          <Alert.Actions>
            <Button type="button" size="small" variant="secondary" onClick={onCheckAgain}>
              {t('e2ee.content.retryHostIdentity')}
            </Button>
          </Alert.Actions>
        )}
      </Alert.Root>
    </div>
  );
}

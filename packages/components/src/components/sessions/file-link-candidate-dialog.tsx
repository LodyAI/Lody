import { colors } from '@lody/ui/tokens/colors.stylex';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { Card } from '@lody/ui';
import { Dialog } from '@/ui/dialog';
import { Button } from '@lody/ui/button';
import type { FileLinkCandidate } from '@lody/shared';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

export function FileLinkCandidateDialog({
  candidates,
  onSelect,
  onClose,
}: {
  candidates: readonly FileLinkCandidate[];
  onSelect: (candidate: FileLinkCandidate) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>{t('sessions.fileLinks.chooseTitle', 'Choose a file')}</Dialog.Title>
          <Dialog.Description>
            {t(
              'sessions.fileLinks.chooseDescription',
              'This link matches files in more than one worktree. Choose the version to open.'
            )}
          </Dialog.Description>
        </Dialog.Header>
        <div {...stylex.props(styles.list)}>
          <Card.Root>
            {candidates.map((candidate) => (
              <div key={candidate.absolutePath} {...stylex.props(styles.row)}>
                <div {...stylex.props(styles.item)}>
                  <div {...stylex.props(styles.path)}>{candidate.absolutePath}</div>
                  <div {...stylex.props(styles.path)}>{candidate.worktreeRoot}</div>
                  <div>
                    {candidate.branch?.replace(/^refs\/heads\//, '') ??
                      t('sessions.fileLinks.detached', 'Detached HEAD')}{' '}
                    · {candidate.head?.slice(0, 12)}
                  </div>
                  <div>
                    {t('sessions.fileLinks.modified', 'Modified: {{time}}', {
                      time: new Date(candidate.mtimeMs).toLocaleString(locale),
                    })}
                  </div>
                  <Button variant="secondary" onClick={() => onSelect(candidate)}>
                    {t('sessions.fileLinks.open', 'Open this file')}
                  </Button>
                </div>
              </div>
            ))}
          </Card.Root>
        </div>
        <Dialog.Footer>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

const styles = stylex.create({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    maxHeight: '60vh',
    overflowY: 'auto',
  },
  row: {
    padding: space[4],
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  item: { display: 'flex', flexDirection: 'column', gap: space[2] },
  path: { overflowWrap: 'anywhere', fontFamily: 'monospace' },
});

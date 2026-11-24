import { useSetAtom } from 'jotai';
import { ChevronRight, Folders } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { projectEditorRequestAtom } from '@/atoms/project-editor';
import { MobileSettingsRow, MobileSettingsSection } from './mobile-settings-row';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeSpace } from '../../style/theme-scale.stylex';

const styles = stylex.create({
  label: { display: 'flex', minWidth: 0, alignItems: 'center', gap: themeSpace[3] },
  iconFrame: {
    display: 'flex',
    height: themeSpace[9],
    width: themeSpace[9],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--radius-xl)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--primary)) 10%, transparent)',
    color: themeColors.primary,
  },
  folderGlyph: { height: '1.05rem', width: '1.05rem' },
  copy: { minWidth: 0 },
  title: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.95rem',
    fontWeight: 'var(--font-weight-medium)',
    lineHeight: 'var(--leading-tight)',
    color: themeColors.foreground,
  },
  hint: {
    marginTop: themeSpace[0.5],
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.78rem',
    lineHeight: 'var(--leading-tight)',
    color: themeColors.mutedForeground,
  },
  trailingGlyph: { height: themeSpace[4], width: themeSpace[4] },
});

/**
 * The phone's "Edit project…": on a project's settings tab, the row that
 * opens the project editor seeded with this project, so more repositories or
 * folders can join it. Desktop offers the same action from the row's menu.
 */
export function MobileProjectEditSection({
  seedSourceKey,
  seedName,
}: {
  /** `local:<machine>:<id>` or `github:<owner/repo>`. */
  seedSourceKey: string;
  seedName: string;
}) {
  const { t } = useTranslation();
  const requestProjectEditor = useSetAtom(projectEditorRequestAtom);
  return (
    <MobileSettingsSection title={t('workspace.projects.title', 'Projects')}>
      <MobileSettingsRow
        label={
          <span {...stylex.props(styles.label)}>
            <span {...stylex.props(styles.iconFrame)}>
              <Folders {...stylex.props(styles.folderGlyph)} />
            </span>
            <span {...stylex.props(styles.copy)}>
              <span {...stylex.props(styles.title)}>
                {t('sidebar.localProjects.editProject', 'Edit project…')}
              </span>
              <span {...stylex.props(styles.hint)}>
                {t(
                  'workspace.projects.editProjectHint',
                  'Add more repositories or folders to work on together'
                )}
              </span>
            </span>
          </span>
        }
        onClick={() => requestProjectEditor({ kind: 'create', seedSourceKey, seedName })}
        trailing={<ChevronRight {...stylex.props(styles.trailingGlyph)} />}
      />
    </MobileSettingsSection>
  );
}

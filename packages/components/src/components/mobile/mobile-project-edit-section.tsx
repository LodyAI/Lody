import { useSetAtom } from 'jotai';
import { ChevronRight, Folders } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { projectEditorRequestAtom } from '@/atoms/project-editor';
import { MobileSettingsRow, MobileSettingsSection } from './mobile-settings-row';

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
          <span className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Folders className="h-[1.05rem] w-[1.05rem]" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[0.95rem] font-medium leading-tight text-foreground">
                {t('sidebar.localProjects.editProject', 'Edit project…')}
              </span>
              <span className="mt-0.5 block truncate text-[0.78rem] leading-tight text-muted-foreground">
                {t(
                  'workspace.projects.editProjectHint',
                  'Add more repositories or folders to work on together'
                )}
              </span>
            </span>
          </span>
        }
        onClick={() => requestProjectEditor({ kind: 'create', seedSourceKey, seedName })}
        trailing={<ChevronRight className="h-4 w-4" />}
      />
    </MobileSettingsSection>
  );
}

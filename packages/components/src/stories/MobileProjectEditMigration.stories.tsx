import type { Meta, StoryObj } from '@storybook/react';
import { useMemo } from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { createStore, Provider, useAtomValue, useSetAtom } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { MobileProjectEditSection } from '../components/mobile/mobile-project-edit-section';
import { projectEditorRequestAtom } from '../atoms/project-editor';
import { resources } from '../i18n';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100dvh',
    paddingBlock: themeSpace[4],
    color: themeColors.foreground,
    backgroundColor: themeColors.background,
  },
  frame: { maxWidth: 640, marginInline: 'auto' },
  result: { display: 'block', padding: themeSpace[4], overflowWrap: 'anywhere' },
  toolbar: { paddingInline: themeSpace[4] },
});

type FixtureMode = 'local' | 'github' | 'long';

function Result() {
  const request = useAtomValue(projectEditorRequestAtom);
  const setRequest = useSetAtom(projectEditorRequestAtom);
  return (
    <>
      <div {...stylex.props(styles.toolbar)}>
        <Button size="small" variant="secondary" onClick={() => setRequest(null)}>
          Reset request
        </Button>
      </div>
      <output {...stylex.props(styles.result)} data-editor-request-kind={request?.kind ?? 'none'}>
        {request ? JSON.stringify(request) : 'No editor request'}
      </output>
    </>
  );
}

function Fixture({ mode = 'local' }: { mode?: FixtureMode }) {
  const store = useMemo(() => createStore(), []);
  const locale = mode === 'github' ? 'zh_CN' : 'en';
  const language = useMemo(() => {
    const instance = createInstance();
    const translation =
      mode === 'long'
        ? {
            ...resources.en.translation,
            'sidebar.localProjects.editProject':
              'Edit this synthetic project with a deliberately very long project label…',
            'workspace.projects.editProjectHint':
              'Add more repositories or folders to work on together / 为此合成项目添加更多代码仓库与本地文件夹，并保留原有工作区',
          }
        : resources[locale].translation;
    void instance.init({
      lng: locale,
      fallbackLng: locale,
      initAsync: false,
      resources: { [locale]: { translation } },
      interpolation: { escapeValue: false },
    });
    return instance;
  }, [locale, mode]);
  return (
    <Provider store={store}>
      <I18nextProvider i18n={language}>
        <div {...stylex.props(styles.canvas)}>
          <div {...stylex.props(styles.frame)}>
            <div data-project-edit-section="">
              <MobileProjectEditSection
                seedSourceKey={
                  mode === 'github' ? 'github:synthetic/example' : 'local:synthetic:project'
                }
                seedName={mode === 'github' ? '合成仓库项目' : 'Synthetic project with 中文'}
              />
            </div>
            <Result />
          </div>
        </div>
      </I18nextProvider>
    </Provider>
  );
}

const meta = {
  title: 'Mobile/MobileProjectEditMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Local: Story = { render: () => <Fixture /> };
export const GitHub: Story = { render: () => <Fixture mode="github" /> };
export const LongTranslation: Story = { render: () => <Fixture mode="long" /> };

import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import { useEffect, useMemo, useState } from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { BubInstallGuide } from '../components/settings/bub-install-guide';
import { resources } from '../i18n';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100dvh',
    padding: themeSpace[4],
    color: themeColors.foreground,
    backgroundColor: themeColors.background,
  },
  frame: { maxWidth: 640, marginInline: 'auto' },
  result: { display: 'block', marginTop: themeSpace[6], overflowWrap: 'anywhere' },
});

type Mode = 'success' | 'failure' | 'long';

function Fixture({ mode = 'success' }: { mode?: Mode }) {
  const [ready, setReady] = useState(false);
  const [clipboard, setClipboard] = useState('');
  const [copyState, setCopyState] = useState('idle');
  const [external, setExternal] = useState('');
  const language = useMemo(() => {
    const instance = createInstance();
    void instance.init({
      lng: 'en',
      fallbackLng: 'en',
      initAsync: false,
      resources: {
        en: {
          translation: {
            ...resources.en.translation,
            ...(mode === 'long'
              ? {
                  'settings.agent.setup.bubInstallCommand':
                    'Install the synthetic agent in one step with this deliberately long translated instruction / 使用这一行命令安装合成测试代理：',
                  'settings.agent.dialog.bubInstallDocs':
                    'Open the complete synthetic installation guide / 打开完整的安装指南',
                  'common.copy': 'Copy command / 复制命令',
                  'common.copied': 'Command copied / 命令已复制',
                }
              : {}),
          },
        },
      },
      interpolation: { escapeValue: false },
    });
    return instance;
  }, [mode]);

  useEffect(() => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const commandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
    const originalOpen = window.open;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          setClipboard(text);
          if (mode === 'failure') {
            setCopyState('async-rejected');
            throw new Error('Synthetic clipboard permission denial');
          }
          setCopyState('success');
        },
      },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => {
        setCopyState('fallback-rejected');
        return false;
      },
    });
    window.open = (url) => {
      setExternal(String(url));
      return null;
    };
    setReady(true);
    return () => {
      if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
      if (commandDescriptor) Object.defineProperty(document, 'execCommand', commandDescriptor);
      else Reflect.deleteProperty(document, 'execCommand');
      window.open = originalOpen;
    };
  }, [mode]);

  return (
    <I18nextProvider i18n={language}>
      <div {...stylex.props(styles.canvas)}>
        <div {...stylex.props(styles.frame)}>
          <div data-bub-guide="" data-bub-ports-ready={ready ? 'true' : 'false'}>
            <BubInstallGuide />
          </div>
          <output
            {...stylex.props(styles.result)}
            data-bub-copy-state={copyState}
            data-bub-external={external ? 'requested' : 'none'}
          >
            {JSON.stringify({ copyState, clipboard, external })}
          </output>
        </div>
      </div>
    </I18nextProvider>
  );
}

const meta = {
  title: 'Settings/BubInstallGuideMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const CopySuccess: Story = { render: () => <Fixture /> };
export const CopyFailure: Story = { render: () => <Fixture mode="failure" /> };
export const LongTranslation: Story = { render: () => <Fixture mode="long" /> };

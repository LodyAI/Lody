import type { Meta, StoryObj } from '@storybook/react';
import { GeneralSettingsComponent } from '@/components/settings';
import { AutoLaunchSettingRows } from '@/components/settings/general-setting';
import { CompactSection } from '@/components/settings/compact-layout';
import { settingsFlat } from '@/components/settings/material.stylex';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Provider, createStore } from 'jotai';
import { useState } from 'react';
import { userAtom } from '@/atoms';
import { RoutedStory, SettingsStoryProviders } from './settings-story-shell';
const storyLayoutStyles = stylex.create({
  canvas: {
    'border-radius': 'var(--radius-lg)',
    'background-color': 'hsl(var(--secondary) / 1)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--secondary-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  navigation: {
    display: { default: 'none', '@media (min-width: 48rem)': 'block' },
    width: 'calc(var(--spacing) * 64)',
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    backgroundColor: 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 4)',
  },
  navigationList: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 1)',
    },
  },
  navigationItem: {
    borderRadius: 'var(--radius-lg)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    color: 'hsl(var(--muted-foreground) / 1)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    backgroundColor: {
      default: null,
      '@media (hover: hover)': {
        ':hover': 'color-mix(in oklab, hsl(var(--secondary) / 1) 50%, transparent)',
      },
    },
  },
  autoLaunch: {
    width: '640px',
    backgroundColor: 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 8)',
  },
  row: {
    display: 'flex',
    height: '100vh',
  },
  section: {
    flex: '1',
    overflow: 'auto',
  },
});

/**
 * GeneralSettings 组件的 Storybook 故事
 * 展示通用设置页面在不同设备和主题下的效果
 */
const meta = {
  title: 'Settings/GeneralSettings',
  component: GeneralSettingsComponent,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <SettingsStoryProviders>
        <RoutedStory>
          <Story />
        </RoutedStory>
      </SettingsStoryProviders>
    ),
  ],
} satisfies Meta<typeof GeneralSettingsComponent>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * 桌面端视图
 * 标准的桌面端布局，内边距较大
 */
export const Desktop: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'responsive',
    },
  },
};

export const PreferencesAccessibility: Story = {
  render: () => <PreferencesAccessibilityStory />,
};

function PreferencesAccessibilityStory() {
  const [store] = useState(() => {
    const next = createStore();
    next.set(userAtom, {
      id: 'preferences-story-user',
      name: 'Preferences Story',
      email: 'preferences@example.com',
      image: null,
    });
    return next;
  });
  return (
    <SettingsStoryProviders capabilities={['githubIntegration']}>
      <Provider store={store}>
        <GeneralSettingsComponent />
      </Provider>
    </SettingsStoryProviders>
  );
}

/**
 * 移动端视图
 * 带返回按钮的移动端布局，内边距较小
 */
export const Mobile: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
  decorators: [
    (Story) => {
      // 模拟移动端环境
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 375,
      });
      window.dispatchEvent(new Event('resize'));
      return <Story />;
    },
  ],
};

/**
 * 平板端视图
 * 介于移动端和桌面端之间的布局
 */
export const Tablet: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'tablet',
    },
  },
};

/**
 * 暗色主题桌面端
 * 在暗色主题下的桌面端显示效果
 */
export const DarkModeDesktop: Story = {
  parameters: {
    backgrounds: {
      default: 'dark',
    },
  },
  decorators: [
    (Story) => (
      <div className="dark">
        <Story />
      </div>
    ),
  ],
};

/**
 * 暗色主题移动端
 * 在暗色主题下的移动端显示效果
 */
export const DarkModeMobile: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
    backgrounds: {
      default: 'dark',
    },
  },
  decorators: [
    (Story) => {
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 375,
      });
      window.dispatchEvent(new Event('resize'));
      return (
        <div className="dark">
          <Story />
        </div>
      );
    },
  ],
};

/**
 * 完整布局测试
 * 在设置布局容器中显示
 */
export const InSettingsLayout: Story = {
  render: () => (
    <div {...stylex.props(storyLayout.row)}>
      {/* 模拟左侧导航栏 */}
      <div {...stylex.props(storyLayout.navigation)}>
        <div {...stylex.props(storyLayout.navigationList)}>
          <div {...stylex.props(storyLayoutStyles.canvas)}>General</div>
          <div {...stylex.props(storyLayout.navigationItem)}>Workspace</div>
          <div {...stylex.props(storyLayout.navigationItem)}>Agent Configurations</div>
          <div {...stylex.props(storyLayout.navigationItem)}>Integrations</div>
        </div>
      </div>

      {/* 主内容区域 */}
      <div {...stylex.props(storyLayout.section)}>
        <GeneralSettingsComponent />
      </div>
    </div>
  ),
  parameters: {
    layout: 'fullscreen',
  },
};

const autoLaunchState = {
  supported: true,
  enabled: false,
  hideWindowOnAutoLaunch: false,
  loading: false,
  enabledLoading: false,
  hideWindowLoading: false,
  updateEnabled: async () => {},
  updateHideWindow: async () => {},
};

/** The launch rows as the desktop pane draws them, flat inside its surface. */
function AutoLaunchStory({ state }: { state: Partial<typeof autoLaunchState> }) {
  const { t } = useTranslation();
  return (
    <div data-settings-surface="" {...stylex.props(settingsFlat, storyLayout.autoLaunch)}>
      <CompactSection title={t('settings.general.sections.thisComputer', 'This computer')}>
        <AutoLaunchSettingRows autoLaunch={{ ...autoLaunchState, ...state }} />
      </CompactSection>
    </div>
  );
}

/** Where the OS has no login item (Linux): both rows step back and say why. */
export const AutoLaunchUnsupported: Story = {
  render: () => <AutoLaunchStory state={{ supported: false }} />,
};

/** Launch at startup is off: hiding the window reads as depending on it. */
export const AutoLaunchOff: Story = {
  render: () => <AutoLaunchStory state={{}} />,
};

export const AutoLaunchOn: Story = {
  render: () => <AutoLaunchStory state={{ enabled: true, hideWindowOnAutoLaunch: true }} />,
};

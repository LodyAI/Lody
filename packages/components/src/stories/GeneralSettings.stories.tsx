import type { Meta, StoryObj } from '@storybook/react';
import { GeneralSettingsComponent } from '@/components/settings';
import { AutoLaunchSettingRows } from '@/components/settings/general-setting';
import { CompactSection } from '@/components/settings/compact-layout';
import { settingsFlat } from '@/components/settings/material.stylex';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { RoutedStory, SettingsStoryProviders } from './settings-story-shell';

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
    <div className="h-screen flex">
      {/* 模拟左侧导航栏 */}
      <div className="w-64 border-r bg-background p-4 hidden md:block">
        <div className="space-y-1">
          <div className="rounded-lg px-3 py-2 bg-secondary text-secondary-foreground text-sm font-medium">
            General
          </div>
          <div className="rounded-lg px-3 py-2 text-muted-foreground hover:bg-secondary/50 text-sm font-medium">
            Workspace
          </div>
          <div className="rounded-lg px-3 py-2 text-muted-foreground hover:bg-secondary/50 text-sm font-medium">
            Agent Configurations
          </div>
          <div className="rounded-lg px-3 py-2 text-muted-foreground hover:bg-secondary/50 text-sm font-medium">
            Integrations
          </div>
        </div>
      </div>

      {/* 主内容区域 */}
      <div className="flex-1 overflow-auto">
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
    <div
      data-settings-surface=""
      className={`${stylex.props(settingsFlat).className ?? ''} w-[640px] bg-background p-8`}
    >
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

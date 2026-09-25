import type { Meta, StoryObj } from '@storybook/react';
import { SettingsHeader } from '@/components/settings/settings-header';
import { Button } from '@lody/ui/button';
import { Save } from 'lucide-react';

/**
 * SettingsHeader 组件的 Storybook 故事
 * 展示设置页面专用的移动端 Header 组件
 */
const meta = {
  title: 'Settings/SettingsHeader',
  component: SettingsHeader,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  argTypes: {
    title: {
      description: '页面标题',
      control: 'text',
    },
    onBack: {
      description: '返回按钮点击回调',
    },
    actions: {
      description: '右侧操作按钮区域',
    },
  },
} satisfies Meta<typeof SettingsHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * 默认状态
 * 仅显示标题和返回按钮
 */
export const Default: Story = {
  args: {
    title: 'General Settings',
  },
};

/**
 * 带操作按钮
 * 在右侧显示自定义操作按钮
 */
export const WithActions: Story = {
  args: {
    title: 'Profile Settings',
    actions: (
      <Button variant="ghost" size="small">
        <Save className="h-4 w-4" />
      </Button>
    ),
  },
};

/**
 * 移动端视图
 * 在移动端尺寸下查看组件
 */
export const Mobile: Story = {
  args: {
    title: 'General Settings',
  },
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
};

/**
 * 长标题
 * 测试标题过长时的截断效果
 */
export const LongTitle: Story = {
  args: {
    title: 'This is a very long settings page title that should be truncated',
  },
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
};

/**
 * 中文标题
 * 测试中文环境下的显示效果
 */
export const ChineseTitle: Story = {
  args: {
    title: '通用设置',
  },
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
};

/**
 * 暗色主题
 * 在暗色主题下的显示效果
 */
export const DarkMode: Story = {
  args: {
    title: 'General Settings',
    actions: (
      <Button variant="ghost" size="small">
        <Save className="h-4 w-4" />
      </Button>
    ),
  },
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
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

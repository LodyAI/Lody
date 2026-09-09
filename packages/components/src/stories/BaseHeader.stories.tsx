import type { Meta, StoryObj } from '@storybook/react';
import { BaseHeader } from '@/components/page-headers/base-header';
import { Button } from '@lody/ui/button';
import { Plus, Filter, Search } from 'lucide-react';
import { Input } from '@/ui/input';

/**
 * BaseHeader 组件是所有页面 header 的基础组件
 * 提供响应式布局，移动端显示菜单触发按钮
 */
const meta = {
  title: 'Components/BaseHeader',
  component: BaseHeader,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  argTypes: {
    title: {
      description: '页面标题',
      control: 'text',
    },
    actions: {
      description: '操作按钮区域',
    },
    className: {
      description: '自定义样式类名',
      control: 'text',
    },
  },
} satisfies Meta<typeof BaseHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * 默认状态 - 桌面端视图
 * 不显示菜单按钮，标题和操作按钮正常排列
 */
export const Default: Story = {
  args: {
    title: 'Page Title',
    actions: (
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="small">
          <Filter className="mr-2 h-4 w-4" />
          Filter
        </Button>
        <Button size="small">
          <Plus className="mr-2 h-4 w-4" />
          New Item
        </Button>
      </div>
    ),
  },
};

/**
 * 移动端视图
 * 显示菜单触发按钮，标题防止换行
 */
export const Mobile: Story = {
  args: {
    title: 'A Very Long Page Title That Should Be Truncated',
    actions: (
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="small">
          <Filter className="h-4 w-4" />
        </Button>
        <Button size="small">
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    ),
  },
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
};

/**
 * 带搜索框的 Header
 * 模拟基础 Header 的布局
 */
export const WithSearch: Story = {
  args: {
    title: 'Sessions',
    actions: (
      <>
        <div className="relative hidden md:block">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search..." className="w-64 pl-9" />
        </div>
        <Button variant="secondary" size="small">
          <Filter className="mr-2 h-4 w-4" />
          <span className="hidden sm:inline">Filter</span>
        </Button>
        <Button size="small">
          <Plus className="mr-2 h-4 w-4" />
          <span className="hidden sm:inline">New Session</span>
          <span className="sm:hidden">New</span>
        </Button>
      </>
    ),
  },
};

/**
 * 简单 Header
 * 只有标题，没有操作按钮
 */
export const SimpleHeader: Story = {
  args: {
    title: 'Settings',
  },
};

/**
 * 平板视图
 * 根据断点可能显示或隐藏菜单按钮
 */
export const Tablet: Story = {
  args: {
    title: 'Projects',
    actions: (
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="small">
          <Filter className="mr-2 h-4 w-4" />
          <span className="hidden sm:inline">Filter</span>
        </Button>
        <Button size="small">
          <Plus className="mr-2 h-4 w-4" />
          <span className="hidden sm:inline">New Project</span>
          <span className="sm:hidden">New</span>
        </Button>
      </div>
    ),
  },
  parameters: {
    viewport: {
      defaultViewport: 'tablet',
    },
  },
};

/**
 * 暗色主题
 */
export const DarkMode: Story = {
  args: {
    title: 'Dark Mode Header',
    actions: (
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="small">
          <Filter className="mr-2 h-4 w-4" />
          Filter
        </Button>
        <Button size="small">
          <Plus className="mr-2 h-4 w-4" />
          New Item
        </Button>
      </div>
    ),
  },
  decorators: [
    (Story) => (
      <div className="dark">
        <Story />
      </div>
    ),
  ],
};

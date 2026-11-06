import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { BaseHeader } from '@/components/page-headers/base-header';
import { Button } from '@lody/ui/button';
import { Plus, Filter, Search } from 'lucide-react';
import { Input } from '@lody/ui/input';
const storyLayout = stylex.create({
  icon: {
    width: 'calc(var(--spacing) * 4)',
    height: 'calc(var(--spacing) * 4)',
  },
  leadingIcon: {
    marginRight: 'calc(var(--spacing) * 2)',
  },
  search: {
    position: 'relative',
    display: { default: 'none', '@media (min-width: 48rem)': 'block' },
  },
  searchIcon: {
    position: 'absolute',
    left: 'calc(var(--spacing) * 3)',
    top: '50%',
    translate: '0 -50%',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  searchInput: {
    width: 'calc(var(--spacing) * 64)',
    paddingLeft: 'calc(var(--spacing) * 9)',
  },
  fullActionLabel: {
    display: { default: 'none', '@media (min-width: 40rem)': 'inline' },
  },
  shortActionLabel: {
    display: { default: 'inline', '@media (min-width: 40rem)': 'none' },
  },
  row: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
});

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
      <div {...stylex.props(storyLayout.row)}>
        <Button variant="secondary" size="small">
          <Filter {...stylex.props(storyLayout.icon, storyLayout.leadingIcon)} />
          Filter
        </Button>
        <Button size="small">
          <Plus {...stylex.props(storyLayout.icon, storyLayout.leadingIcon)} />
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
      <div {...stylex.props(storyLayout.row)}>
        <Button variant="ghost" size="small">
          <Filter {...stylex.props(storyLayout.icon)} />
        </Button>
        <Button size="small">
          <Plus {...stylex.props(storyLayout.icon)} />
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
        <div {...stylex.props(storyLayout.search)}>
          <Search {...stylex.props(storyLayout.icon, storyLayout.searchIcon)} />
          <Input placeholder="Search..." xstyle={storyLayout.searchInput} />
        </div>
        <Button variant="secondary" size="small">
          <Filter {...stylex.props(storyLayout.icon, storyLayout.leadingIcon)} />
          <span {...stylex.props(storyLayout.fullActionLabel)}>Filter</span>
        </Button>
        <Button size="small">
          <Plus {...stylex.props(storyLayout.icon, storyLayout.leadingIcon)} />
          <span {...stylex.props(storyLayout.fullActionLabel)}>New Session</span>
          <span {...stylex.props(storyLayout.shortActionLabel)}>New</span>
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
      <div {...stylex.props(storyLayout.row)}>
        <Button variant="secondary" size="small">
          <Filter {...stylex.props(storyLayout.icon, storyLayout.leadingIcon)} />
          <span {...stylex.props(storyLayout.fullActionLabel)}>Filter</span>
        </Button>
        <Button size="small">
          <Plus {...stylex.props(storyLayout.icon, storyLayout.leadingIcon)} />
          <span {...stylex.props(storyLayout.fullActionLabel)}>New Project</span>
          <span {...stylex.props(storyLayout.shortActionLabel)}>New</span>
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
      <div {...stylex.props(storyLayout.row)}>
        <Button variant="secondary" size="small">
          <Filter {...stylex.props(storyLayout.icon, storyLayout.leadingIcon)} />
          Filter
        </Button>
        <Button size="small">
          <Plus {...stylex.props(storyLayout.icon, storyLayout.leadingIcon)} />
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

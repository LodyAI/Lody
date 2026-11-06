import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import {
  SettingsCategoryList,
  SettingsCategoryGrid,
} from '@/components/settings/settings-category-list';
import { RoutedStory, SettingsStoryProviders } from './settings-story-shell';
import { Provider, createStore } from 'jotai';
import { useState, type ReactNode } from 'react';
import { currentWorkspaceSlugAtom, userAtom } from '@/atoms';
function CategoryStoryContext({ children }: { children: ReactNode }) {
  const [store] = useState(() => {
    const next = createStore();
    next.set(currentWorkspaceSlugAtom, 'lody');
    next.set(userAtom, {
      id: 'settings-story-user',
      name: 'Synthetic Settings User',
      email: 'settings@example.invalid',
    });
    return next;
  });
  return (
    <Provider store={store}>
      <SettingsStoryProviders>
        <RoutedStory>{children}</RoutedStory>
      </SettingsStoryProviders>
    </Provider>
  );
}

const responsiveStyles = stylex.create({
  firstExample: {
    marginBlockStart: 'calc(var(--spacing) * 0)',
    marginBlockEnd: 'calc(var(--spacing) * 8)',
  },
  frame: {
    borderStyle: 'solid',
    borderWidth: '1px',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
  },
});
const storyLayout = stylex.create({
  caption: {
    marginBottom: 'calc(var(--spacing) * 4)',
    fontSize: 'var(--text-lg)',
    lineHeight: 'var(--text-lg--line-height)',
    fontWeight: 'var(--font-weight-semibold)',
  },
});

/**
 * SettingsCategoryList 组件的 Storybook 故事
 * 展示设置分类列表组件，用于移动端首页导航
 */
const meta = {
  title: 'Settings/SettingsCategoryList',
  component: SettingsCategoryList,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <CategoryStoryContext>
        <Story />
      </CategoryStoryContext>
    ),
  ],
} satisfies Meta<typeof SettingsCategoryList>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * 移动端列表视图
 * 默认的移动端垂直列表布局
 */
export const Mobile: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
};

/**
 * 平板端视图
 * 在平板尺寸下的显示效果
 */
export const Tablet: Story = {
  parameters: {
    viewport: {
      defaultViewport: 'tablet',
    },
  },
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
    (Story) => (
      <div className="dark">
        <Story />
      </div>
    ),
  ],
};

/**
 * 网格布局组件的 Storybook 故事
 * 展示桌面端网格布局版本
 */
const gridMeta = {
  title: 'Settings/SettingsCategoryGrid',
  component: SettingsCategoryGrid,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <CategoryStoryContext>
        <Story />
      </CategoryStoryContext>
    ),
  ],
} satisfies Meta<typeof SettingsCategoryGrid>;

export const GridLayout: StoryObj<typeof gridMeta> = {
  render: () => <SettingsCategoryGrid />,
};

/**
 * 桌面端网格布局
 * 2列网格布局，适合较大屏幕
 */
export const DesktopGrid: StoryObj<typeof gridMeta> = {
  render: () => <SettingsCategoryGrid />,
  parameters: {
    viewport: {
      defaultViewport: 'responsive',
    },
  },
};

/**
 * 暗色主题网格布局
 * 在暗色主题下的网格布局效果
 */
export const DarkModeGrid: StoryObj<typeof gridMeta> = {
  render: () => <SettingsCategoryGrid />,
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
 * 响应式布局测试
 * 展示从移动端到桌面端的响应式变化
 */
export const ResponsiveTest: Story = {
  render: () => (
    <div>
      <div {...stylex.props(responsiveStyles.firstExample)}>
        <h3 {...stylex.props(storyLayout.caption)}>Mobile Layout (List)</h3>
        <div {...stylex.props(responsiveStyles.frame)} style={{ width: '375px' }}>
          <SettingsCategoryList />
        </div>
      </div>

      <div>
        <h3 {...stylex.props(storyLayout.caption)}>Desktop Layout (Grid)</h3>
        <div {...stylex.props(responsiveStyles.frame)} style={{ width: '800px' }}>
          <SettingsCategoryGrid />
        </div>
      </div>
    </div>
  ),
  parameters: {
    layout: 'padded',
  },
};

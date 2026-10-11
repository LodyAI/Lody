import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider, useAtomValue } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Field } from '@lody/ui/field';
import { Input } from '@lody/ui/input';
import { Menu } from '@lody/ui/menu';
import { Popover } from '@lody/ui/popover';
import { Tooltip } from '@lody/ui/tooltip';
import { conversationFontSizeAtom } from '@/atoms/settings';
import { InterfaceFontController } from '@/components/interface-font-controller';
import { AppearanceSettingsComponent } from '@/components/settings/appearance-setting';
import { SessionList, type SessionListRow } from '@/components/session-list';
import { LoroSidebar } from '@/components/loro-sidebar';
import { ChatComposer } from '@/components/chat/chat-composer';
import { OptionSelector } from '@/components/shared/option-selector';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { TerminalComponent } from '@/components/ai-gui/terminal-component';
import { ToolDetailSheet, ToolOutputSection } from '@/components/ai-gui/tool-call-detail';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { LocalTerminalPanel } from '@/components/terminal/local-terminal-panel';
import type { TerminalChannel, TerminalDataEvent } from '@/components/terminal/terminal-channel';

const platform = createLocalPlatformProvider({
  session: createStaticStore({ status: 'unauthenticated' }),
  workspaces: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
});
const listeners = new Set<(event: TerminalDataEvent) => void>();
const channel: TerminalChannel = {
  list: async () => [],
  open: async () => ({ terminalId: 'typography', cwd: '/synthetic' }),
  attach: () =>
    queueMicrotask(() => {
      for (const listener of listeners)
        listener({ type: 'data', terminalId: 'typography', data: '中文 English gypq\r\n$ ' });
    }),
  input: (_id, data) => {
    for (const listener of listeners) listener({ type: 'data', terminalId: 'typography', data });
  },
  resize: () => {},
  close: () => {},
  closeSession: () => {},
  readClipboardText: () => '',
  writeClipboardText: () => {},
  onData: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  onExit: () => () => {},
  onTitle: () => () => {},
};

const styles = stylex.create({
  frame: { display: 'flex', minHeight: '100vh' },
  sidebar: { width: '230px', flexShrink: 0, padding: '12px' },
  navigationSidebar: { height: '100vh' },
  main: {
    flex: 1,
    minWidth: 0,
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  terminal: { height: '100px' },
});

const rows: SessionListRow[] = [
  '统一字号 Typography',
  '中英混排 Long conversation title 超长会话标题',
].map((title, index) => ({
  sessionId: `typography-${index}`,
  title,
  repoFullName: null,
  branchName: '',
  latestMessageAt: Date.UTC(2026, 9, 3),
  addedLines: 0,
  deletedLines: 0,
  isWorking: false,
  hasUnreadMessages: false,
  isOffline: false,
  isWaitingPermission: false,
}));
const markdown =
  '# 标题 Heading\n\n正文 Mixed English 与中文，gypq descenders。' +
  ' Long text 自动换行、保持行距。'.repeat(12) +
  '\n\n| Role 角色 | Value 值 |\n| --- | --- |\n| Body 正文 | 文字保持层级 |\n\n' +
  '```typescript\nconst label = "中文 English gypq";\nconsole.log(label);\n```';

type SurfaceOptions = { navigation?: boolean; previewSize?: number };

function Surfaces({ navigation = false, previewSize }: SurfaceOptions) {
  const size = useAtomValue(conversationFontSizeAtom);
  const [prompt, setPrompt] = useState(
    '输入 Mixed English 中文，gypq\nLong text 自动换行 '.repeat(3)
  );
  const [model, setModel] = useState('codex');
  return (
    <>
      <InterfaceFontController enabled={false} />
      <div {...stylex.props(styles.frame)}>
        <aside
          data-testid="typography-sidebar"
          {...stylex.props(styles.sidebar, navigation && styles.navigationSidebar)}
        >
          {navigation ? (
            <LoroSidebar
              workspaceName="Local 本地"
              userEmail=""
              workspaces={[]}
              currentWorkspaceId="typography"
              workspaceSwitcherEnabled={false}
              defaultWidth={206}
              minWidth={206}
              maxWidth={206}
              sessionListProps={{ sessions: rows, repos: [] }}
              labels={{ home: 'New chat 新会话', schedules: 'Schedules 计划' }}
              onHomeClicked={() => {}}
              onSchedulesClicked={() => {}}
            />
          ) : (
            <SessionList sessions={rows} repos={[]} />
          )}
        </aside>
        <main {...stylex.props(styles.main)}>
          <div {...stylex.props(styles.actions)}>
            <Dialog.Root>
              <Dialog.Trigger render={<Button />}>Appearance 设置</Dialog.Trigger>
              <Dialog.Content>
                <Dialog.Title>Appearance 设置</Dialog.Title>
                <AppearanceSettingsComponent />
              </Dialog.Content>
            </Dialog.Root>
            <Menu.Root>
              <Menu.Trigger render={<Button />}>Menu 菜单</Menu.Trigger>
              <Menu.Content>
                <Menu.Item>Copy 复制 gypq</Menu.Item>
                <Menu.Item>Long command 很长的菜单命令</Menu.Item>
              </Menu.Content>
            </Menu.Root>
            <Popover.Root>
              <Popover.Trigger render={<Button />}>Popover 弹层</Popover.Trigger>
              <Popover.Content>
                <Popover.Header>
                  <Popover.Title>标题 Mixed English</Popover.Title>
                  <Popover.Description>说明 中文 gypq</Popover.Description>
                </Popover.Header>
                <p>正文 Mixed English 中文 gypq</p>
              </Popover.Content>
            </Popover.Root>
            <Tooltip.Root>
              <Tooltip.Trigger render={<Button aria-label="Typography hint" />}>
                Tooltip 提示
              </Tooltip.Trigger>
              <Tooltip.Content data-testid="typography-tooltip">
                说明 Mixed English 中文 gypq
              </Tooltip.Content>
            </Tooltip.Root>
          </div>
          <div data-testid="typography-message">
            <MarkdownRenderer text={markdown} size={previewSize ?? size} />
          </div>
          <div data-testid="typography-compact">
            <MarkdownRenderer
              compact
              size={size}
              text={'工具说明 Tool prose\n\n```sh\nprintf "中英 gypq"\n```'}
            />
          </div>
          <div data-testid="typography-tool">
            <ToolDetailSheet>
              <ToolOutputSection
                output={'工具输出 gypq\nBuild completed 构建完成\n' + 'long/path/'.repeat(20)}
                limited={false}
                exitCode={0}
                fontSize={size}
              />
            </ToolDetailSheet>
          </div>
          <div data-testid="typography-terminal">
            <TerminalComponent
              title="Terminal 终端"
              command="printf '中文 English gypq'"
              output="中文 English gypq\nProcess finished 已完成"
              fontSize={size}
            />
          </div>
          <div data-testid="typography-xterm" {...stylex.props(styles.terminal)}>
            <LocalTerminalPanel channel={channel} terminalId="typography" />
          </div>
          <Field.Root>
            <Field.Label>Form 表单</Field.Label>
            <Input placeholder="请输入 Mixed English" />
            <Field.Description data-testid="typography-description">
              说明 Mixed English 中文 gypq
            </Field.Description>
          </Field.Root>
          <div data-testid="typography-composer">
            <ChatComposer
              variant="session"
              promptValue={prompt}
              onPromptChange={setPrompt}
              primaryAction={<Button>Send 发送</Button>}
              footerSelector={
                <OptionSelector
                  appearance="toolbar"
                  value={model}
                  searchable
                  searchPlaceholder="Search 搜索"
                  onSelect={(option) => setModel(option.value)}
                  options={[
                    { value: 'codex', label: 'Codex Agent', description: '6.1 Sol / High' },
                    {
                      value: 'other',
                      label: 'Other 其他选项',
                      description: 'Long description 中英混排选项说明',
                    },
                  ]}
                />
              }
            />
          </div>
        </main>
      </div>
    </>
  );
}

function StoryShell(options: SurfaceOptions) {
  const store = useMemo(() => createStore(), []);
  return (
    <PlatformContext.Provider value={platform}>
      <Provider store={store}>
        <Surfaces {...options} />
      </Provider>
    </PlatformContext.Provider>
  );
}

const meta = {
  title: 'Settings/InterfaceTypography',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof StoryShell>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unified: Story = {};
export const Navigation: Story = { args: { navigation: true } };
export const ExplicitPreview: Story = { args: { previewSize: 12 } };

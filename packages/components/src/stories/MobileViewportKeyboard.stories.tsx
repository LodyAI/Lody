import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Provider, createStore } from 'jotai';
import { Monitor } from 'lucide-react';
import { fn } from 'storybook/test';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type {
  AgentConfigId,
  MachineId,
  MachineViewMeta,
  SessionId,
  SessionMeta,
  WorkspaceId,
} from '@lody/shared';

import { currentWorkspaceIdAtom } from '@/atoms';
import { machineMetaCacheAtom } from '@/atoms/doc-meta';
import { authTokenAtom } from '@/atoms/runtime';
import { SessionChatInputArea } from '@/components/sessions/session-chat-input-area';
import {
  getMobileMainLayoutRootClassName,
  getMobileMainLayoutContentClassName,
} from '@/components/main-layout';
import { getWebWorkspaceLayoutRootClassName } from '@/components/workspace-layout-utils';
import { ChatLandingView } from '@/components/chat/chat-landing-view';
import { ContextSwitch } from '@/components/chat/context-switch';
import type { SessionContextType } from '@/components/chat/context-switch';
import { OptionSelector } from '@/components/shared/option-selector';
import type { OptionSelectorOption } from '@/components/shared/option-selector';
const keyboardStory = stylex.create({
  messages: {
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 3)',
    },
  },
  options: {
    display: 'flex',
    minWidth: 0,
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
  },
  optionMenu: { width: 'calc(var(--spacing) * 56)' },
  device: {
    position: 'relative',
    marginInline: 'auto',
    overflow: 'hidden',
    borderRadius: '2rem',
    borderWidth:"2px",borderStyle:"solid",borderColor:"var(--color-zinc-600)",
    backgroundColor: 'var(--color-black)',
  },
  keyboard: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'var(--color-zinc-800)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'var(--color-zinc-500)',
  },
});
const storyLayout = stylex.create({
  canvas: {
    'border-radius': 'var(--radius-lg)',
    'background-color': 'color-mix(in oklab, hsl(var(--muted) / 1) 40%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  canvas2: {
    'border-radius': 'var(--radius-lg)',
    'background-color': 'color-mix(in oklab, hsl(var(--primary)) 10%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  caption: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
  },
  row: {
    display: 'flex',
    height: 'calc(var(--spacing) * 12)',
    'flex-shrink': '0',
    'align-items': 'center',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'hsl(var(--border) / 1)',
    'padding-inline': 'calc(var(--spacing) * 3)',
  },
  label: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
  },
  frame: {
    position: 'relative',
    'min-height': 'calc(var(--spacing) * 0)',
    flex: '1',
  },
  frame2: {
    height: '100%',
    'overflow-y': 'auto',
    padding: 'calc(var(--spacing) * 3)',
  },
  caption2: {
    overflow: 'hidden',
    'background-color': 'hsl(var(--background) / 1)',
    color: 'hsl(var(--foreground) / 1)',
  },
  section: {
    'text-align': 'center',
  },
  caption3: {
    'margin-bottom': 'calc(var(--spacing) * 1)',
    color: 'var(--color-zinc-400)',
  },
});

// ─── Shared constants & helpers ─────────────────────────────────────────────

const selectorStyles = stylex.create({
  tag: {
    width: 'auto',
    height: 'calc(var(--spacing) * 6)',
    paddingInline: 'calc(var(--spacing) * 2)',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: 4,
    color: {
      default: 'hsl(var(--muted-foreground) / 1)',
      '@media (hover: hover)': { default: null, ':hover': 'hsl(var(--foreground) / 1)' },
    },
    backgroundColor: {
      default: colors.wellBackground,
      '@media (hover: hover)': {
        default: null,
        ':hover': 'color-mix(in oklab, hsl(var(--muted) / 1) 60%, transparent)',
      },
    },
  },
  tagText: { fontSize: '0.9em', lineHeight: 1.25 },
  machineValue: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  machineGlyph: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    opacity: 0.7,
  },
  machineLabel: {
    fontSize: '0.9em',
    lineHeight: 1.25,
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

const STORY_WORKSPACE_ID = 'workspace-storybook' as WorkspaceId;
const STORY_MACHINE_ID = 'machine-storybook' as MachineId;
const STORY_AGENT_CONFIG_ID = 'agent-storybook' as AgentConfigId;
const STORY_SESSION_ID = 'session-storybook' as SessionId;
const STORY_AUTH_TOKEN = 'storybook-token';

const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: 'local:layout-story-user', name: 'Layout story user' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [
      { id: STORY_WORKSPACE_ID, name: 'Layout Story Workspace', slug: 'storybook', role: 'owner' },
    ],
    activeWorkspaceId: STORY_WORKSPACE_ID,
  }),
});

const DEVICE_WIDTH = 390;
const DEVICE_HEIGHT = 844;
const KEYBOARD_HEIGHT = 300;
const KEYBOARD_ANIM_MS = 280;

const storyMachineViewMeta: MachineViewMeta = {
  id: STORY_MACHINE_ID,
  name: 'MacBook Pro',
  os: 'macOS',
  cliVersion: '1.0.0',
  sessions: [STORY_SESSION_ID],
  raceLimits: {},
};

function createStoryStore() {
  const store = createStore();
  store.set(currentWorkspaceIdAtom, STORY_WORKSPACE_ID);
  store.set(authTokenAtom, STORY_AUTH_TOKEN);
  store.set(machineMetaCacheAtom, {
    [STORY_MACHINE_ID]: storyMachineViewMeta,
  });
  return store;
}

const storySession: SessionMeta = {
  id: STORY_SESSION_ID,
  machineId: STORY_MACHINE_ID,
  createdAt: '2026-04-10T00:00:00.000Z',
  title: 'Fix viewport handling',
  userId: 'user-storybook',
  status: { type: 'idle' },
  cliType: 'builtin',
  agentType: 'codex',
  agentConfigId: STORY_AGENT_CONFIG_ID,
  repoFullName: 'loro-dev/lody',
  project: {
    kind: 'github',
    repoFullName: 'loro-dev/lody',
    branch: 'fix/mobile-viewport',
  },
  baseBranch: 'main',
};

const machineOptions: OptionSelectorOption<string>[] = [
  { value: 'machine-1', label: 'MacBook Pro' },
];

/** Mock message bubbles for the session chat. */
function MockMessages() {
  return (
    <div {...stylex.props(keyboardStory.messages)}>
      <div {...stylex.props(storyLayout.canvas)}>
        Can you fix the mobile viewport issue where the keyboard covers the input?
      </div>
      <div {...stylex.props(storyLayout.canvas2)}>
        I&apos;ll use{' '}
        <code {...stylex.props(storyLayout.caption)}>interactive-widget=resizes-content</code> with{' '}
        <code {...stylex.props(storyLayout.caption)}>h-dvh</code> so the layout viewport shrinks
        when the keyboard opens.
      </div>
      <div {...stylex.props(storyLayout.canvas)}>Sounds good, let me test it on my iPhone.</div>
      <div {...stylex.props(storyLayout.canvas2)}>
        The key difference from the reverted PR is keeping overflow-hidden. The layout stays
        constrained — only the height changes dynamically.
      </div>
      <div {...stylex.props(storyLayout.canvas)}>
        What about the scroll position after the keyboard dismisses?
      </div>
      <div {...stylex.props(storyLayout.canvas2)}>
        With resizes-content the browser handles that natively. No phantom scroll to fix.
      </div>
    </div>
  );
}

/** Session chat layout content (shared between desktop preview & fullscreen). */
function SessionChatContent() {
  const store = useMemo(() => createStoryStore(), []);

  return (
    <Provider store={store}>
      <div className={getMobileMainLayoutRootClassName()}>
        <div className={getMobileMainLayoutContentClassName()}>
          {/* Header */}
          <div {...stylex.props(storyLayout.row)}>
            <span {...stylex.props(storyLayout.label)}>Fix viewport handling</span>
          </div>
          {/* Message area — matches SessionChatInterface: flex-1 min-h-0 */}
          <div {...stylex.props(storyLayout.frame)}>
            <div {...stylex.props(storyLayout.frame2)}>
              <MockMessages />
            </div>
          </div>
          {/* Input area — real production component */}
          <SessionChatInputArea
            session={storySession}
            sessionLocalProjectRootPath={null}
            isMachineRemoved={false}
            isAgentBusy={false}
            isDark
            isEmptyConversation={false}
            selectedModeId={null}
            selectedModelId={null}
            modeOptions={[]}
            modelOptions={[]}
            availableCommands={[]}
            onModeChange={() => {}}
            onModelChange={() => {}}
            onSendMessage={async () => true}
            onStop={() => {}}
            onRemoveQueueItem={async () => {}}
            disableImageUpload
          />
        </div>
      </div>
    </Provider>
  );
}

/** Chat landing content (shared between desktop preview & fullscreen). */
type WorkspaceRootFamily = 'mobile' | 'web' | 'settings';

function ChatLandingContent({ rootFamily = 'mobile' }: { rootFamily?: WorkspaceRootFamily }) {
  const handleSubmit = fn();
  const handleOpenMobileDrawer = fn();
  const [prompt, setPrompt] = useState('');
  const [selectedMachine, setSelectedMachine] = useState<string | null>('machine-1');
  const [contextType, setContextType] = useState<SessionContextType>('local');

  const bottomBarNode = (
    <div {...stylex.props(keyboardStory.options)}>
      <OptionSelector
        value={selectedMachine}
        options={machineOptions}
        onSelect={(option) => setSelectedMachine(option.value)}
        placeholder="Machine"
        placeholderIcon={Monitor}
        tone="dark"
        xstyle={selectorStyles.tag}
        valueXstyle={selectorStyles.tagText}
        labelXstyle={selectorStyles.tagText}
        contentXstyle={keyboardStory.optionMenu}
        renderTriggerValue={(option) => (
          <div {...stylex.props(selectorStyles.machineValue)}>
            <Monitor {...stylex.props(selectorStyles.machineGlyph)} />
            <span {...stylex.props(selectorStyles.machineLabel)}>{option?.label ?? 'Machine'}</span>
          </div>
        )}
      />
    </div>
  );

  return (
    <div
      data-owned-workspace-root={rootFamily}
      className={
        rootFamily === 'mobile'
          ? getMobileMainLayoutRootClassName()
          : getWebWorkspaceLayoutRootClassName({ settingsRoute: rootFamily === 'settings' })
      }
    >
      <div data-owned-workspace-content="" className={getMobileMainLayoutContentClassName()}>
        <ChatLandingView
          tone="dark"
          isMobile
          title="Let's ship something"
          promptValue={prompt}
          onPromptChange={setPrompt}
          promptPlaceholder="Press '/' for commands, '@' for mentions."
          contextSwitch={
            <ContextSwitch value={contextType} onChange={setContextType} tone="dark" />
          }
          bottomBar={bottomBarNode}
          onSubmit={handleSubmit}
          onOpenMobileDrawer={handleOpenMobileDrawer}
          hintType={null}
        />
      </div>
    </div>
  );
}

// ─── Desktop preview shell (simulated keyboard) ────────────────────────────

/**
 * For desktop browsers: wraps content in a phone-shaped frame and simulates
 * keyboard open/close on focus/blur.
 */
function DesktopPreviewShell({ children }: { children: React.ReactNode }) {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return undefined;

    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
        setKeyboardOpen(true);
      }
    };

    const handleFocusOut = (_e: FocusEvent) => {
      requestAnimationFrame(() => {
        if (!shell.contains(document.activeElement)) {
          setKeyboardOpen(false);
        }
      });
    };

    shell.addEventListener('focusin', handleFocusIn);
    shell.addEventListener('focusout', handleFocusOut);
    return () => {
      shell.removeEventListener('focusin', handleFocusIn);
      shell.removeEventListener('focusout', handleFocusOut);
    };
  }, []);

  const viewportHeight = keyboardOpen ? DEVICE_HEIGHT - KEYBOARD_HEIGHT : DEVICE_HEIGHT;

  return (
    <div
      ref={shellRef}
      {...stylex.props(keyboardStory.device)}
      style={{ width: DEVICE_WIDTH + 4, height: DEVICE_HEIGHT + 4 }}
    >
      <div
        {...stylex.props(storyLayout.caption2)}
        style={{
          width: DEVICE_WIDTH,
          height: viewportHeight,
          margin: 2,
          transition: `height ${KEYBOARD_ANIM_MS}ms cubic-bezier(0.2, 0.9, 0.4, 1)`,
        }}
      >
        {children}
      </div>
      <div
        {...stylex.props(keyboardStory.keyboard)}
        style={{
          height: KEYBOARD_HEIGHT,
          transform: keyboardOpen ? 'translateY(0)' : `translateY(${KEYBOARD_HEIGHT}px)`,
          transition: `transform ${KEYBOARD_ANIM_MS}ms cubic-bezier(0.2, 0.9, 0.4, 1)`,
        }}
      >
        <div {...stylex.props(storyLayout.section)}>
          <div {...stylex.props(storyLayout.caption3)}>Simulated Keyboard</div>
          <div>Click a text input to open / click outside to close</div>
        </div>
      </div>
    </div>
  );
}

// ─── Story config ───────────────────────────────────────────────────────────

const meta = {
  title: 'Mobile/ViewportKeyboard',
  decorators: [
    (Story) => (
      <PlatformContext value={storyPlatform}>
        <Story />
      </PlatformContext>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **Desktop preview** — session chat in a phone-shaped frame with simulated
 * keyboard. Click the textarea to see the layout shrink.
 */
export const SessionChatPreview: Story = {
  parameters: { layout: 'centered' },
  render: () => (
    <DesktopPreviewShell>
      <SessionChatContent />
    </DesktopPreviewShell>
  ),
  globals: { theme: 'dark' },
};

/**
 * **Desktop preview** — chat landing in a phone-shaped frame with simulated
 * keyboard. Click the composer to see the layout shrink.
 */
export const ChatLandingPreview: Story = {
  parameters: { layout: 'centered' },
  render: () => (
    <DesktopPreviewShell>
      <ChatLandingContent />
    </DesktopPreviewShell>
  ),
  globals: { theme: 'dark' },
};

/**
 * **Real device test** — session chat rendered fullscreen using actual `h-dvh`.
 * Open this story on a real phone to test with the real virtual keyboard.
 *
 * The viewport meta tag (`interactive-widget=resizes-content`) is injected via
 * `.storybook/preview-head.html`, so the browser will resize the layout
 * viewport when the keyboard opens — exactly matching production behavior.
 */
export const SessionChatDevice: Story = {
  parameters: { layout: 'fullscreen' },
  render: () => <SessionChatContent />,
  globals: { theme: 'dark' },
};

/**
 * **Real device test** — chat landing rendered fullscreen using actual `h-dvh`.
 * Open this story on a real phone to test with the real virtual keyboard.
 */
export const ChatLandingDevice: Story = {
  parameters: { layout: 'fullscreen' },
  render: () => <ChatLandingContent />,
  globals: { theme: 'dark' },
};

/** Fixed CSS-variable inputs exercise the exported layout helpers with real landing controls. */
function OwnedRootProbe({
  family,
  inset = false,
}: {
  family: WorkspaceRootFamily;
  inset?: boolean;
}) {
  const variables = {
    '--safe-area-top': inset ? '27px' : '0px',
    '--safe-area-left': inset ? '11px' : '0px',
    '--safe-area-right': inset ? '13px' : '0px',
    '--native-keyboard-height': inset ? '260px' : '0px',
    '--ease-out': 'cubic-bezier(0.2, 0.7, 0.3, 1)',
    height: '100vh',
  } as CSSProperties;
  return (
    <div data-layout-probe-input={inset ? 'native-inset' : 'zero'} style={variables}>
      <ChatLandingContent rootFamily={family} />
    </div>
  );
}

export const OwnedRootMobileDefault: Story = {
  parameters: { layout: 'fullscreen' },
  render: () => <OwnedRootProbe family="mobile" />,
};

export const OwnedRootMobileNativeInset: Story = {
  parameters: { layout: 'fullscreen' },
  render: () => <OwnedRootProbe family="mobile" inset />,
};

export const OwnedRootWebNativeInset: Story = {
  parameters: { layout: 'fullscreen' },
  render: () => <OwnedRootProbe family="web" inset />,
};

export const OwnedRootSettingsNativeInset: Story = {
  parameters: { layout: 'fullscreen' },
  render: () => <OwnedRootProbe family="settings" inset />,
};

import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Provider, createStore, useAtomValue } from 'jotai';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { AgentConfigId, LocalProjectId, MachineId } from '@lody/shared';
import * as stylex from '@stylexjs/stylex';
import { desktopOnboardingDraftAtom, desktopOnboardingPhaseAtom } from '../atoms/onboarding';
import { localProbeAttemptedAtom } from '../atoms/local-probe';
import { OnboardingOverlay } from '../components/onboarding/onboarding-overlay';
import { OnboardingBackdrop } from '../components/onboarding/onboarding-backdrop';
import { useTheme } from '../theme-provider';

const platform = createLocalPlatformProvider({
  session: createStaticStore({ status: 'unauthenticated' }),
  workspaces: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
});
const styles = stylex.create({
  canvas: {
    position: 'relative',
    minHeight: '100dvh',
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
  },
  backdropStage: { position: 'relative', width: '100%', height: 360 },
  content: { position: 'relative', padding: 24, maxWidth: 640 },
  result: {
    position: 'fixed',
    bottom: 0,
    right: 0,
    zIndex: 100,
    maxWidth: '100%',
    overflowWrap: 'anywhere',
    pointerEvents: 'none',
    fontSize: 11,
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
  },
});
const meta = {
  title: 'Onboarding/OwnedOnboardingSurfaceMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function PhaseObservation({ intent }: { intent: string }) {
  const phase = useAtomValue(desktopOnboardingPhaseAtom);
  const { resolvedTheme } = useTheme();
  return (
    <output
      {...stylex.props(styles.result)}
      data-onboarding-surface-result=""
      data-phase={phase}
      data-resolved-theme={resolvedTheme}
      data-intent={intent}
    >
      Synthetic observation: {phase}; {intent}; resolved theme {resolvedTheme}
    </output>
  );
}

function OverlayFixture({ long = false }: { long?: boolean }) {
  const [store] = useState(createStore);
  const [ready, setReady] = useState(false);
  const [intent, setIntent] = useState('Not completed');
  const [completed, setCompleted] = useState(false);
  const { theme, setTheme, previewTheme, resolvedTheme } = useTheme();
  const initialTheme = useRef(theme);
  useLayoutEffect(() => {
    if (resolvedTheme !== 'light') previewTheme('light');
  }, [previewTheme, resolvedTheme]);
  useLayoutEffect(() => {
    const previousTheme = initialTheme.current;
    const previousPhase = localStorage.getItem('lody-desktop-onboarding-phase');
    const previousDraft = localStorage.getItem('lody-desktop-onboarding-draft');
    store.set(desktopOnboardingPhaseAtom, 'summary');
    store.set(localProbeAttemptedAtom, true);
    store.set(desktopOnboardingDraftAtom, {
      provider: long
        ? {
            kind: 'agentConfig',
            agentConfigId: 'synthetic-unpublished-agent' as AgentConfigId,
            agentName:
              'Synthetic selected agent with a deliberately long readable name for the summary boundary',
          }
        : null,
      project: long
        ? {
            kind: 'local',
            machineId: 'synthetic-unavailable-machine' as MachineId,
            localProjectId: 'synthetic-unavailable-project' as LocalProjectId,
            name: 'Synthetic project with a deliberately long name that must preserve the existing compact table and stage layout',
          }
        : null,
    });
    setTheme('light');
    setReady(true);
    return () => {
      for (const [key, previous] of [
        ['lody-desktop-onboarding-phase', previousPhase],
        ['lody-desktop-onboarding-draft', previousDraft],
      ]) {
        if (previous === null) localStorage.removeItem(key!);
        else localStorage.setItem(key!, previous!);
      }
      setTheme(previousTheme);
    };
  }, [long, setTheme, store]);
  if (!ready) return null;
  return (
    <Provider store={store}>
      <PlatformContext.Provider value={platform}>
        <div data-onboarding-surface-fixture={long ? 'long-overlay' : 'overlay'}>
          {!completed ? (
            <OnboardingOverlay
              onCompleted={async (completion) => {
                setIntent(`Completion requested: ${completion.entryPoint}`);
                setCompleted(true);
                return true;
              }}
            />
          ) : null}
          <PhaseObservation intent={intent} />
        </div>
      </PlatformContext.Provider>
    </Provider>
  );
}

function BackdropFixture({ caller = false }: { caller?: boolean }) {
  return (
    <div {...stylex.props(styles.canvas)} data-onboarding-surface-fixture="backdrop">
      <div {...stylex.props(styles.backdropStage)} data-onboarding-backdrop-host="">
        <OnboardingBackdrop
          className={caller ? 'pointer-events-auto relative inset-auto bg-primary/30' : undefined}
        />
        <div {...stylex.props(styles.content)}>
          <h1>Synthetic backdrop host</h1>
          <p>
            The production backdrop paints this bounded stage. No onboarding flow or runtime is
            started.
          </p>
          <button type="button" data-onboarding-backdrop-action="">
            Synthetic focus target
          </button>
        </div>
      </div>
      <output data-onboarding-surface-result="">
        {caller ? 'Caller override' : 'Default backdrop'}
      </output>
    </div>
  );
}

export const OverlaySummary: Story = { render: () => <OverlayFixture /> };
export const LongOverlaySummary: Story = { render: () => <OverlayFixture long /> };
export const Backdrop: Story = { render: () => <BackdropFixture /> };
export const CallerBackdrop: Story = { render: () => <BackdropFixture caller /> };

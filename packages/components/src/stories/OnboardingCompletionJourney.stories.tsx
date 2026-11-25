import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import {
  ConnectModelSheet,
  EMPTY_ARRIVAL_PROBE,
  IDLE_SORBET_OAUTH_STATE,
  ModelScreen,
  OnboardingChipRail,
  SorbetOnboardingControllerProvider,
  StartScreen,
  type ConnectedModelPayload,
  type SorbetOnboardingController,
} from '@/components/onboarding';
import { flatSurface } from '@/components/onboarding/shared/flat-surface.stylex';

const frameStyles = stylex.create({
  stage: {
    position: 'relative',
    minHeight: '760px',
    width: '100%',
    backgroundColor: '#FAF9F6',
    color: '#141413',
  },
});

function createStorySorbetController(
  overrides: Partial<SorbetOnboardingController> = {}
): SorbetOnboardingController {
  return {
    probe: EMPTY_ARRIVAL_PROBE,
    probeLoading: false,
    oauthState: IDLE_SORBET_OAUTH_STATE,
    refreshProbe: async () => EMPTY_ARRIVAL_PROBE,
    startOAuth: async ({ providerId, providerName }) => ({
      ...IDLE_SORBET_OAUTH_STATE,
      revision: 1,
      attemptId: 'story-attempt',
      providerId,
      providerName: providerName ?? providerId,
      phase: 'waiting',
      authorizationUrl: 'https://auth.example.com/authorize',
    }),
    cancelOAuth: async () => undefined,
    describeImport: async (source) => ({
      source,
      systemPromptKind: source === 'claude-code' ? 'macos-keychain' : 'none',
    }),
    runImport: async (req) => {
      if (req.source === 'env' && req.mode === 'scan') {
        return {
          status: 'env_candidates',
          candidates: [
            {
              envName: 'ANTHROPIC_API_KEY',
              providerId: 'anthropic',
              providerName: 'Claude',
              last4: 'a3f9',
            },
          ],
        };
      }
      if (req.source === 'claude-code') {
        return {
          status: 'oauth_conflict',
          source: 'claude-code',
          providerId: 'anthropic',
          providerName: 'Claude',
        };
      }
      return {
        status: 'imported',
        source: req.source,
        providerId: 'openai',
        providerName: 'OpenAI',
        modelSelector: 'openai/gpt-5',
        modelName: 'GPT-5',
        connectionSource: {
          kind: 'imported',
          from: req.source,
          authKind: 'api_key',
          last4: '9b2c',
        },
      };
    },
    connectApiKey: async ({ providerId, apiKey }) => {
      if (apiKey.includes('invalid')) {
        return { ok: false, code: 'invalid_key' };
      }
      return {
        ok: true,
        providerId,
        providerName: providerId === 'anthropic' ? 'Claude' : 'OpenAI',
        modelSelector:
          providerId === 'anthropic' ? 'anthropic/claude-sonnet-4-5' : 'openai/gpt-5',
        modelName: providerId === 'anthropic' ? 'Sonnet 4.5' : 'GPT-5',
        source: { kind: 'api_key', last4: apiKey.slice(-4) },
        models: [],
      };
    },
    connectCustomProvider: async ({ name, baseUrl }) => ({
      ok: true,
      providerId: 'custom-gateway',
      providerName: name || new URL(baseUrl).hostname,
      modelSelector: 'custom-gateway/deepseek-v3',
      modelName: 'DeepSeek V3',
      source: { kind: 'api_key', last4: '44ef' },
      models: [],
    }),
    disconnectProvider: async () => undefined,
    applyDefaultModelSelection: async () => undefined,
    ...overrides,
  };
}

function InteractiveModelAndStartStory() {
  const [step, setStep] = useState<'model' | 'start' | 'done'>('model');
  const [modelChip, setModelChip] = useState<ConnectedModelPayload | null>(null);
  const [exiting, setExiting] = useState(false);

  return (
    <SorbetOnboardingControllerProvider value={createStorySorbetController()}>
      <div {...stylex.props(frameStyles.stage, flatSurface.onboardingLightScope)}>
        <OnboardingChipRail
          currentPhase={step === 'done' ? 'start' : step}
          accountChip={{
            userLabel: 'wibus',
            workspaceName: 'Personal',
            workspaceSlug: 'personal',
          }}
          modelChip={modelChip}
          exitingToProduct={exiting}
          onSelectPhase={(target) => {
            if (target === 'model') setStep('model');
          }}
        />

        {step === 'model' ? (
          <ModelScreen
            onConnected={(payload) => {
              setModelChip(payload);
              setStep('start');
            }}
            onSkip={() => setStep('start')}
          />
        ) : step === 'start' ? (
          <StartScreen
            project={null}
            modelChip={modelChip}
            selectedAgentConfigId={null}
            exitingToProduct={exiting}
            onProjectChange={() => undefined}
            onModelConnected={(payload) => setModelChip(payload)}
            onAgentConfigChange={() => undefined}
            onBeginExitTransition={() => setExiting(true)}
            onEnterWithSession={async () => {
              setStep('done');
              return true;
            }}
            onExploreFirst={async () => {
              setStep('done');
              return true;
            }}
          />
        ) : (
          <div
            data-testid="onboarding-complete"
            style={{
              minHeight: 760,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 20,
              fontWeight: 600,
            }}
          >
            Entered Lody Product
          </div>
        )}
      </div>
    </SorbetOnboardingControllerProvider>
  );
}

const meta = {
  title: 'Onboarding/ReorganizedJourney',
  component: InteractiveModelAndStartStory,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof InteractiveModelAndStartStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ModelToStartFlow: Story = {};

export const StandaloneConnectModelSheet: Story = {
  render: () => (
    <SorbetOnboardingControllerProvider value={createStorySorbetController()}>
      <div
        {...stylex.props(flatSurface.onboardingLightScope)}
        style={{ backgroundColor: '#FAF9F6', padding: '3rem', maxWidth: 560, margin: '0 auto' }}
      >
        <ConnectModelSheet showHeader />
      </div>
    </SorbetOnboardingControllerProvider>
  ),
};

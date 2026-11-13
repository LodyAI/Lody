// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout, so nothing can be scrolled into view.
Element.prototype.scrollIntoView = () => undefined;

// The menu resolves its default agent pool from machine presence; these
// surfaces pass their agent in explicitly, so the pool is not under test.
vi.mock('../src/hooks/use-online-machines', () => ({ useOnlineMachines: () => [] }));
vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionMentionItems: () => [],
}));
vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
}));
import type { AcpConfigOptionSelector } from '@/components/shared/acp-selector-options';
import {
  DEVIN_SPEED_CONFIG_ID,
  DEVIN_SPEED_FAST_VALUE,
} from '@/components/shared/acp-selector-options';
import type { AcpModelConfigOptionsSource, AcpModelControls } from '@lody/shared';
import {
  changeFusionPair,
  findFusionPair,
  findFusionPairForModel,
  fusionApplyEdits,
  initialFusionDraft,
  isFusionConfigConfirmed,
  parseFusionCatalog,
  resolveFusionControls,
  type FusionCatalog,
  type FusionControlsResolver,
} from '@/lib/devin-fusion';
import { FusionBuilderDialog } from '@/components/sessions/fusion-builder-dialog';
import type { AgentSelection } from '@/components/shared/agent-selector';
import type { AgentConfig } from '@/components/sessions/desktop-run-config-menu';
import { DesktopRunConfigMenu } from '@/components/sessions/desktop-run-config-menu';

// Synthetic Devin-shaped fixtures: fusion values mirror
// `fusion-<lead token>-sidekick-<sidekick token>` with the lead's default
// effort encoded in the lead token; controls come from each pair's selectors.
const MODEL_OPTIONS = [
  { value: 'adaptive', label: 'Adaptive' },
  { value: 'swe-2-high', label: 'SWE-2 High' },
  { value: 'fusion-alpha-high-sidekick-x', label: 'Fusion (Alpha High + X)' },
  { value: 'fusion-alpha-high-sidekick-y', label: 'Fusion (Alpha High + Y)' },
  { value: 'fusion-beta-low-sidekick-x', label: 'Fusion (Beta Low + X)' },
  { value: 'fusion-fable-sidekick-x', label: 'Fusion (Fable 5.2 + X)' },
  { value: 'fusion-fable-sidekick-z', label: 'Fusion (Fable 5.2 + Z)' },
];

const effortSelect = (currentValue: string, values: readonly string[]) =>
  ({
    configId: 'thought_level',
    category: 'thought_level',
    type: 'select',
    label: 'Effort',
    currentValue,
    options: values.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })),
  }) as unknown as AcpConfigOptionSelector;

const speedSelect = () =>
  ({
    configId: DEVIN_SPEED_CONFIG_ID,
    category: 'model_config',
    type: 'select',
    label: 'Speed',
    currentValue: 'standard',
    options: [
      { value: 'standard', label: 'Standard' },
      { value: DEVIN_SPEED_FAST_VALUE, label: 'Fast' },
    ],
  }) as unknown as AcpConfigOptionSelector;

const ALPHA = [effortSelect('high', ['low', 'medium', 'high']), speedSelect()];
const SELECTORS: Record<string, AcpConfigOptionSelector[]> = {
  'fusion-alpha-high-sidekick-x': ALPHA,
  'fusion-alpha-high-sidekick-y': ALPHA,
  'fusion-beta-low-sidekick-x': [effortSelect('low', ['minimal', 'low']), speedSelect()],
  // Fable pairs have no `speed` option (authoritative Devin fact).
  'fusion-fable-sidekick-x': [effortSelect('high', ['medium', 'high'])],
  'fusion-fable-sidekick-z': [effortSelect('high', ['medium', 'high'])],
};

const catalog = (): FusionCatalog => {
  const parsed = parseFusionCatalog(MODEL_OPTIONS);
  if (!parsed) throw new Error('fixture catalog must parse');
  return parsed;
};

const draft = (leadKey: string, sidekickKey: string, effort: string | null, fast: boolean) => ({
  leadKey,
  sidekickKey,
  effort,
  fast,
});

const pairControls: FusionControlsResolver = (modelValue) =>
  resolveFusionControls(SELECTORS[modelValue] ?? [], 'snapshot');

describe('parseFusionCatalog', () => {
  it('keeps leads/sidekicks in runtime order, excludes non-Fusion models', () => {
    const parsed = catalog();
    expect(parsed.leads.map((l) => [l.key, l.label])).toEqual([
      ['alpha-high', 'Alpha'],
      ['beta-low', 'Beta'],
      ['fable', 'Fable 5.2'],
    ]);
    expect(parsed.sidekicks.map((s) => s.key)).toEqual(['x', 'y', 'z']);
  });

  it('returns null when no option parses (malformed and disabled excluded)', () => {
    const bad = [
      { value: 'adaptive', label: 'Adaptive' },
      { value: 'fusion-x', label: 'Not a fusion label' },
      { value: 'fusion-a-sidekick-b', label: 'Wrong (Name)' },
      { value: 'fusion-c-sidekick-d', label: 'Fusion (C + D)', disabled: true },
    ];
    expect(parseFusionCatalog(bad)).toBeNull();
  });

  it.each([
    {
      name: 'strips the effort word only when token and name agree',
      options: [
        { value: 'fusion-mist-high-sidekick-x', label: 'Fusion (Mist High Thinking + X)' },
        { value: 'fusion-glm-sidekick-x', label: 'Fusion (GLM-5.2 High + X)' },
      ],
      labels: ['Mist', 'GLM-5.2 High'],
    },
    {
      name: 'a stripped label colliding with an unstripped one keeps both full',
      options: [
        { value: 'fusion-alpha-low-sidekick-x', label: 'Fusion (Alpha Low + X)' },
        { value: 'fusion-alpha-sidekick-y', label: 'Fusion (Alpha + Y)' },
      ],
      labels: ['Alpha Low', 'Alpha'],
    },
  ])('lead labels: $name', ({ options, labels }) => {
    expect(parseFusionCatalog(options)?.leads.map((l) => l.label)).toEqual(labels);
  });

  it('finds only advertised pairs and models; nothing is synthesized', () => {
    const parsed = catalog();
    expect(findFusionPair(parsed, 'alpha-high', 'x')?.modelValue).toBe(
      'fusion-alpha-high-sidekick-x'
    );
    expect(findFusionPair(parsed, 'alpha-high', 'z')).toBeUndefined();
    expect(findFusionPairForModel(parsed, 'adaptive')).toBeUndefined();
  });
});

describe('resolveFusionControls', () => {
  it('derives effort from thought_level and Fast only from a speed select offering fast', () => {
    const controls = resolveFusionControls(ALPHA, 'snapshot');
    expect(controls.effort).toMatchObject({ configId: 'thought_level', defaultValue: 'high' });
    expect(controls.effort?.options.map((o) => o.value)).toEqual(['low', 'medium', 'high']);
    expect(controls.fast).toEqual({
      configId: DEVIN_SPEED_CONFIG_ID,
      onValue: DEVIN_SPEED_FAST_VALUE,
      offValue: 'standard',
    });
    expect(controls.unknown).toEqual({ effort: false, fast: false });
  });

  it('ignores a speed select that offers no fast value', () => {
    const controls = resolveFusionControls([effortSelect('high', ['high'])], 'snapshot');
    expect(controls.fast).toBeNull();
  });

  it('marks both controls unknown when the selectors are borrowed', () => {
    expect(resolveFusionControls(ALPHA, 'borrowed')).toEqual({
      effort: null,
      fast: null,
      unknown: { effort: true, fast: true },
    });
  });

  it.each([
    {
      name: 'declared controls mark absent selectors unknown',
      selectors: [] as AcpConfigOptionSelector[],
      declared: { effortValues: ['low', 'high'], fastMode: true } as AcpModelControls,
      unknown: { effort: true, fast: true },
    },
    {
      name: 'undeclared absent controls are unavailable, not unknown',
      selectors: SELECTORS['fusion-fable-sidekick-x'],
      declared: { effortValues: ['medium', 'high'], fastMode: false } as AcpModelControls,
      unknown: { effort: false, fast: false },
    },
  ])('$name', ({ selectors, declared, unknown }) => {
    expect(resolveFusionControls(selectors, 'snapshot', declared).unknown).toEqual(unknown);
  });
});

describe('initialFusionDraft', () => {
  it('starts from the current pair with its runtime effort and Fast', () => {
    const current = {
      modelId: 'fusion-alpha-high-sidekick-y',
      configOptionValues: { thought_level: 'medium', speed: DEVIN_SPEED_FAST_VALUE },
    };
    expect(initialFusionDraft(catalog(), current, pairControls)).toEqual(
      draft('alpha-high', 'y', 'medium', true)
    );
  });

  it.each([{ modelId: 'adaptive' }, { modelId: null }])(
    'falls back to the first advertised pair for current model $modelId',
    ({ modelId }) => {
      const current = { modelId, configOptionValues: {} };
      expect(initialFusionDraft(catalog(), current, pairControls)).toEqual(
        draft('alpha-high', 'x', 'high', false)
      );
    }
  );
});

describe('changeFusionPair', () => {
  const baseDraft = { leadKey: 'alpha-high', sidekickKey: 'x', effort: 'medium', fast: true };

  it('keeps an effort the new pair still offers', () => {
    const { draft, notices } = changeFusionPair(
      baseDraft,
      { sidekickKey: 'y' },
      catalog(),
      pairControls
    );
    expect(draft.effort).toBe('medium');
    expect(notices).toEqual([]);
  });

  it('resets an unoffered effort and turns Fast off, both with notices', () => {
    const { draft, notices } = changeFusionPair(
      { ...baseDraft, effort: 'low' },
      { leadKey: 'fable' },
      catalog(),
      pairControls
    );
    expect(draft).toMatchObject({
      leadKey: 'fable',
      sidekickKey: 'x',
      effort: 'high',
      fast: false,
    });
    expect(notices).toEqual([
      { kind: 'effortReset', from: 'Low', to: 'High' },
      { kind: 'fastOff' },
    ]);
  });

  it('keeps the draft but cannot apply an unadvertised combination', () => {
    const { draft, notices } = changeFusionPair(
      baseDraft,
      { sidekickKey: 'z' },
      catalog(),
      pairControls
    );
    expect(draft).toMatchObject({ leadKey: 'alpha-high', sidekickKey: 'z', fast: true });
    expect(notices).toEqual([]);
    expect(fusionApplyEdits(draft, catalog(), pairControls)).toBeNull();
  });
});

describe('fusionApplyEdits / isFusionConfigConfirmed', () => {
  it.each([
    {
      name: 'emits the pair model value and exact control values',
      inDraft: draft('alpha-high', 'y', 'low', true),
      edits: {
        modelValue: 'fusion-alpha-high-sidekick-y',
        configOptionValues: { thought_level: 'low', speed: DEVIN_SPEED_FAST_VALUE },
      },
      runtime: {
        modelId: 'fusion-alpha-high-sidekick-y',
        configOptionValues: { thought_level: 'low', speed: DEVIN_SPEED_FAST_VALUE },
      },
      confirmed: true,
    },
    {
      name: 'omits the speed key without a Fast control and rejects mismatches',
      inDraft: draft('fable', 'x', 'medium', true),
      edits: {
        modelValue: 'fusion-fable-sidekick-x',
        configOptionValues: { thought_level: 'medium' },
      },
      runtime: {
        modelId: 'fusion-fable-sidekick-x',
        configOptionValues: { thought_level: 'high' },
      },
      confirmed: false,
    },
  ])('$name', ({ inDraft, edits, runtime, confirmed }) => {
    const actual = fusionApplyEdits(inDraft, catalog(), pairControls);
    expect(actual).toEqual(edits);
    expect(actual != null && isFusionConfigConfirmed(actual, runtime)).toBe(confirmed);
  });
});

const openDialog = async (props?: {
  modelId?: string;
  configOptionValues?: Record<string, string>;
  runtime?: { modelId?: string; configOptionValues?: Record<string, string> } | null;
  controls?: FusionControlsResolver;
}): Promise<HTMLElement> => {
  await act(async () => {
    root?.render(
      createElement(FusionBuilderDialog, {
        open: true,
        onOpenChange: () => {},
        catalog: catalog(),
        controlsFor: props?.controls ?? pairControls,
        current: {
          modelId: props?.modelId ?? 'fusion-alpha-high-sidekick-x',
          configOptionValues: props?.configOptionValues ?? { thought_level: 'high' },
        },
        runtime: props?.runtime ?? null,
        appliesOn: 'nextMessage',
        modelLabel: (value: string) => MODEL_OPTIONS.find((o) => o.value === value)?.label ?? value,
        onApply: (edits: unknown) => {
          appliedEdits = edits;
        },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  const dialog = document.querySelector<HTMLElement>('[data-testid="fusion-builder-dialog"]');
  if (!dialog) throw new Error('fusion dialog did not mount');
  return dialog;
};
let appliedEdits: unknown;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const flush = () => new Promise((resolve) => setTimeout(resolve, 40));

beforeEach(async () => {
  await initI18n('en');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  appliedEdits = undefined;
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = undefined;
  }
  container?.remove();
  container = undefined;
});

const click = async (testid: string) => {
  await act(async () => {
    const el = document.querySelector(`[data-testid="${testid}"]`);
    el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
  });
};

const rowText = (dialog: HTMLElement, testid: string) =>
  dialog.querySelector(`[data-testid="${testid}"]`)?.textContent ?? '';

describe('FusionBuilderDialog', () => {
  it('opens on a confirmed Fusion pair with its rows and confirmed text', async () => {
    const current = { thought_level: 'high', speed: 'standard' };
    const dialog = await openDialog({
      configOptionValues: current,
      runtime: { modelId: 'fusion-alpha-high-sidekick-x', configOptionValues: current },
    });
    expect(rowText(dialog, 'fusion-lead-select')).toContain('Alpha');
    expect(rowText(dialog, 'fusion-sidekick-select')).toContain('X');
    expect(rowText(dialog, 'fusion-effort-select')).toContain('High');
    expect(dialog.textContent).toContain(
      'Devin confirmed this configuration for the conversation.'
    );
  });

  it('emits the exact apply edits', async () => {
    await openDialog();
    await click('fusion-fast-switch');
    await click('fusion-apply');
    expect(appliedEdits).toEqual({
      modelValue: 'fusion-alpha-high-sidekick-x',
      configOptionValues: { thought_level: 'high', speed: DEVIN_SPEED_FAST_VALUE },
    });
  });

  it('distinguishes absent controls from unknown ones', async () => {
    const absent = await openDialog({ modelId: 'fusion-fable-sidekick-x' });
    const fast = absent.querySelector<HTMLButtonElement>('[data-testid="fusion-fast-switch"]');
    expect(fast?.disabled).toBe(true);
    expect(absent.textContent).toContain("Devin doesn't offer Fast Mode for this combination.");
    const unknown = await openDialog({
      controls: () => ({ effort: null, fast: null, unknown: { effort: true, fast: true } }),
    });
    expect(unknown.textContent).not.toContain("doesn't offer");
    expect(unknown.textContent).toContain("Lody hasn't loaded this setting from Devin yet.");
  });

  it('renders the runtime summary and pending text when runtime differs', async () => {
    const dialog = await openDialog({
      runtime: {
        modelId: 'fusion-alpha-high-sidekick-y',
        configOptionValues: { thought_level: 'medium', speed: DEVIN_SPEED_FAST_VALUE },
      },
    });
    expect(dialog.textContent).toContain(
      'Devin is currently running Fusion (Alpha High + Y) · Medium · Fast.'
    );
    expect(dialog.textContent).toContain('Applies from your next message');
  });
});

describe('DesktopRunConfigMenu fusion row', () => {
  const menuProps = (agentType = 'devin') => ({
    agentSelection: null,
    availableAgentConfigs: [],
    fallbackAgent: { cliType: 'builtin' as const, agentType },
    modelOptions: MODEL_OPTIONS,
    selectedModelId: 'fusion-alpha-high-sidekick-x',
    onModelChange: vi.fn(),
    configOptionSelectors: [],
    configOptionValues: {},
    onConfigOptionChange: vi.fn(),
    fusionBuilder: {
      selectorsForModel: (modelValue: string) => ({
        selectors: SELECTORS[modelValue] ?? [],
        source: 'snapshot' as AcpModelConfigOptionsSource,
      }),
      appliesOn: 'nextMessage' as const,
    },
  });

  const openMenu = async (props: object) => {
    await act(async () => {
      root?.unmount();
      root = createRoot(container);
      root.render(createElement(DesktopRunConfigMenu, props as never));
    });
    await act(async () => {
      container
        ?.querySelector('button[aria-label="Run configuration"]')
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      await flush();
    });
    return document.querySelector<HTMLElement>('[data-testid="fusion-builder-trigger"]');
  };

  it('shows the row for builtin Devin with a builder, not Codex, not without', async () => {
    expect((await openMenu(menuProps()))?.textContent).toContain('Alpha + X');
    expect(await openMenu(menuProps('codex'))).toBeNull();
    const { fusionBuilder: _omit, ...noBuilder } = menuProps();
    expect(await openMenu(noBuilder)).toBeNull();
  });
});

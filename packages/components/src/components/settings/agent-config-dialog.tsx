import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue, useSetAtom } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { toast } from '@/lib/toast';
import { usePostHog } from '@posthog/react';
import {
  computeTitleGenerationDefaults,
  DEEPSEEK_HARNESS_API_KEY_ENV,
  DEEPSEEK_HARNESS_BASE_URL_ENV,
  formatCustomAcpCommandLine,
  getAcpCapabilityCacheEntryAuthority,
  getAcpCapabilityCacheKey,
  getStaticBuiltinAcpCapabilities,
  getBuiltinTitleGenerationDefaults,
  getRegistryAcpLaunchKind,
  hasBuiltinRuntimeOverrideValues,
  machineSupportsProviderSetupProtocol,
  machineSupportsPiExtensions,
  type MachinePiExtensionsResponse,
  isManagedBuiltinAgentType,
  isAcpCapabilityCacheEntryCurrent,
  parseCustomAcpCommandLine,
  serializeCustomAcpLaunchSpec,
  machineSupportsAcpProtocolAuthentication,
  supportsBuiltinAuthentication,
  usesAcpProtocolAuthentication,
  acpOwnsSessionTitleGeneration,
  REGISTRY_ACP_AGENTS,
  type AgentBrandId,
  type AgentConfigCliType,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentType,
  type ManagedBuiltinAgentType,
  type BuiltinRuntimeOverrides,
  type CustomAcpLaunchSpec,
  type MachineAcpBinaryProgressMessage,
  type MachineAcpBinaryStatusResponse,
  type MachineAcpCapabilitiesRefreshResponse,
  type MachineId,
  type MachineViewMeta,
  type TitleGenerationConfig,
} from '@lody/shared';
import {
  buildAllConfigOptionSelectors,
  isConfigOptionValueValid,
  type AcpConfigOptionSelector,
  type AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import {
  AlertTriangle,
  CircleAlert,
  CircleCheck,
  CirclePlay,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FlaskConical,
  KeyRound,
  Lock,
  RefreshCw,
  Search,
  Sparkles,
  SquareTerminal,
  X,
} from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { AgentIcon } from '@/components/icons/agent-icon';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { useKeyboardAwareScrollIntoView } from '@/hooks/use-keyboard-aware-scroll-into-view';
import { useMachineAcpBinaryProgress } from '@/hooks/use-machine-acp-binary-progress';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { Collapsible } from '@lody/ui/collapsible';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';
import { Textarea } from '@lody/ui/textarea';
import { Select } from '@lody/ui/select';
import { Tabs } from '@lody/ui/tabs';
import { EnvVarsTextarea, envVarsToText } from './env-vars-textarea';
import { Tooltip } from '@lody/ui/tooltip';
import { Badge } from '@lody/ui/badge';
import { Radio, RadioGroup } from '@lody/ui/radio';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { control, corner, duration, ease, radius, space } from '@lody/ui/tokens/scales.stylex';
import { AcpAuthenticationPanel } from './acp-authentication-panel';
import { Field } from './form-primitives';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';
import { BubInstallGuide } from './bub-install-guide';
import { PiExtensionsField } from './pi-extensions-field';
import { ProviderSetupRow } from './provider-setup-row';
import {
  getAgentMetaByIdAtomFamily,
  getProviderSetupsByMachineAtomFamily,
  cmdRetryProviderSetupAtom,
  deleteProviderSetupAtom,
} from '@/atoms/agents';
import { settingsType as type } from './type.stylex';

type Translate = ReturnType<typeof useTranslation>['t'];

// =============================================================================
// Styles
// =============================================================================

const SM = '@media (min-width: 640px)';
/** A block inside the dialog: the region rung, a fill with no edge. */
const REGION = `color-mix(in oklab, transparent, ${colors.label} 3%)`;
const MONO = 'var(--font-mono, ui-monospace, monospace)';

/**
 * The panel's own size and padding. The dialog panel sets its width, padding and
 * gap itself, so a class could not reliably win over them; `style` is the
 * panel's documented way to take a surface's layout. The panel has no padding:
 * the picker meets its edge and the form pads itself.
 */
const PANEL_STYLE: CSSProperties = {
  width: 'min(1040px, 96dvw)',
  maxWidth: 'none',
  height: 'min(680px, 92dvh)',
  padding: 0,
  gap: 0,
  overflow: 'hidden',
};

/**
 * A true full-screen sheet: no centring, no cap, no corners. The device safe
 * area (notch, home indicator, landscape cutouts) is padding, so the picker and
 * form headers and footers sit clear of it.
 */
const PANEL_STYLE_NARROW: CSSProperties = {
  insetBlockStart: 0,
  insetInlineStart: 0,
  transform: 'none',
  width: '100vw',
  maxWidth: 'none',
  height: 'calc(100dvh - var(--native-keyboard-height, 0px))',
  maxHeight: 'none',
  paddingTop: 'var(--safe-area-top)',
  paddingBottom: 'max(0px, var(--safe-area-bottom, 0px) - var(--native-keyboard-height, 0px))',
  paddingLeft: 'var(--safe-area-left)',
  paddingRight: 'var(--safe-area-right)',
  gap: 0,
  borderRadius: 0,
  overflow: 'hidden',
};

const styles = stylex.create({
  /** The picker and the form, side by side. */
  layout: {
    display: 'flex',
    flexGrow: 1,
    height: '100%',
    minHeight: 0,
    minWidth: 0,
  },

  /**
   * The type picker: a sidebar that meets the panel's edge, with the one
   * structural line of the dialog between it and the form.
   */
  rail: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    width: '292px',
    height: '100%',
    minHeight: 0,
    paddingTop: space[4],
    backgroundColor: REGION,
    borderInlineEndWidth: '1px',
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: colors.separator,
  },
  railNarrow: {
    flexShrink: 1,
    width: '100%',
    paddingTop: 0,
    backgroundColor: 'transparent',
    borderInlineEndWidth: 0,
  },
  railHeader: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[2],
    minHeight: control.large,
    paddingInline: space[4],
  },
  railHeaderNarrow: {
    minHeight: '56px',
    paddingInlineStart: space[2],
    paddingInlineEnd: space[4],
  },
  railTitle: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '14px',
    lineHeight: type.leading,
    color: colors.label,
  },
  search: { position: 'relative', flexShrink: 0, paddingInline: space[2] },
  /** On the form header's 36px row, so the two columns start on one line. */
  searchOnHeaderRow: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    minHeight: control.large,
  },
  searchClear: {
    position: 'absolute',
    insetBlockStart: '50%',
    insetInlineEnd: `calc(${space[2]} + ${space[1]})`,
    display: 'flex',
    transform: 'translateY(-50%)',
  },
  railList: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    marginTop: space[2],
    paddingInline: space[2],
    paddingBottom: space[3],
  },
  railGroup: { marginBottom: space[1] },
  railGroupTitle: {
    paddingInline: space[2],
    paddingTop: space[3],
    paddingBottom: space[1.5],
    fontSize: '11px',
    lineHeight: type.leading,
    color: colors.tertiaryLabel,
  },
  railGroupItems: { display: 'flex', flexDirection: 'column', gap: '2px' },
  railItem: { gap: '10px', fontSize: '13px' },
  railItemNarrow: { paddingBlock: '10px', fontSize: '15px' },
  railItemDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
    backgroundColor: { default: 'transparent', ':hover': 'transparent' },
  },
  railIcon: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    color: colors.secondaryLabel,
  },
  railIconNarrow: { width: '28px', height: '28px' },
  railIconSelected: { color: colors.label },
  optionIcon: { width: '14px', height: '14px' },
  optionIconLarge: { width: '16px', height: '16px' },
  railCheck: { flexShrink: 0, width: '12px', height: '12px', color: colors.accent },
  railChevron: { flexShrink: 0, width: '16px', height: '16px', color: colors.tertiaryLabel },
  railEmpty: {
    paddingInline: space[2],
    paddingBlock: space[6],
    textAlign: 'center',
    fontSize: '12px',
    color: colors.secondaryLabel,
  },

  /** The form: its header, the scrolling groups and the answers, set apart by space. */
  pane: { flexGrow: 1, padding: space[4] },
  paneNarrow: { gap: 0, padding: 0 },
  header: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    minHeight: control.large,
    // The panel's cross sits in this corner, out of the header's flow.
    paddingInlineEnd: `calc(${control.small} + ${space[2]})`,
  },
  headerNarrow: {
    minHeight: '56px',
    paddingInlineStart: space[2],
    paddingInlineEnd: space[4],
  },
  headerMain: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  headerGlyph: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: control.large,
    height: control.large,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 5%)`,
    color: colors.label,
  },
  headerText: { minWidth: 0 },
  title: {
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '14px',
    fontWeight: 400,
    lineHeight: type.leading,
    color: colors.label,
  },
  subtitle: {
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '12px',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  bodyNarrow: {
    marginInline: 0,
    marginBlock: 0,
    paddingInline: space[4],
    paddingBlock: space[4],
  },
  /** The groups of the form, stacked and set apart by space. */
  groups: { display: 'flex', flexDirection: 'column', gap: space[4], minWidth: 0 },
  hidden: { display: 'none' },
  stack: { display: 'flex', flexDirection: 'column', gap: space[3], minWidth: 0 },
  stackTight: { display: 'flex', flexDirection: 'column', gap: space[2], minWidth: 0 },
  actionRow: { display: 'flex', alignItems: 'center', gap: space[2] },
  /** A field and the one button that checks it, on one row. */
  inputWithTest: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  /** Two glyphs in one box, cross-faded: the button changes what it says, not where. */
  testGlyphs: { position: 'relative', display: 'block', width: '16px', height: '16px' },
  testGlyph: {
    position: 'absolute',
    inset: 0,
    width: '16px',
    height: '16px',
    opacity: 0,
    transform: 'scale(0.85)',
    transitionProperty: 'opacity, transform',
    transitionDuration: duration.regular,
    transitionTimingFunction: ease.standard,
  },
  testGlyphShown: { opacity: 1, transform: 'scale(1)' },
  testGlyphReady: { color: colors.success },
  testGlyphError: { color: colors.warning },
  ready: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    fontSize: '12px',
    color: colors.success,
  },
  hint: { margin: 0, fontSize: '11px', lineHeight: 1.375, color: colors.secondaryLabel },
  note: { margin: 0, fontSize: '12px', lineHeight: 1.375, color: colors.secondaryLabel },
  /** A status inside the form: the region rung's fill, copy at the caption step. */
  status: { display: 'flex', flexDirection: 'column', gap: space[2], fontSize: '12px' },
  statusText: { margin: 0, lineHeight: 1.375, color: colors.secondaryLabel },
  statusWarning: { margin: 0, lineHeight: 1.375, color: colors.warning },
  statusBusy: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    margin: 0,
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  /** A warning is a tint and a mark, never a box. */
  warning: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    paddingInline: space[3],
    paddingBlock: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.warning} 10%)`,
    fontSize: '12px',
    lineHeight: 1.375,
    color: colors.label,
  },
  warningMark: {
    flexShrink: 0,
    width: '14px',
    height: '14px',
    marginTop: '2px',
    color: colors.warning,
  },
  warningBody: { minWidth: 0 },
  answer: { alignSelf: 'flex-start' },
  footerNarrow: { paddingInline: space[4], paddingBottom: space[3] },
  footerNote: {
    display: 'inline-flex',
    alignItems: 'center',
    alignSelf: 'center',
    gap: space[1],
    minWidth: 0,
    marginInlineEnd: 'auto',
    fontSize: '12px',
    color: colors.secondaryLabel,
  },

  /** What the header says about the capability probe. */
  probing: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1.5],
    whiteSpace: 'nowrap',
    fontSize: '12px',
    color: colors.secondaryLabel,
  },
  probeReady: { display: 'inline-flex', flexShrink: 0, alignItems: 'center', gap: space[2] },
  /** A glyph in a box `@lody/ui` draws: an icon-only button's or a badge's. */
  glyphFill: { width: '100%', height: '100%' },

  /** A credential mode: the radio, then its name over what it is for. */
  radioRow: { display: 'flex', alignItems: 'flex-start', gap: space[2], cursor: 'pointer' },
  radioBox: { display: 'flex', flexShrink: 0, paddingTop: '1px' },
  radioText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  radioLabel: { fontSize: '13px', lineHeight: 1.375, color: colors.label },
  radioHint: { fontSize: '11px', lineHeight: 1.375, color: colors.secondaryLabel },
  link: {
    color: colors.accent,
    textDecoration: { default: 'none', ':hover': 'underline' },
    textUnderlineOffset: '2px',
  },
  disclosureIcon: {
    flexShrink: 0,
    width: '12px',
    height: '12px',
    transitionProperty: 'transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  disclosureIconOpen: { transform: 'rotate(180deg)' },
  lockIcon: { flexShrink: 0, width: '12px', height: '12px', opacity: 0.7 },
  /** The panel's padding rides on a child: Base UI animates a height that counts it. */
  revealed: { paddingTop: space[2] },
  envList: {
    margin: 0,
    overflow: 'hidden',
    backgroundColor: REGION,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontSize: '11px',
  },
  envRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    paddingInline: space[3],
    paddingBlock: space[1.5],
  },
  envKey: {
    flexBasis: 0,
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: MONO,
    color: colors.secondaryLabel,
  },
  envValue: {
    flexBasis: 0,
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'end',
    fontFamily: MONO,
    color: colors.label,
  },

  /** The optional settings: one block of the panel, its rows ruled. */
  sectionGroup: {
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: REGION,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  /** One setting of the block; every one but the first is ruled from the last. */
  sectionItem: {
    boxShadow: { default: `inset 0 1px 0 ${colors.separator}`, ':first-child': 'none' },
  },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minHeight: '40px',
    paddingInlineEnd: space[2],
  },
  sectionTrigger: {
    display: 'flex',
    flexGrow: 1,
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    height: '40px',
    margin: 0,
    paddingInlineStart: space[3],
    paddingInlineEnd: 0,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    fontSize: '13px',
    fontWeight: 500,
    lineHeight: type.leading,
    textAlign: 'start',
    color: colors.label,
    cursor: 'pointer',
    outlineStyle: 'none',
  },
  sectionTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sectionCount: {
    marginInlineStart: 'auto',
    fontSize: '12px',
    fontWeight: 400,
    color: colors.tertiaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  sectionChevron: { flexShrink: 0, color: colors.tertiaryLabel },
  sectionBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    paddingInline: space[3],
    paddingBottom: space[3],
  },
  sectionHint: {
    margin: 0,
    paddingBlock: space[1],
    fontSize: '12px',
    color: colors.secondaryLabel,
  },

  /** A title-generation option: its name, then the control that sets it. */
  optionRow: {
    display: 'grid',
    gridTemplateColumns: { default: 'minmax(0, 1fr)', [SM]: '120px minmax(0, 1fr)' },
    alignItems: { default: 'stretch', [SM]: 'center' },
    gap: space[2],
  },
  optionList: { display: 'flex', flexDirection: 'column', gap: space[2], paddingTop: space[1] },
});

// =============================================================================
// Preset definitions
// =============================================================================

export const DEEPSEEK_CLAUDE_PRESET_ID = 'deepseek-over-claude-code';
export const DEEPSEEK_REASONIX_PRESET_ID = 'deepseek-reasonix';
const DEEPSEEK_OFFICIAL_BASE_URL = 'https://api.deepseek.com';
const LEGACY_DSH_MODELS_ENV = 'ACP_EXTENSION_DSH_MODELS';
type DeepSeekEndpointMode = 'official' | 'custom';
export const MIMO_CLAUDE_PRESET_ID = 'mimo-over-claude-code';
export const MINIMAX_CLAUDE_PRESET_ID = 'minimax-over-claude-code';
export const GLM_CLAUDE_PRESET_ID = 'glm-over-claude-code';
export const MIMO_PAY_AS_YOU_GO_CREDENTIAL_MODE_ID = 'pay-as-you-go';
export const MIMO_TOKEN_PLAN_CREDENTIAL_MODE_ID = 'token-plan';
const MIMO_TOKEN_PLAN_CUSTOM_BASE_URL_OPTION_ID = 'custom';
export const GLM_BIGMODEL_CREDENTIAL_MODE_ID = 'bigmodel';
export const GLM_ZAI_CREDENTIAL_MODE_ID = 'zai';

type PresetId =
  | typeof DEEPSEEK_CLAUDE_PRESET_ID
  | typeof DEEPSEEK_REASONIX_PRESET_ID
  | typeof MIMO_CLAUDE_PRESET_ID
  | typeof MINIMAX_CLAUDE_PRESET_ID
  | typeof GLM_CLAUDE_PRESET_ID;

type PresetBaseUrlOption = {
  id: string;
  labelKey: string;
  labelDefault: string;
  value: string;
};

type PresetCredentialMode = {
  id: string;
  labelKey: string;
  labelDefault: string;
  descriptionKey: string;
  descriptionDefault: string;
  tokenPrefix?: string;
  tokenLabelKey?: string;
  tokenLabelDefault?: string;
  tokenPlaceholderKey?: string;
  tokenPlaceholderDefault?: string;
  tokenHelpKey?: string;
  tokenHelpDefault?: string;
  tokenEnvKey?: string;
  fixedEnv?: Record<string, string>;
  baseUrlEnvKey?: string;
  baseUrlLabelKey?: string;
  baseUrlLabelDefault?: string;
  baseUrlHelpKey?: string;
  baseUrlHelpDefault?: string;
  baseUrlPlaceholderKey?: string;
  baseUrlPlaceholderDefault?: string;
  baseUrlOptions?: PresetBaseUrlOption[];
  defaultBaseUrlOptionId?: string;
  customBaseUrlOptionId?: string;
};

type PresetDefinition = {
  id: PresetId;
  /** Provider brand persisted onto the created agent config so its icon shows everywhere. */
  brandId: AgentBrandId;
  label: string;
  labelKey: string;
  descriptionKey: string;
  descriptionDefault: string;
  /** Underlying ACP runtime kind. */
  cliType: AgentConfigCliType;
  /** Underlying runtime agent. */
  agentType: string;
  /** Short badge shown in the left rail (e.g. "Preset"). */
  badge: string;
  /** Token field shown on the right side. */
  tokenLabelKey: string;
  tokenLabelDefault: string;
  tokenPlaceholderKey: string;
  tokenPlaceholderDefault: string;
  tokenHelpKey: string;
  tokenHelpDefault: string;
  helpUrl?: string;
  helpLinkLabelKey?: string;
  helpLinkLabelDefault?: string;
  /** Env var that stores the user-supplied token. */
  tokenEnvKey: string;
  /** Fixed env vars (other than the token) this preset injects on submit. */
  fixedEnv: Record<string, string>;
  credentialModes?: PresetCredentialMode[];
  /** Label/hint for the credential-mode chooser; defaults to MiMo-flavored copy. */
  credentialModeGroupLabelKey?: string;
  credentialModeGroupLabelDefault?: string;
  credentialModeGroupHintKey?: string;
  credentialModeGroupHintDefault?: string;
};

const DEEPSEEK_CLAUDE_PRESET: PresetDefinition = {
  id: DEEPSEEK_CLAUDE_PRESET_ID,
  brandId: 'deepseek',
  label: 'DeepSeek over Claude Code',
  labelKey: 'settings.agent.dialog.preset.deepseekClaude.label',
  descriptionKey: 'settings.agent.dialog.preset.deepseekClaude.description',
  descriptionDefault: 'Route Claude Code through DeepSeek — just paste your API token.',
  cliType: 'builtin',
  agentType: 'claude',
  badge: 'Preset',
  tokenLabelKey: 'settings.agent.dialog.preset.deepseekClaude.tokenLabel',
  tokenLabelDefault: 'DeepSeek API token',
  tokenPlaceholderKey: 'settings.agent.dialog.preset.deepseekClaude.tokenPlaceholder',
  tokenPlaceholderDefault: 'sk-XXXXXXXXXXXX',
  tokenHelpKey: 'settings.agent.dialog.preset.deepseekClaude.tokenHelp',
  tokenHelpDefault: 'Create or copy one at platform.deepseek.com.',
  tokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
  fixedEnv: {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_MODEL: 'deepseek-v4-pro[1m]',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-pro',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
  },
};

const DEEPSEEK_REASONIX_PRESET: PresetDefinition = {
  id: DEEPSEEK_REASONIX_PRESET_ID,
  brandId: 'deepseek',
  label: 'DeepSeek Reasonix',
  labelKey: 'settings.agent.dialog.preset.deepseekReasonix.label',
  descriptionKey: 'settings.agent.dialog.preset.deepseekReasonix.description',
  descriptionDefault: 'Run DeepSeek Reasonix through ACP — just paste your API token.',
  cliType: 'registry',
  agentType: 'reasonix',
  badge: 'Preset',
  tokenLabelKey: 'settings.agent.dialog.preset.deepseekReasonix.tokenLabel',
  tokenLabelDefault: 'DeepSeek API token',
  tokenPlaceholderKey: 'settings.agent.dialog.preset.deepseekReasonix.tokenPlaceholder',
  tokenPlaceholderDefault: 'sk-XXXXXXXXXXXX',
  tokenHelpKey: 'settings.agent.dialog.preset.deepseekReasonix.tokenHelp',
  tokenHelpDefault: 'Create or copy one at platform.deepseek.com.',
  tokenEnvKey: 'DEEPSEEK_API_KEY',
  fixedEnv: {},
};

const MIMO_TOKEN_PLAN_BASE_URL_OPTIONS: PresetBaseUrlOption[] = [
  {
    id: 'cn',
    labelKey: 'settings.agent.dialog.preset.mimoClaude.baseUrl.cn',
    labelDefault: 'China Cluster',
    value: 'https://token-plan-cn.xiaomimimo.com/anthropic',
  },
  {
    id: 'sgp',
    labelKey: 'settings.agent.dialog.preset.mimoClaude.baseUrl.sgp',
    labelDefault: 'Singapore Cluster',
    value: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
  },
  {
    id: 'ams',
    labelKey: 'settings.agent.dialog.preset.mimoClaude.baseUrl.ams',
    labelDefault: 'Europe Cluster',
    value: 'https://token-plan-ams.xiaomimimo.com/anthropic',
  },
  {
    id: MIMO_TOKEN_PLAN_CUSTOM_BASE_URL_OPTION_ID,
    labelKey: 'settings.agent.dialog.preset.mimoClaude.baseUrl.custom',
    labelDefault: 'Custom',
    value: '',
  },
];

const MIMO_CLAUDE_PRESET: PresetDefinition = {
  id: MIMO_CLAUDE_PRESET_ID,
  brandId: 'mimo',
  label: 'MiMo over Claude Code',
  labelKey: 'settings.agent.dialog.preset.mimoClaude.label',
  descriptionKey: 'settings.agent.dialog.preset.mimoClaude.description',
  descriptionDefault: 'Route Claude Code through Xiaomi MiMo — just paste your token.',
  cliType: 'builtin',
  agentType: 'claude',
  badge: 'Preset',
  tokenLabelKey: 'settings.agent.dialog.preset.mimoClaude.tokenLabel',
  tokenLabelDefault: 'MiMo Anthropic-compatible token',
  tokenPlaceholderKey: 'settings.agent.dialog.preset.mimoClaude.tokenPlaceholder',
  tokenPlaceholderDefault: 'Paste your Anthropic-compatible Token',
  tokenHelpKey: 'settings.agent.dialog.preset.mimoClaude.tokenHelp',
  tokenHelpDefault: 'Paste the Anthropic-compatible Token from Xiaomi MiMo.',
  helpUrl: 'https://platform.xiaomimimo.com/docs/en-US/integration/claudecode',
  helpLinkLabelKey: 'settings.agent.dialog.preset.mimoClaude.helpLink',
  helpLinkLabelDefault: 'Open MiMo Claude Code setup guide',
  tokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
  fixedEnv: {
    ANTHROPIC_MODEL: 'mimo-v2.5-pro',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.5-pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.5-pro',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  },
  credentialModes: [
    {
      id: MIMO_PAY_AS_YOU_GO_CREDENTIAL_MODE_ID,
      labelKey: 'settings.agent.dialog.preset.mimoClaude.mode.payg.label',
      labelDefault: 'Pay-as-you-go API',
      descriptionKey: 'settings.agent.dialog.preset.mimoClaude.mode.payg.description',
      descriptionDefault: 'Use an sk- API Key. Base URL is configured automatically.',
      tokenPrefix: 'sk-',
      tokenLabelKey: 'settings.agent.dialog.preset.mimoClaude.mode.payg.tokenLabel',
      tokenLabelDefault: 'MiMo API Key',
      tokenPlaceholderKey: 'settings.agent.dialog.preset.mimoClaude.mode.payg.tokenPlaceholder',
      tokenPlaceholderDefault: 'sk-xxxxx',
      tokenHelpKey: 'settings.agent.dialog.preset.mimoClaude.mode.payg.tokenHelp',
      tokenHelpDefault: 'Paste the sk- API Key from MiMo API Keys.',
      fixedEnv: {
        ANTHROPIC_BASE_URL: 'https://api.xiaomimimo.com/anthropic',
      },
    },
    {
      id: MIMO_TOKEN_PLAN_CREDENTIAL_MODE_ID,
      labelKey: 'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.label',
      labelDefault: 'Token Plan',
      descriptionKey: 'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.description',
      descriptionDefault: 'Use a tp- API Key and the Anthropic Base URL from Subscription.',
      tokenPrefix: 'tp-',
      tokenLabelKey: 'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.tokenLabel',
      tokenLabelDefault: 'MiMo Token Plan API Key',
      tokenPlaceholderKey:
        'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.tokenPlaceholder',
      tokenPlaceholderDefault: 'tp-xxxxx',
      tokenHelpKey: 'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.tokenHelp',
      tokenHelpDefault: 'Paste the tp- API Key from the MiMo Subscription page.',
      baseUrlEnvKey: 'ANTHROPIC_BASE_URL',
      baseUrlLabelKey: 'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.baseUrlLabel',
      baseUrlLabelDefault: 'Token Plan Anthropic Base URL',
      baseUrlHelpKey: 'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.baseUrlHelp',
      baseUrlHelpDefault:
        'Choose the cluster shown on Subscription, or choose Custom and paste the Anthropic-compatible Base URL.',
      baseUrlPlaceholderKey:
        'settings.agent.dialog.preset.mimoClaude.mode.tokenPlan.baseUrlPlaceholder',
      baseUrlPlaceholderDefault: 'https://token-plan-xxx.xiaomimimo.com/anthropic',
      baseUrlOptions: MIMO_TOKEN_PLAN_BASE_URL_OPTIONS,
      defaultBaseUrlOptionId: 'cn',
      customBaseUrlOptionId: MIMO_TOKEN_PLAN_CUSTOM_BASE_URL_OPTION_ID,
    },
  ],
};

const MINIMAX_CLAUDE_PRESET: PresetDefinition = {
  id: MINIMAX_CLAUDE_PRESET_ID,
  brandId: 'minimax',
  label: 'MiniMax over Claude Code',
  labelKey: 'settings.agent.dialog.preset.minimaxClaude.label',
  descriptionKey: 'settings.agent.dialog.preset.minimaxClaude.description',
  descriptionDefault: 'Route Claude Code through MiniMax — just paste your API key.',
  cliType: 'builtin',
  agentType: 'claude',
  badge: 'Preset',
  tokenLabelKey: 'settings.agent.dialog.preset.minimaxClaude.tokenLabel',
  tokenLabelDefault: 'MiniMax API key',
  tokenPlaceholderKey: 'settings.agent.dialog.preset.minimaxClaude.tokenPlaceholder',
  tokenPlaceholderDefault: 'Paste your MiniMax API key',
  tokenHelpKey: 'settings.agent.dialog.preset.minimaxClaude.tokenHelp',
  tokenHelpDefault: 'Create or copy one at platform.minimaxi.com.',
  tokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
  fixedEnv: {
    ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
    API_TIMEOUT_MS: '3000000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_MODEL: 'MiniMax-M3',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3',
  },
};

// Shared across both GLM endpoints; only ANTHROPIC_BASE_URL differs per mode.
const GLM_SHARED_ENV: Record<string, string> = {
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2[1m]',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  API_TIMEOUT_MS: '3000000',
};

const GLM_CLAUDE_PRESET: PresetDefinition = {
  id: GLM_CLAUDE_PRESET_ID,
  brandId: 'glm',
  label: 'GLM over Claude Code',
  labelKey: 'settings.agent.dialog.preset.glmClaude.label',
  descriptionKey: 'settings.agent.dialog.preset.glmClaude.description',
  descriptionDefault:
    'Route Claude Code through Zhipu GLM — pick an endpoint and paste your API key.',
  cliType: 'builtin',
  agentType: 'claude',
  badge: 'Preset',
  tokenLabelKey: 'settings.agent.dialog.preset.glmClaude.tokenLabel',
  tokenLabelDefault: 'GLM API key',
  tokenPlaceholderKey: 'settings.agent.dialog.preset.glmClaude.tokenPlaceholder',
  tokenPlaceholderDefault: 'Paste your GLM API key',
  tokenHelpKey: 'settings.agent.dialog.preset.glmClaude.tokenHelp',
  tokenHelpDefault: "Create or copy one from the selected endpoint's console.",
  tokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
  fixedEnv: GLM_SHARED_ENV,
  credentialModeGroupLabelKey: 'settings.agent.dialog.preset.glmClaude.endpointLabel',
  credentialModeGroupLabelDefault: 'Endpoint',
  credentialModeGroupHintKey: 'settings.agent.dialog.preset.glmClaude.endpointHint',
  credentialModeGroupHintDefault: 'Choose the GLM endpoint that matches your API key.',
  credentialModes: [
    {
      id: GLM_BIGMODEL_CREDENTIAL_MODE_ID,
      labelKey: 'settings.agent.dialog.preset.glmClaude.mode.bigmodel.label',
      labelDefault: 'bigmodel.cn (Zhipu)',
      descriptionKey: 'settings.agent.dialog.preset.glmClaude.mode.bigmodel.description',
      descriptionDefault: 'Zhipu BigModel open platform (China).',
      tokenLabelKey: 'settings.agent.dialog.preset.glmClaude.mode.bigmodel.tokenLabel',
      tokenLabelDefault: 'Zhipu API key',
      tokenHelpKey: 'settings.agent.dialog.preset.glmClaude.mode.bigmodel.tokenHelp',
      tokenHelpDefault: 'Create or copy one at open.bigmodel.cn.',
      fixedEnv: {
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      },
    },
    {
      id: GLM_ZAI_CREDENTIAL_MODE_ID,
      labelKey: 'settings.agent.dialog.preset.glmClaude.mode.zai.label',
      labelDefault: 'z.ai',
      descriptionKey: 'settings.agent.dialog.preset.glmClaude.mode.zai.description',
      descriptionDefault: 'Z.ai international endpoint.',
      tokenLabelKey: 'settings.agent.dialog.preset.glmClaude.mode.zai.tokenLabel',
      tokenLabelDefault: 'z.ai API key',
      tokenHelpKey: 'settings.agent.dialog.preset.glmClaude.mode.zai.tokenHelp',
      tokenHelpDefault: 'Create or copy one at z.ai.',
      fixedEnv: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      },
    },
  ],
};

const PRESETS: PresetDefinition[] = [
  DEEPSEEK_CLAUDE_PRESET,
  DEEPSEEK_REASONIX_PRESET,
  MIMO_CLAUDE_PRESET,
  MINIMAX_CLAUDE_PRESET,
  GLM_CLAUDE_PRESET,
];
const PRESETS_BY_ID: Record<string, PresetDefinition> = Object.fromEntries(
  PRESETS.map((p) => [p.id, p])
);

// =============================================================================
// Agent type options (left rail)
// =============================================================================

type AgentTypeOption = {
  kind: 'builtin' | 'preset' | 'registry' | 'custom';
  value: string;
  label: string;
  description?: string;
  labelKey?: string;
  descriptionKey?: string;
  descriptionDefault?: string;
  cliType: AgentConfigCliType;
  agentType: string;
  presetId?: PresetId;
  experimental?: boolean;
  searchKeys: string;
};

const BUILTIN_OPTIONS: AgentTypeOption[] = [
  {
    kind: 'builtin',
    value: 'builtin:kimi',
    label: 'Kimi Code',
    descriptionKey: 'settings.agent.dialog.option.kimi.description',
    descriptionDefault: 'Moonshot AI Kimi Code runtime',
    cliType: 'builtin',
    agentType: 'kimi',
    searchKeys: 'kimi moonshot',
  },
  {
    kind: 'builtin',
    value: 'builtin:grok',
    label: 'Grok',
    descriptionDefault: 'xAI Grok coding agent runtime',
    cliType: 'builtin',
    agentType: 'grok',
    searchKeys: 'grok xai',
  },
  {
    kind: 'builtin',
    value: 'builtin:claude',
    label: 'Claude',
    descriptionKey: 'settings.agent.dialog.option.claude.description',
    descriptionDefault: 'Anthropic Claude Code runtime',
    cliType: 'builtin',
    agentType: 'claude',
    searchKeys: 'claude anthropic',
  },
  {
    kind: 'builtin',
    value: 'builtin:codex',
    label: 'Codex',
    descriptionKey: 'settings.agent.dialog.option.codex.description',
    descriptionDefault: 'OpenAI Codex runtime',
    cliType: 'builtin',
    agentType: 'codex',
    searchKeys: 'codex openai',
  },
  {
    kind: 'builtin',
    value: 'builtin:deepseek',
    label: 'DeepSeek Harness',
    descriptionKey: 'settings.agent.dialog.option.deepseek.description',
    descriptionDefault: 'DeepSeek coding agent over ACP (developer preview)',
    cliType: 'builtin',
    agentType: 'deepseek',
    experimental: true,
    searchKeys: 'deepseek harness dsh acp',
  },
  {
    kind: 'builtin',
    value: 'builtin:pi',
    label: 'Pi',
    descriptionKey: 'settings.agent.dialog.option.pi.description',
    descriptionDefault: 'Lody-managed Pi ACP runtime',
    cliType: 'builtin',
    agentType: 'pi',
    searchKeys: 'pi acp',
  },
  {
    kind: 'builtin',
    value: 'builtin:dimcode',
    label: 'Dimcode',
    descriptionKey: 'settings.agent.dialog.option.dimcode.description',
    descriptionDefault: 'Dimcode coding agent over ACP',
    cliType: 'builtin',
    agentType: 'dimcode',
    searchKeys: 'dimcode dim dimagent acp',
  },
  {
    kind: 'builtin',
    value: 'builtin:bub',
    label: 'Bub',
    descriptionKey: 'settings.agent.dialog.option.bub.description',
    descriptionDefault: 'Bub agent runtime over ACP (install the bub-acp-server plugin)',
    cliType: 'builtin',
    agentType: 'bub',
    searchKeys: 'bub bubbuild acp',
  },
];

const PRESET_OPTIONS: AgentTypeOption[] = PRESETS.map((p) => ({
  kind: 'preset' as const,
  value: `preset:${p.id}`,
  label: p.label,
  labelKey: p.labelKey,
  descriptionKey: p.descriptionKey,
  descriptionDefault: p.descriptionDefault,
  cliType: p.cliType,
  agentType: p.agentType,
  presetId: p.id,
  searchKeys: `${p.label} ${p.id} ${p.descriptionDefault} ${p.tokenLabelDefault}`,
}));

const REGISTRY_OPTIONS: AgentTypeOption[] = REGISTRY_ACP_AGENTS.map((a) => ({
  kind: 'registry' as const,
  value: `registry:${a.id}`,
  label: a.name,
  description: a.description ?? undefined,
  cliType: 'registry' as AgentConfigCliType,
  agentType: a.id,
  experimental: true,
  searchKeys: `${a.name} ${a.id} ${a.description ?? ''}`.toLowerCase(),
}));

// Custom agents still need a stable provider slug for session launch metadata;
// capability cache isolation itself is handled by the agent config id.
const CUSTOM_OPTION: AgentTypeOption = {
  kind: 'custom',
  value: 'custom',
  label: 'Custom command',
  labelKey: 'settings.agent.dialog.option.custom.label',
  descriptionKey: 'settings.agent.dialog.option.custom.description',
  descriptionDefault: 'Run any ACP-compatible agent with your own command',
  cliType: 'custom',
  agentType: '',
  searchKeys: 'custom command local executable acp',
};

const ALL_OPTIONS: AgentTypeOption[] = [
  ...BUILTIN_OPTIONS,
  ...PRESET_OPTIONS,
  CUSTOM_OPTION,
  ...REGISTRY_OPTIONS,
];

// =============================================================================
// Form data
// =============================================================================

export type AgentConfigFormData = {
  name: string;
  cliType: AgentConfigCliType;
  agentType: string;
  /** Raw command line the user typed for custom providers; parsed on submit. */
  customCommandLine?: string;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  prompt: string;
  env: Record<string, string>;
  titleGeneration?: TitleGenerationConfig;
  presetId?: PresetId;
  presetToken?: string;
  presetCredentialModeId?: string;
  presetBaseUrlOptionId?: string;
  presetBaseUrl?: string;
  /** Dialog.Root-only DeepSeek Harness endpoint tab; never persisted on AgentConfigMeta. */
  deepseekEndpointMode?: DeepSeekEndpointMode;
  /** Draft custom DEEPSEEK_BASE_URL while the official tab is selected. */
  deepseekCustomBaseUrl?: string;
};

export type AgentConfigSubmitPayload = {
  id: AgentConfigId;
  name: string;
  cliType: AgentConfigCliType;
  agentType: AgentType;
  /** Parsed launch spec for `cliType: 'custom'` configs. */
  customAcp?: CustomAcpLaunchSpec;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  prompt: string;
  env: Record<string, string>;
  titleGeneration?: TitleGenerationConfig;
  description: string | undefined;
  /** Provider brand for preset-created configs; drives the agent's icon. */
  brandId?: AgentBrandId;
  /** Persist as a durable target-machine setup instead of publishing immediately. */
  backgroundSetup?: true;
};

export type AgentConfigDialogMode =
  | { kind: 'create'; initialForm?: Partial<AgentConfigFormData> }
  | { kind: 'edit'; config: AgentConfigMeta };

type RefreshArgs = {
  machineId: MachineId;
  configId: AgentConfigId;
};

/** Whether a registry agent's platform binary is present on the target machine. */
export type AgentBinaryInstallStatus =
  | 'not-applicable'
  | 'unsupported-platform'
  | 'incompatible-host'
  | 'not-installed'
  | 'installed';

type AgentBinaryRuntimeStatus =
  | AgentBinaryInstallStatus
  | MachineAcpBinaryProgressMessage['status'];

export type BinaryActionArgs = {
  machineId: MachineId;
  agentType: string;
};

export type AgentConfigDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Render above an already-open dialog, such as the desktop settings modal. */
  nestedInDialog?: boolean;
  mode: AgentConfigDialogMode;
  machine: MachineViewMeta;
  onSubmit: (payload: AgentConfigSubmitPayload) => Promise<void>;
  onRefreshCapabilities: (args: RefreshArgs) => Promise<MachineAcpCapabilitiesRefreshResponse>;
  onScanPiExtensions?: (args: {
    machineId: MachineId;
    configId?: AgentConfigId;
  }) => Promise<MachinePiExtensionsResponse>;
  /** Check a registry binary or managed builtin runtime on the target machine. */
  onCheckBinaryStatus?: (
    args: BinaryActionArgs
  ) => Promise<
    Pick<MachineAcpBinaryStatusResponse, 'status' | 'command' | 'version' | 'current' | 'required'>
  >;
  /** Download + unpack the agent's platform binary. Rejects on failure. */
  onInstallBinary?: (args: BinaryActionArgs) => Promise<void>;
  /** Raise the selected managed runtime above onboarding's background queue. */
  onManagedRuntimeSelected?: (agentType: ManagedBuiltinAgentType) => void;
};

const DEFAULT_FORM: AgentConfigFormData = {
  name: '',
  cliType: 'builtin',
  agentType: 'kimi',
  prompt: '',
  env: {},
};

function getPresetCredentialMode(
  preset: PresetDefinition,
  credentialModeId?: string
): PresetCredentialMode | undefined {
  const modes = preset.credentialModes ?? [];
  if (modes.length === 0) return undefined;
  return modes.find((mode) => mode.id === credentialModeId) ?? modes[0];
}

function getBaseUrlOption(
  mode: PresetCredentialMode | undefined,
  optionId?: string
): PresetBaseUrlOption | undefined {
  const options = mode?.baseUrlOptions ?? [];
  if (options.length === 0) return undefined;
  const defaultOption =
    options.find((option) => option.id === mode?.defaultBaseUrlOptionId) ?? options[0];
  return options.find((option) => option.id === optionId) ?? defaultOption;
}

function getDefaultBaseUrlOptionId(mode: PresetCredentialMode | undefined): string | undefined {
  return getBaseUrlOption(mode)?.id;
}

/**
 * Build the create-mode initial form for a preset chosen from outside the dialog
 * (e.g. the onboarding agent showcase). Mirrors {@link selectOption}'s preset
 * branch so the dialog opens straight on the preset's token form, with the
 * default credential mode / base URL seeded. Returns an empty patch for an
 * unknown id.
 */
export function buildPresetCreateForm(presetId: string): Partial<AgentConfigFormData> {
  const preset = PRESETS_BY_ID[presetId];
  if (!preset) return {};
  const credentialMode = getPresetCredentialMode(preset, undefined);
  return {
    name: preset.label,
    cliType: preset.cliType,
    agentType: preset.agentType,
    presetId: preset.id,
    presetCredentialModeId: credentialMode?.id,
    presetBaseUrlOptionId: getDefaultBaseUrlOptionId(credentialMode),
  };
}

function resolveCredentialModeBaseUrl(
  mode: PresetCredentialMode | undefined,
  optionId?: string,
  customBaseUrl?: string
): string {
  if (!mode?.baseUrlEnvKey) return '';
  const option = getBaseUrlOption(mode, optionId);
  if (!option) return '';
  if (option.id === mode.customBaseUrlOptionId) return customBaseUrl?.trim() ?? '';
  return option.value;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isDeepSeekBuiltinForm(form: Pick<AgentConfigFormData, 'cliType' | 'agentType'>): boolean {
  return form.cliType === 'builtin' && form.agentType === 'deepseek';
}

function getDeepSeekEndpointMode(form: AgentConfigFormData): DeepSeekEndpointMode {
  return form.deepseekEndpointMode === 'custom' ? 'custom' : 'official';
}

/**
 * Official DeepSeek API, including trailing slashes and a bare `/v1` path.
 * Other hosts, ports, query strings, or extra path segments are custom.
 */
function isDeepSeekOfficialBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    if (url.hostname.toLowerCase() !== 'api.deepseek.com') return false;
    if (url.port !== '' && url.port !== '443') return false;
    if (url.search !== '' || url.hash !== '') return false;
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    return path === '' || path === '/v1';
  } catch {
    return false;
  }
}

function resolveDeepSeekEndpointForm(
  env: Record<string, string>,
  explicit?: Pick<AgentConfigFormData, 'deepseekEndpointMode' | 'deepseekCustomBaseUrl'>
): Pick<AgentConfigFormData, 'deepseekEndpointMode' | 'deepseekCustomBaseUrl'> {
  if (
    explicit?.deepseekEndpointMode === 'official' ||
    explicit?.deepseekEndpointMode === 'custom'
  ) {
    return {
      deepseekEndpointMode: explicit.deepseekEndpointMode,
      deepseekCustomBaseUrl: explicit.deepseekCustomBaseUrl ?? '',
    };
  }
  const stored = env[DEEPSEEK_HARNESS_BASE_URL_ENV];
  if (!stored?.trim() || isDeepSeekOfficialBaseUrl(stored)) {
    return { deepseekEndpointMode: 'official', deepseekCustomBaseUrl: '' };
  }
  return { deepseekEndpointMode: 'custom', deepseekCustomBaseUrl: stored };
}

function omitDeepSeekProtectedEnv(env: Record<string, string>): Record<string, string> {
  const additionalEnv = { ...env };
  delete additionalEnv[DEEPSEEK_HARNESS_API_KEY_ENV];
  delete additionalEnv[DEEPSEEK_HARNESS_BASE_URL_ENV];
  delete additionalEnv[LEGACY_DSH_MODELS_ENV];
  return additionalEnv;
}

function hydrateDeepSeekEndpointForm(form: AgentConfigFormData): AgentConfigFormData {
  if (!isDeepSeekBuiltinForm(form)) return form;
  const env = { ...form.env };
  const resolved = resolveDeepSeekEndpointForm(env, form);
  delete env[DEEPSEEK_HARNESS_BASE_URL_ENV];
  delete env[LEGACY_DSH_MODELS_ENV];
  return {
    ...form,
    env,
    deepseekEndpointMode: resolved.deepseekEndpointMode,
    deepseekCustomBaseUrl: resolved.deepseekCustomBaseUrl,
  };
}

function buildDeepSeekSubmitEnv(formData: AgentConfigFormData): Record<string, string> {
  const env = omitDeepSeekProtectedEnv(formData.env);
  const apiKey = formData.env[DEEPSEEK_HARNESS_API_KEY_ENV]?.trim();
  if (apiKey) {
    env[DEEPSEEK_HARNESS_API_KEY_ENV] = apiKey;
  } else {
    delete env[DEEPSEEK_HARNESS_API_KEY_ENV];
  }
  env[DEEPSEEK_HARNESS_BASE_URL_ENV] =
    getDeepSeekEndpointMode(formData) === 'custom'
      ? (formData.deepseekCustomBaseUrl ?? '').trim()
      : DEEPSEEK_OFFICIAL_BASE_URL;
  return env;
}

function getPresetTokenEnvKey(
  preset: PresetDefinition,
  mode: PresetCredentialMode | undefined
): string {
  return mode?.tokenEnvKey ?? preset.tokenEnvKey;
}

function buildPresetEnv(
  preset: PresetDefinition,
  mode: PresetCredentialMode | undefined,
  formData: AgentConfigFormData
): Record<string, string> {
  const env = {
    ...formData.env,
    ...preset.fixedEnv,
    ...(mode?.fixedEnv ?? {}),
  };
  if (mode?.baseUrlEnvKey) {
    env[mode.baseUrlEnvKey] = resolveCredentialModeBaseUrl(
      mode,
      formData.presetBaseUrlOptionId,
      formData.presetBaseUrl
    );
  }
  env[getPresetTokenEnvKey(preset, mode)] = (formData.presetToken ?? '').trim();
  return env;
}

// Presets skip the capability-probe + title-generation form path that built-in
// agents use, so `formData.titleGeneration` is never populated through the UI.
// Without this, saving a preset agent persists `titleGeneration: undefined`
// and chatting with it later fails the "title generation not configured" gate
// in chat-landing. Use the same static built-in defaults the CLI applies in
// `createAgentConfig` so preset agents work immediately on the first turn,
// before the CLI's capability-probe backfill has a chance to run.
function buildPresetTitleGeneration(
  cliType: AgentConfigCliType,
  agentType: AgentType,
  existing: TitleGenerationConfig | undefined
): TitleGenerationConfig | undefined {
  const existingValues = existing?.configOptionValues;
  if (existingValues && Object.keys(existingValues).length > 0) {
    return existing;
  }
  if (cliType !== 'builtin') return existing;
  const defaults = getBuiltinTitleGenerationDefaults(agentType);
  if (!defaults || Object.keys(defaults).length === 0) return existing;
  return { ...existing, configOptionValues: defaults };
}

function buildPresetInjectedEnvPreview(
  preset: PresetDefinition,
  mode: PresetCredentialMode | undefined,
  formData: AgentConfigFormData
): Record<string, string> {
  const env = {
    ...preset.fixedEnv,
    ...(mode?.fixedEnv ?? {}),
  };
  if (mode?.baseUrlEnvKey) {
    env[mode.baseUrlEnvKey] = resolveCredentialModeBaseUrl(
      mode,
      formData.presetBaseUrlOptionId,
      formData.presetBaseUrl
    );
  }
  return env;
}

// For an existing custom config, returns the command "key" to pre-seed as
// already-tested IFF the machine still has current cached capabilities whose
// source version matches the saved command (same derivation the CLI uses in
// getAcpCapabilitySourceVersion). Returns null otherwise, forcing a re-test.
function resolveInitialTestedCustomKey(
  mode: AgentConfigDialogMode,
  machine: MachineViewMeta
): string | null {
  if (mode.kind !== 'edit') return null;
  const config = mode.config;
  if (config.cliType !== 'custom' || !config.customAcp) return null;
  const entry = machine.acpCapabilities?.[getAcpCapabilityCacheKey(config.id)];
  if (!isAcpCapabilityCacheEntryCurrent(entry)) return null;
  if (entry.sourceVersion !== `custom:${serializeCustomAcpLaunchSpec(config.customAcp)}`) {
    return null;
  }
  return formatCustomAcpCommandLine(config.customAcp);
}

// =============================================================================
// Main dialog
// =============================================================================

export function AgentConfigDialog(props: AgentConfigDialogProps) {
  const {
    open,
    onOpenChange,
    nestedInDialog = false,
    mode,
    machine,
    onSubmit,
    onRefreshCapabilities,
    onScanPiExtensions,
    onCheckBinaryStatus,
    onInstallBinary,
    onManagedRuntimeSelected,
  } = props;
  const { t } = useTranslation();
  const draftConfigIdRef = useRef<AgentConfigId | null>(null);
  const agentConfigId =
    mode.kind === 'edit'
      ? mode.config.id
      : (draftConfigIdRef.current ??= uuidv4() as AgentConfigId);
  const publishedConfig = useAtomValue(getAgentMetaByIdAtomFamily(agentConfigId));
  const setups = useAtomValue(getProviderSetupsByMachineAtomFamily(machine.id));
  const retrySetup = useSetAtom(cmdRetryProviderSetupAtom);
  const deleteSetup = useSetAtom(deleteProviderSetupAtom);
  // Creation observes the daemon-owned setup instead of launching a competing
  // capability probe. Once published, this draft edits the same provider id.
  const [testingBuiltinSetup, setTestingBuiltinSetup] = useState(false);
  const publishedSetupConfig =
    testingBuiltinSetup &&
    publishedConfig?.machineId === machine.id &&
    publishedConfig.cliType === 'builtin' &&
    (publishedConfig.agentType === 'bub' || publishedConfig.agentType === 'dimcode');
  const builtinSetup = testingBuiltinSetup
    ? setups.find((setup) => setup.id === agentConfigId)
    : undefined;
  const waitingForBuiltinSetup = testingBuiltinSetup && !publishedSetupConfig;

  const initialForm = useMemo<AgentConfigFormData>(() => {
    if (mode.kind === 'edit') {
      return hydrateDeepSeekEndpointForm({
        name: mode.config.name,
        cliType: mode.config.cliType,
        agentType: mode.config.agentType,
        customCommandLine: mode.config.customAcp
          ? formatCustomAcpCommandLine(mode.config.customAcp)
          : undefined,
        runtimeOverrides: mode.config.runtimeOverrides,
        prompt: mode.config.prompt ?? '',
        env: mode.config.env || {},
        titleGeneration: mode.config.titleGeneration,
      });
    }
    return hydrateDeepSeekEndpointForm({ ...DEFAULT_FORM, ...mode.initialForm });
  }, [mode]);

  const [formData, setFormData] = useState<AgentConfigFormData>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [manuallyTested, setManuallyTested] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [probeTick, setProbeTick] = useState(0);
  // Creation of a built-in provider is gated on a live probe for the exact
  // target machine + auth-affecting form revision. Cached capabilities make the
  // form renderable, but they do not prove that credentials still exist.
  const [builtinVerificationRevision, setBuiltinVerificationRevision] = useState(0);
  const [verifiedBuiltinContext, setVerifiedBuiltinContext] = useState<string | null>(null);
  const [pendingCreateBuiltinContext, setPendingCreateBuiltinContext] = useState<string | null>(
    null
  );
  // Custom providers probe manually only (the command doesn't exist until the
  // user types it), so readiness is tracked per the exact command that was
  // last tested. Editing the command clears readiness until it is re-tested,
  // because a config-id cache row can still be stale after an unsaved command edit.
  const [testedCustomKey, setTestedCustomKey] = useState<string | null>(null);
  // Bind the resolved status to the agent it was computed for. A bare status
  // state would, on switching from a non-binary (or already-installed) provider
  // to a different binary-only agent, briefly read as ready before the per-agent
  // check runs — letting the capability probe (and its implicit ensureBinary
  // download) fire and bypass the explicit Download confirmation. Deriving the
  // status only when `agentType` matches forces 'unknown' (not ready) across the
  // switch until the new agent is actually checked.
  const [binaryState, setBinaryState] = useState<{
    agentType: string;
    status: AgentBinaryRuntimeStatus;
    downloadedBytes?: number;
    totalBytes?: number;
    percent?: number;
    version?: string;
    command?: string;
    current?: string;
    required?: string;
    error?: string;
  } | null>(null);
  const workspaceRuntime = useAtomValue(activeWorkspaceRuntimeAtom);
  const liveBinaryState = useMachineAcpBinaryProgress(
    workspaceRuntime,
    machine.id,
    formData.agentType
  );
  const effectiveBinaryState = liveBinaryState ?? binaryState;
  const [installingBinary, setInstallingBinary] = useState(false);
  const [binaryError, setBinaryError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // For narrow viewports we run a 2-step flow: pick a type, then configure.
  // Edit mode skips the picker because the type is locked.
  const [mobileView, setMobileView] = useState<'picker' | 'form'>(
    mode.kind === 'edit' ? 'form' : 'picker'
  );
  const isNarrowLayout = useNarrowDialogLayout();
  const titleDefaultsAppliedRef = useRef(false);
  const formScrollRef = useRef<HTMLDivElement>(null);
  const machineRef = useRef(machine);
  machineRef.current = machine;
  useKeyboardAwareScrollIntoView(formScrollRef);

  useEffect(() => {
    if (open) {
      setTestingBuiltinSetup(false);
      setFormData(initialForm);
      setManuallyTested(false);
      setAuthRequired(false);
      setProbeError(null);
      setProbeTick(0);
      setBuiltinVerificationRevision((revision) => revision + 1);
      setVerifiedBuiltinContext(null);
      setPendingCreateBuiltinContext(null);
      setBinaryState(null);
      setInstallingBinary(false);
      setBinaryError(null);
      setQuery('');
      setMobileView(mode.kind === 'edit' ? 'form' : 'picker');
      titleDefaultsAppliedRef.current = false;
      // For an existing custom config whose cached capabilities still match the
      // saved command, pre-seed the tested key so a minor edit (e.g. the name)
      // doesn't force a re-test. Any other case starts un-tested.
      setTestedCustomKey(resolveInitialTestedCustomKey(mode, machineRef.current));
    }
  }, [open, initialForm, mode, machine.id]);

  const activePreset = formData.presetId ? PRESETS_BY_ID[formData.presetId] : undefined;
  const isPreset = !!activePreset;

  const activeCredentialMode = activePreset
    ? getPresetCredentialMode(activePreset, formData.presetCredentialModeId)
    : undefined;
  // Prefer the active preset's brand; on edit (where the preset isn't
  // re-detected) preserve the brand already persisted on the config so an
  // unrelated edit doesn't strip it. MiMo's custom token-plan base URL can't
  // be recovered from env, so the persisted value is the source of truth.
  const resolvedBrandId =
    activePreset?.brandId ?? (mode.kind === 'edit' ? mode.config.brandId : undefined);

  const isCustom = formData.cliType === 'custom';
  const isDeepSeekBuiltin = isDeepSeekBuiltinForm(formData);
  // Bub is builtin but user-installed, so there is no managed runtime to
  // prepare. It still must pass a live probe on create: that is how a missing
  // `bub acp` becomes an actionable "install Bub" prompt instead of a
  // provider that fails later on its first turn.
  const isBubBuiltin = formData.cliType === 'builtin' && formData.agentType === 'bub';
  const isQueuedBuiltin =
    isBubBuiltin || (formData.cliType === 'builtin' && formData.agentType === 'dimcode');
  const deepseekEndpointMode = getDeepSeekEndpointMode(formData);
  const isManagedBuiltin =
    formData.cliType === 'builtin' && isManagedBuiltinAgentType(formData.agentType);
  const builtinVerificationContext = `${machine.id}:${builtinVerificationRevision}`;
  const requiresBuiltinCreationVerification =
    mode.kind === 'create' &&
    !publishedSetupConfig &&
    !isPreset &&
    (isManagedBuiltin || isDeepSeekBuiltin || isQueuedBuiltin);
  const builtinCreationVerified =
    !requiresBuiltinCreationVerification || verifiedBuiltinContext === builtinVerificationContext;
  const builtinCreationPending =
    requiresBuiltinCreationVerification &&
    !builtinCreationVerified &&
    pendingCreateBuiltinContext === builtinVerificationContext;
  // Editing an existing provider offers "Sign in again" whenever the provider
  // has a login of its own to run — this dialog is where re-authentication
  // lives, but preset / env-credential providers (DeepSeek, MiniMax, MiMo, GLM,
  // or a hand-rolled endpoint override) authenticate purely through env vars,
  // so a sign-in would do nothing for them. Creating one only surfaces the
  // panel when a live probe reported missing credentials, because that panel is
  // the single way to unblock the creation-time verification gate.
  // Registry and custom providers authenticate through the standard ACP
  // exchange, but only the agent knows whether it has anything to sign into —
  // so their panel appears once a live probe reported that auth is required.
  // The exchange runs entirely on the daemon, so a machine that predates it
  // answers "Authentication is not supported"; do not offer a button that can
  // only fail.
  const usesProtocolAuthentication =
    usesAcpProtocolAuthentication(formData.cliType) &&
    machineSupportsAcpProtocolAuthentication(machine);
  const showAuthenticationPanel =
    mode.kind === 'edit'
      ? supportsBuiltinAuthentication({
          cliType: formData.cliType,
          agentType: formData.agentType,
          brandId: resolvedBrandId,
          env: formData.env,
        }) ||
        (authRequired && usesProtocolAuthentication)
      : authRequired &&
        ((isManagedBuiltin && formData.agentType !== 'pi') || usesProtocolAuthentication);
  const builtinRuntimeOverrideKey =
    formData.cliType !== 'builtin'
      ? null
      : formData.agentType === 'codex'
        ? 'codexPath'
        : formData.agentType === 'claude'
          ? 'claudeCodeExecutable'
          : formData.agentType === 'kimi'
            ? 'kimiPath'
            : formData.agentType === 'grok'
              ? 'grokPath'
              : null;
  const builtinRuntimeOverrideValue = builtinRuntimeOverrideKey
    ? (formData.runtimeOverrides?.[builtinRuntimeOverrideKey] ?? '')
    : '';
  const hasBuiltinRuntimeOverride = builtinRuntimeOverrideValue.trim().length > 0;
  const parsedCustomAcp = useMemo(
    () => (isCustom ? parseCustomAcpCommandLine(formData.customCommandLine ?? '') : null),
    [isCustom, formData.customCommandLine]
  );
  // Canonical form of the parsed command; probe effect keys on this so edits
  // that don't change the parsed argv (extra whitespace) don't re-probe.
  const customAcpKey = parsedCustomAcp ? formatCustomAcpCommandLine(parsedCustomAcp) : '';

  const cacheKey = getAcpCapabilityCacheKey(agentConfigId);
  const configCapability = machine.acpCapabilities?.[cacheKey];
  const cachedCapabilityAuthority = getAcpCapabilityCacheEntryAuthority(
    configCapability?.cliType === formData.cliType &&
      configCapability.agentType === formData.agentType
      ? configCapability
      : undefined,
    formData.runtimeOverrides
  );
  const acpProvidesSessionTitle = acpOwnsSessionTitleGeneration(
    formData.cliType,
    formData.agentType,
    formData.runtimeOverrides,
    cachedCapabilityAuthority !== 'unavailable' &&
      (!isCustom ||
        (!!parsedCustomAcp &&
          configCapability?.sourceVersion ===
            `custom:${serializeCustomAcpLaunchSpec(parsedCustomAcp)}`)) &&
      configCapability?.sessionTitle === true
  );
  const hasCachedCaps =
    formData.cliType === 'builtin' && formData.agentType === 'kimi'
      ? cachedCapabilityAuthority === 'authoritative'
      : cachedCapabilityAuthority !== 'unavailable';
  const hasStaticBuiltinCaps =
    (getStaticBuiltinAcpCapabilities(
      formData.cliType,
      formData.agentType,
      formData.runtimeOverrides
    )?.configOptions.length ?? 0) > 0;
  // Registry binary-only agents must be present before this dialog probes a live
  // agent. Built-in Codex/Claude download their managed runtime during refresh, so
  // the dialog should surface progress without blocking the initial selection.
  const binaryRequired = useMemo(() => {
    if (isPreset) return false;
    if (formData.cliType === 'builtin') {
      return false;
    }
    if (formData.cliType !== 'registry') return false;
    const agent = REGISTRY_ACP_AGENTS.find((a) => a.id === formData.agentType);
    return agent ? getRegistryAcpLaunchKind(agent.distribution) === 'binary' : false;
  }, [isPreset, formData.cliType, formData.agentType]);
  const binaryStatus: 'unknown' | AgentBinaryRuntimeStatus =
    effectiveBinaryState && effectiveBinaryState.agentType === formData.agentType
      ? effectiveBinaryState.status
      : 'unknown';
  const usesDefaultManagedRuntime =
    formData.cliType === 'builtin' &&
    isManagedBuiltinAgentType(formData.agentType) &&
    !hasBuiltinRuntimeOverride;
  // Deferring hands the target daemon a durable `providerSetup` row, so it is
  // only safe once that daemon advertises the protocol. Derived here rather
  // than passed in: every host already gives us the target machine, and a
  // per-caller flag can disagree with the machine it travels with.
  const supportsProviderSetup = machineSupportsProviderSetupProtocol(machine);
  // providerSetup rows only launch the default managed runtime; any override
  // (a custom path or selected Pi extensions) must take the live-probe path.
  const backgroundBuiltinSetup =
    supportsProviderSetup &&
    requiresBuiltinCreationVerification &&
    (usesDefaultManagedRuntime || isQueuedBuiltin) &&
    !hasBuiltinRuntimeOverrideValues(formData.runtimeOverrides);
  const lastPersistedPayloadKeyRef = useRef<string | null>(null);
  const postHog = usePostHog();
  // Analytics only: whether a custom DeepSeek Harness base URL is saved. The URL
  // itself never leaves the client; only the boolean flip is reported.
  const deepSeekCustomBaseUrlConfiguredRef = useRef(
    isDeepSeekBuiltinForm(initialForm) && getDeepSeekEndpointMode(initialForm) === 'custom'
  );
  const buildSubmitPayload = useCallback((): AgentConfigSubmitPayload => {
    let env = { ...formData.env };
    if (activePreset) {
      env = buildPresetEnv(activePreset, activeCredentialMode, formData);
    } else if (isDeepSeekBuiltinForm(formData)) {
      env = buildDeepSeekSubmitEnv(formData);
    }
    const agentType = formData.agentType as AgentType;
    const titleGeneration = acpProvidesSessionTitle
      ? undefined
      : isPreset
        ? buildPresetTitleGeneration(formData.cliType, agentType, formData.titleGeneration)
        : formData.titleGeneration;
    return {
      id: agentConfigId,
      name: formData.name.trim(),
      cliType: formData.cliType,
      agentType,
      customAcp: isCustom ? (parsedCustomAcp ?? undefined) : undefined,
      runtimeOverrides: formData.runtimeOverrides,
      prompt: formData.prompt,
      env,
      titleGeneration,
      description: undefined,
      brandId: resolvedBrandId,
      ...(backgroundBuiltinSetup ? { backgroundSetup: true } : {}),
    };
  }, [
    activeCredentialMode,
    activePreset,
    acpProvidesSessionTitle,
    agentConfigId,
    backgroundBuiltinSetup,
    formData,
    isCustom,
    isPreset,
    parsedCustomAcp,
    resolvedBrandId,
  ]);
  const persistConfigBeforeMachineLaunch = useCallback(async (): Promise<void> => {
    const payload = buildSubmitPayload();
    const payloadKey = JSON.stringify(payload);
    if (lastPersistedPayloadKeyRef.current === payloadKey) return;
    await onSubmit(payload);
    lastPersistedPayloadKeyRef.current = payloadKey;
    if (isDeepSeekBuiltinForm(formData)) {
      const configured = !isDeepSeekOfficialBaseUrl(payload.env[DEEPSEEK_HARNESS_BASE_URL_ENV]);
      if (configured !== deepSeekCustomBaseUrlConfiguredRef.current) {
        deepSeekCustomBaseUrlConfiguredRef.current = configured;
        capturePostHogEvent(postHog, 'settings/changed', {
          key: 'deepseek_harness_custom_base_url',
          value: configured,
        });
      }
    }
  }, [buildSubmitPayload, formData, onSubmit, postHog]);

  useEffect(() => {
    if (
      !open ||
      mode.kind !== 'create' ||
      !usesDefaultManagedRuntime ||
      !isManagedBuiltinAgentType(formData.agentType)
    ) {
      return;
    }
    onManagedRuntimeSelected?.(formData.agentType);
  }, [formData.agentType, mode.kind, onManagedRuntimeSelected, open, usesDefaultManagedRuntime]);
  const binaryReady =
    !binaryRequired || binaryStatus === 'installed' || binaryStatus === 'not-applicable';
  const binaryStatusBlocksReady =
    (binaryRequired && !binaryReady) ||
    (usesDefaultManagedRuntime &&
      binaryStatus !== 'unknown' &&
      binaryStatus !== 'installed' &&
      binaryStatus !== 'not-applicable');
  // Custom: ready only when the exact current command has been tested this
  // session (cache can't be trusted alone — its key doesn't move with the
  // command). Builtin/registry: ready on cache hit, static builtin defaults, or
  // a manual probe, unless a live runtime check just proved the managed binary
  // is missing/outdated.
  const customReady = !!parsedCustomAcp && testedCustomKey === customAcpKey;
  const rawCapabilitiesReady = isCustom
    ? customReady
    : manuallyTested ||
      publishedSetupConfig ||
      hasCachedCaps ||
      (hasStaticBuiltinCaps && !(formData.cliType === 'builtin' && formData.agentType === 'kimi'));
  const capabilitiesReady = rawCapabilitiesReady && !binaryStatusBlocksReady;
  // Static builtin capabilities make the form usable before a runtime probe,
  // but they do not prove that the provider has local credentials. Keep a
  // visible Test action until a real probe (or authoritative cache entry) has
  // checked sign-in, so missing credentials can be resolved inside this dialog.
  const builtinNeedsCredentialCheck =
    isManagedBuiltin &&
    (requiresBuiltinCreationVerification
      ? !builtinCreationVerified
      : !manuallyTested && !hasCachedCaps);
  const binaryProgressActive =
    binaryStatus === 'checking' ||
    binaryStatus === 'downloading' ||
    binaryStatus === 'verifying' ||
    binaryStatus === 'extracting' ||
    binaryStatus === 'publishing';
  const showBinaryPanel =
    (binaryRequired && !binaryReady) ||
    (usesDefaultManagedRuntime &&
      binaryStatus !== 'unknown' &&
      binaryStatus !== 'installed' &&
      binaryStatus !== 'not-applicable');
  const incompatibleHostMessage =
    binaryStatus === 'incompatible-host'
      ? t(
          'settings.agent.dialog.nodeVersionRequired',
          'Kimi Code requires Node ≥{{required}}; this machine is using {{current}}.',
          {
            required: effectiveBinaryState?.required ?? t('common.unknown', 'unknown'),
            current: effectiveBinaryState?.current ?? t('common.unknown', 'unknown'),
          }
        )
      : null;

  // Probe gates on the runtime being usable, so check registry binaries and
  // managed builtins first. Kimi also reports the current/required Node version here.
  useEffect(() => {
    if (!open) return undefined;
    const agentType = formData.agentType;
    const shouldCheckRuntimeStatus = binaryRequired || usesDefaultManagedRuntime;
    if (!shouldCheckRuntimeStatus || !onCheckBinaryStatus) {
      setBinaryState({ agentType, status: 'not-applicable' });
      return undefined;
    }
    let cancelled = false;
    setBinaryState({ agentType, status: 'checking' });
    setBinaryError(null);
    void (async () => {
      try {
        const result = await onCheckBinaryStatus({ machineId: machine.id, agentType });
        if (!cancelled) {
          setBinaryState({
            agentType,
            status: result.status,
            command: result.command,
            version: result.version,
            current: result.current,
            required: result.required,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setBinaryState({ agentType, status: 'not-installed' });
          setBinaryError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    binaryRequired,
    usesDefaultManagedRuntime,
    machine.id,
    formData.agentType,
    onCheckBinaryStatus,
  ]);

  const handleInstallBinary = async () => {
    if (!onInstallBinary) return;
    const agentType = formData.agentType;
    setInstallingBinary(true);
    setBinaryError(null);
    try {
      await onInstallBinary({ machineId: machine.id, agentType });
      // Flipping to 'installed' unblocks the capability probe effect below.
      setBinaryState({ agentType, status: 'installed' });
    } catch (error) {
      setBinaryState({ agentType, status: 'not-installed' });
      setBinaryError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingBinary(false);
    }
  };

  const selectedTitleModelId =
    typeof formData.titleGeneration?.configOptionValues?.model === 'string'
      ? formData.titleGeneration.configOptionValues.model
      : null;
  const titleSelectors = useMemo<AcpConfigOptionSelector[]>(() => {
    if (!capabilitiesReady || acpProvidesSessionTitle) return [];
    return buildAllConfigOptionSelectors({
      configId: agentConfigId,
      cliType: formData.cliType,
      agentType: formData.agentType,
      selectedModelId: selectedTitleModelId,
      runtimeOverrides: formData.runtimeOverrides,
      machine,
    });
  }, [
    machine,
    agentConfigId,
    formData.cliType,
    formData.agentType,
    formData.runtimeOverrides,
    capabilitiesReady,
    acpProvidesSessionTitle,
    selectedTitleModelId,
  ]);

  // Capability refresh is a real runtime probe. The dialog never starts it just
  // to render static builtin defaults; probeTick is bumped by Create or explicit
  // Test / Refresh actions.
  useEffect(() => {
    if (!open) return undefined;
    if (isPreset) return undefined;
    if (isCustom) return undefined;
    if (probeTick === 0) return undefined;
    // Don't launch a binary-distribution agent to probe it until it's installed.
    if (binaryRequired && !binaryReady) return undefined;
    if (!formData.agentType.trim()) return undefined;
    let cancelled = false;
    setProbing(true);
    setProbeError(null);
    void (async () => {
      try {
        await persistConfigBeforeMachineLaunch();
        if (cancelled) return;
        const response = await onRefreshCapabilities({
          machineId: machine.id,
          configId: agentConfigId,
        });
        if (cancelled) return;
        if (response.authRequired) {
          setAuthRequired(true);
          setManuallyTested(false);
          setVerifiedBuiltinContext(null);
          return;
        }
        if (!response.success) {
          setAuthRequired(false);
          setManuallyTested(false);
          setVerifiedBuiltinContext(null);
          setProbeError(
            response.error ??
              t('settings.agent.dialog.probeFailed', 'Provider verification failed.')
          );
          return;
        }
        setAuthRequired(false);
        setManuallyTested(true);
        if (requiresBuiltinCreationVerification) {
          setVerifiedBuiltinContext(builtinVerificationContext);
        }
      } catch (error) {
        if (cancelled) return;
        setManuallyTested(false);
        setVerifiedBuiltinContext(null);
        setProbeError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setProbing(false);
      }
    })();
    return () => {
      cancelled = true;
      setProbing(false);
    };
  }, [
    open,
    machine.id,
    agentConfigId,
    formData.cliType,
    formData.agentType,
    formData.runtimeOverrides,
    onRefreshCapabilities,
    probeTick,
    isPreset,
    isCustom,
    binaryRequired,
    binaryReady,
    requiresBuiltinCreationVerification,
    builtinVerificationContext,
    persistConfigBeforeMachineLaunch,
    t,
  ]);

  // Manual capability probe for custom providers, triggered by the "Test"
  // button. Records the exact command tested so readiness tracks edits.
  const runCustomProbe = async () => {
    if (!parsedCustomAcp || probing) return;
    const probedKey = customAcpKey;
    setProbing(true);
    setProbeError(null);
    try {
      await persistConfigBeforeMachineLaunch();
      const response = await onRefreshCapabilities({
        machineId: machine.id,
        configId: agentConfigId,
      });
      if (response.authRequired) {
        setAuthRequired(true);
        setManuallyTested(false);
        return;
      }
      if (!response.success) {
        throw new Error(
          response.error ?? t('settings.agent.dialog.probeFailed', 'Provider verification failed.')
        );
      }
      setAuthRequired(false);
      setTestedCustomKey(probedKey);
    } catch (error) {
      setProbeError(error instanceof Error ? error.message : String(error));
    } finally {
      setProbing(false);
    }
  };

  useEffect(() => {
    if (isPreset) return;
    if (titleSelectors.length === 0 || titleDefaultsAppliedRef.current) return;
    titleDefaultsAppliedRef.current = true;
    const summaries = titleSelectors.map((sel) => ({
      id: sel.configId,
      name: sel.label,
      description: sel.description,
      category: sel.category,
      type: sel.type,
      currentValue: sel.currentValue,
      options: sel.options.map((o) => ({ value: o.value, name: o.label ?? o.value })),
    }));
    const defaults = computeTitleGenerationDefaults(
      formData.cliType,
      formData.agentType,
      summaries
    );
    if (Object.keys(defaults).length === 0) return;
    const existing = formData.titleGeneration?.configOptionValues ?? {};
    const merged = { ...defaults, ...existing };
    if (Object.keys(existing).length === Object.keys(merged).length) return;
    setFormData((prev) => ({
      ...prev,
      titleGeneration: { ...prev.titleGeneration, configOptionValues: merged },
    }));
  }, [
    isPreset,
    titleSelectors,
    formData.cliType,
    formData.agentType,
    formData.titleGeneration?.configOptionValues,
  ]);

  useEffect(() => {
    if (isPreset || titleSelectors.length === 0) return;
    const values = formData.titleGeneration?.configOptionValues;
    if (!values) return;
    const hasInvalidValue = titleSelectors.some((selector) => {
      const value = values[selector.configId];
      return (
        value !== undefined &&
        !isConfigOptionValueValid(selector, value) &&
        value !== selector.currentValue
      );
    });
    if (!hasInvalidValue) return;

    setFormData((prev) => {
      const currentValues = prev.titleGeneration?.configOptionValues ?? {};
      let nextValues = currentValues;
      for (const selector of titleSelectors) {
        const value = currentValues[selector.configId];
        if (
          value !== undefined &&
          !isConfigOptionValueValid(selector, value) &&
          value !== selector.currentValue
        ) {
          if (nextValues === currentValues) nextValues = { ...currentValues };
          nextValues[selector.configId] = selector.currentValue;
        }
      }
      if (nextValues === currentValues) return prev;
      return {
        ...prev,
        titleGeneration: { ...prev.titleGeneration, configOptionValues: nextValues },
      };
    });
  }, [isPreset, titleSelectors, formData.titleGeneration?.configOptionValues]);

  const additionalEnv = isDeepSeekBuiltin ? omitDeepSeekProtectedEnv(formData.env) : formData.env;
  const envCount = Object.keys(additionalEnv).length;

  const invalidateBuiltinVerification = () => {
    setManuallyTested(false);
    setAuthRequired(false);
    setProbeError(null);
    setProbeTick(0);
    setBuiltinVerificationRevision((revision) => revision + 1);
    setVerifiedBuiltinContext(null);
    setPendingCreateBuiltinContext(null);
  };

  const updateEnvironment = (env: Record<string, string>) => {
    invalidateBuiltinVerification();
    setFormData((prev) => ({ ...prev, env }));
  };

  const updateDeepSeekApiKey = (value: string) => {
    const env = omitDeepSeekProtectedEnv(formData.env);
    const apiKey = value.trim();
    if (apiKey) {
      env[DEEPSEEK_HARNESS_API_KEY_ENV] = apiKey;
    }
    updateEnvironment(env);
  };

  const updateDeepSeekEndpointMode = (endpointMode: DeepSeekEndpointMode) => {
    invalidateBuiltinVerification();
    setFormData((prev) => ({ ...prev, deepseekEndpointMode: endpointMode }));
  };

  const updateDeepSeekCustomBaseUrl = (value: string) => {
    invalidateBuiltinVerification();
    setFormData((prev) => ({ ...prev, deepseekCustomBaseUrl: value }));
  };

  const selectOption = (opt: AgentTypeOption) => {
    if (testingBuiltinSetup) return;
    titleDefaultsAppliedRef.current = false;
    setManuallyTested(false);
    setAuthRequired(false);
    setProbeError(null);
    setProbeTick(0);
    setBuiltinVerificationRevision((revision) => revision + 1);
    setVerifiedBuiltinContext(null);
    setPendingCreateBuiltinContext(null);
    setMobileView('form');
    setFormData((prev) => {
      const autoName =
        prev.name.trim() === '' || isAutoGeneratedName(prev.name) ? opt.label : prev.name;
      if (opt.kind === 'preset') {
        const preset = opt.presetId ? PRESETS_BY_ID[opt.presetId] : undefined;
        const isSamePreset = prev.presetId === opt.presetId;
        const credentialMode = preset
          ? getPresetCredentialMode(preset, isSamePreset ? prev.presetCredentialModeId : undefined)
          : undefined;
        return {
          ...prev,
          name: autoName,
          cliType: opt.cliType,
          agentType: opt.agentType,
          presetId: opt.presetId,
          presetToken: isSamePreset ? prev.presetToken : undefined,
          presetCredentialModeId: credentialMode?.id,
          presetBaseUrlOptionId: getDefaultBaseUrlOptionId(credentialMode),
          presetBaseUrl: isSamePreset ? prev.presetBaseUrl : undefined,
          runtimeOverrides: undefined,
          titleGeneration: undefined,
        };
      }
      if (opt.kind === 'custom') {
        return {
          ...prev,
          name: autoName,
          cliType: opt.cliType,
          // Keep the slug stable while the user stays on the custom option so
          // edits to the command keep probing under the same capability key.
          agentType:
            prev.cliType === 'custom' && prev.agentType ? prev.agentType : `custom-${uuidv4()}`,
          presetId: undefined,
          presetToken: undefined,
          presetCredentialModeId: undefined,
          presetBaseUrlOptionId: undefined,
          presetBaseUrl: undefined,
          runtimeOverrides: undefined,
          titleGeneration: undefined,
        };
      }
      return {
        ...prev,
        name: autoName,
        cliType: opt.cliType,
        agentType: opt.agentType,
        customCommandLine: undefined,
        presetId: undefined,
        presetToken: undefined,
        presetCredentialModeId: undefined,
        presetBaseUrlOptionId: undefined,
        presetBaseUrl: undefined,
        runtimeOverrides: undefined,
        titleGeneration: undefined,
      };
    });
  };

  const updatePresetToken = (value: string) => {
    setFormData((prev) => {
      const preset = prev.presetId ? PRESETS_BY_ID[prev.presetId] : undefined;
      const trimmed = value.trim();
      const detectedMode = preset?.credentialModes?.find(
        (candidateMode) =>
          candidateMode.tokenPrefix && trimmed.startsWith(candidateMode.tokenPrefix)
      );
      if (!detectedMode || detectedMode.id === prev.presetCredentialModeId) {
        return { ...prev, presetToken: value };
      }
      return {
        ...prev,
        presetToken: value,
        presetCredentialModeId: detectedMode.id,
        presetBaseUrlOptionId: getDefaultBaseUrlOptionId(detectedMode),
        presetBaseUrl: undefined,
      };
    });
  };

  const updatePresetCredentialMode = (credentialModeId: string) => {
    if (!activePreset) return;
    const credentialMode = getPresetCredentialMode(activePreset, credentialModeId);
    setFormData((prev) => ({
      ...prev,
      presetCredentialModeId: credentialMode?.id,
      presetBaseUrlOptionId: getDefaultBaseUrlOptionId(credentialMode),
      presetBaseUrl:
        credentialMode?.id === prev.presetCredentialModeId ? prev.presetBaseUrl : undefined,
    }));
  };

  const updateBuiltinRuntimeOverride = (value: string) => {
    if (!builtinRuntimeOverrideKey) return;
    setManuallyTested(false);
    setAuthRequired(false);
    setProbeError(null);
    setProbeTick(0);
    setBuiltinVerificationRevision((revision) => revision + 1);
    setVerifiedBuiltinContext(null);
    setPendingCreateBuiltinContext(null);
    setFormData((prev) => {
      const nextOverrides = { ...(prev.runtimeOverrides ?? {}) };
      if (value.trim()) {
        nextOverrides[builtinRuntimeOverrideKey] = value;
      } else {
        delete nextOverrides[builtinRuntimeOverrideKey];
      }
      return {
        ...prev,
        runtimeOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
      };
    });
  };

  const disableReason: string | null = (() => {
    if (!formData.name.trim()) return t('agents.disableReason.missingName', 'Please enter a name');
    if (!formData.agentType.trim())
      return t('agents.disableReason.missingAgentType', 'Please select an agent type');
    if (incompatibleHostMessage) return incompatibleHostMessage;
    if (mode.kind === 'create' && isQueuedBuiltin && !supportsProviderSetup) {
      return t(
        'settings.agent.setup.unsupportedTarget',
        'Update Lody on the target machine to finish this provider setup.'
      );
    }
    if (binaryRequired && !binaryReady) {
      if (binaryStatus === 'unsupported-platform') {
        return t(
          'settings.agent.dialog.binaryUnsupported',
          "This agent isn't available for this machine's platform."
        );
      }
      if (binaryStatus === 'error') {
        return (
          effectiveBinaryState?.error ??
          binaryError ??
          t('settings.agent.dialog.binaryDownloadFailed', 'The agent runtime download failed.')
        );
      }
      return formatBinaryStatusText(
        t,
        binaryStatus,
        effectiveBinaryState,
        usesDefaultManagedRuntime
      );
    }
    if (isCustom && !parsedCustomAcp) {
      return (formData.customCommandLine ?? '').trim()
        ? t('agents.disableReason.invalidCustomCommand', 'The launch command has unclosed quotes')
        : t('agents.disableReason.missingCustomCommand', 'Please enter the launch command');
    }
    if (isDeepSeekBuiltin && !formData.env[DEEPSEEK_HARNESS_API_KEY_ENV]?.trim()) {
      return t('agents.disableReason.missingDeepseekApiKey', 'Please enter your DeepSeek API Key');
    }
    if (isDeepSeekBuiltin && deepseekEndpointMode === 'custom') {
      const endpoint = (formData.deepseekCustomBaseUrl ?? '').trim();
      if (!endpoint) {
        return t('agents.disableReason.missingDeepseekEndpoint', 'Please enter an API Endpoint');
      }
      if (!isValidHttpUrl(endpoint)) {
        return t(
          'agents.disableReason.invalidDeepseekEndpoint',
          'Please enter a valid HTTP or HTTPS endpoint'
        );
      }
    }
    if (activePreset && !(formData.presetToken ?? '').trim()) {
      return t('agents.disableReason.missingPresetToken', 'Please paste your {{preset}} token', {
        preset: t(activePreset.labelKey, activePreset.label),
      });
    }
    if (activeCredentialMode?.baseUrlEnvKey) {
      const baseUrl = resolveCredentialModeBaseUrl(
        activeCredentialMode,
        formData.presetBaseUrlOptionId,
        formData.presetBaseUrl
      );
      if (!baseUrl) {
        return t(
          'agents.disableReason.missingPresetBaseUrl',
          'Please select or enter the {{preset}} Base URL',
          {
            preset: activePreset
              ? t(activePreset.labelKey, activePreset.label)
              : t('settings.agent.dialog.presetFallback', 'preset'),
          }
        );
      }
      if (!isValidHttpUrl(baseUrl)) {
        return t('agents.disableReason.invalidPresetBaseUrl', 'Please enter a valid Base URL');
      }
    }
    return null;
  })();

  const persistConfig = useCallback(async () => {
    try {
      setSubmitting(true);
      await persistConfigBeforeMachineLaunch();
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to save agent config:', error);
    } finally {
      setSubmitting(false);
    }
  }, [onOpenChange, persistConfigBeforeMachineLaunch]);

  const submit = async () => {
    if (disableReason || submitting || waitingForBuiltinSetup) return;
    if (
      requiresBuiltinCreationVerification &&
      !backgroundBuiltinSetup &&
      !builtinCreationVerified
    ) {
      setPendingCreateBuiltinContext(builtinVerificationContext);
      setAuthRequired(false);
      setProbeError(null);
      setManuallyTested(false);
      setVerifiedBuiltinContext(null);
      setProbeTick((tick) => tick + 1);
      return;
    }
    await persistConfig();
  };

  useEffect(() => {
    if (!requiresBuiltinCreationVerification || backgroundBuiltinSetup) return;
    if (pendingCreateBuiltinContext !== builtinVerificationContext) return;
    if (!builtinCreationVerified || probing || authRequired || submitting) return;
    if (disableReason) {
      setPendingCreateBuiltinContext(null);
      return;
    }
    setPendingCreateBuiltinContext(null);
    void persistConfig();
  }, [
    authRequired,
    backgroundBuiltinSetup,
    builtinCreationVerified,
    builtinVerificationContext,
    disableReason,
    pendingCreateBuiltinContext,
    persistConfig,
    probing,
    requiresBuiltinCreationVerification,
    submitting,
  ]);

  const selectedOption = useMemo<AgentTypeOption | undefined>(() => {
    if (formData.presetId) return PRESET_OPTIONS.find((o) => o.presetId === formData.presetId);
    if (formData.cliType === 'custom') return CUSTOM_OPTION;
    return ALL_OPTIONS.find(
      (o) =>
        o.kind !== 'preset' && o.cliType === formData.cliType && o.agentType === formData.agentType
    );
  }, [formData.cliType, formData.agentType, formData.presetId]);

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ALL_OPTIONS;
    return ALL_OPTIONS.filter((o) => o.searchKeys.toLowerCase().includes(q));
  }, [query]);

  const groupedOptions = useMemo(() => {
    return {
      builtin: filteredOptions.filter((o) => o.kind === 'builtin'),
      preset: filteredOptions.filter((o) => o.kind === 'preset'),
      custom: filteredOptions.filter((o) => o.kind === 'custom'),
      registry: filteredOptions.filter((o) => o.kind === 'registry'),
    };
  }, [filteredOptions]);

  const selectedOptionLabel = selectedOption ? getOptionLabel(t, selectedOption) : undefined;
  const selectedOptionDescription = selectedOption
    ? getOptionDescription(t, selectedOption)
    : undefined;

  const dialogTitle =
    mode.kind === 'edit'
      ? t('settings.agent.dialog.title.edit', {
          name: selectedOptionLabel ?? formData.name,
          defaultValue: 'Edit {{name}}',
        })
      : t('settings.agent.dialog.title.create', 'New provider');

  const showPicker = !isNarrowLayout || mobileView === 'picker';
  const showForm = !isNarrowLayout || mobileView === 'form';
  const canGoBack = isNarrowLayout && mode.kind === 'create' && mobileView === 'form';

  const pickerPane = (
    <aside
      aria-label={t('agents.agentTypeList', 'Agent types')}
      {...stylex.props(styles.rail, isNarrowLayout && styles.railNarrow)}
    >
      {/* The wide layout names the rail by its search, on the form header's row:
          a second title beside the form's read as two headings competing. */}
      {isNarrowLayout ? (
        <div {...stylex.props(styles.railHeader, styles.railHeaderNarrow)}>
          <Button
            type="button"
            variant="ghost"
            size="medium"
            icon
            onClick={() => onOpenChange(false)}
            aria-label={t('common.close', 'Close')}
          >
            <ArrowLeft {...stylex.props(styles.glyphFill)} />
          </Button>
          <div {...stylex.props(styles.railTitle)}>
            {t('settings.agent.dialog.chooseType', 'Choose a type')}
          </div>
        </div>
      ) : null}
      <div {...stylex.props(styles.search, !isNarrowLayout && styles.searchOnHeaderRow)}>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('common.search', 'Search')}
          size={isNarrowLayout ? 'large' : 'medium'}
          leading={<Search aria-hidden="true" {...stylex.props(catalog.icon)} />}
          aria-label={t('common.search', 'Search')}
        />
        {query && (
          <span {...stylex.props(styles.searchClear)}>
            <Button
              type="button"
              variant="ghost"
              size="mini"
              icon
              onClick={() => setQuery('')}
              aria-label={t('common.clear', 'Clear')}
            >
              <X {...stylex.props(styles.glyphFill)} />
            </Button>
          </span>
        )}
      </div>
      <nav
        role="listbox"
        // `scrollbar-pro` is the product's thin scrollbar (index.css).
        className={['scrollbar-pro', stylex.props(styles.railList).className].join(' ')}
      >
        <RailGroup title={t('settings.agent.dialog.group.builtin', 'Built-in')}>
          {groupedOptions.builtin.map((opt) => (
            <RailItem
              key={opt.value}
              option={opt}
              selected={selectedOption?.value === opt.value}
              disabled={mode.kind === 'edit' || testingBuiltinSetup}
              chevron={isNarrowLayout}
              onSelect={() => selectOption(opt)}
            />
          ))}
        </RailGroup>
        {groupedOptions.preset.length > 0 && (
          <RailGroup title={t('settings.agent.dialog.group.presets', 'Presets')}>
            {groupedOptions.preset.map((opt) => (
              <RailItem
                key={opt.value}
                option={opt}
                selected={selectedOption?.value === opt.value}
                disabled={mode.kind === 'edit' || testingBuiltinSetup}
                chevron={isNarrowLayout}
                onSelect={() => selectOption(opt)}
              />
            ))}
          </RailGroup>
        )}
        {groupedOptions.custom.length > 0 && (
          <RailGroup title={t('settings.agent.dialog.group.custom', 'Custom')}>
            {groupedOptions.custom.map((opt) => (
              <RailItem
                key={opt.value}
                option={opt}
                selected={selectedOption?.value === opt.value}
                disabled={mode.kind === 'edit' || testingBuiltinSetup}
                chevron={isNarrowLayout}
                onSelect={() => selectOption(opt)}
              />
            ))}
          </RailGroup>
        )}
        {groupedOptions.registry.length > 0 && (
          <RailGroup title={t('settings.agent.dialog.group.registry', 'ACP Provider')}>
            {groupedOptions.registry.map((opt) => (
              <RailItem
                key={opt.value}
                option={opt}
                selected={selectedOption?.value === opt.value}
                disabled={mode.kind === 'edit' || testingBuiltinSetup}
                chevron={isNarrowLayout}
                onSelect={() => selectOption(opt)}
              />
            ))}
          </RailGroup>
        )}
        {filteredOptions.length === 0 && (
          <div {...stylex.props(styles.railEmpty)}>
            {t('settings.agent.dialog.noResults', 'No agents match that search')}
          </div>
        )}
      </nav>
    </aside>
  );

  const formPane = (
    <section
      {...stylex.props(catalog.editorForm, styles.pane, isNarrowLayout && styles.paneNarrow)}
    >
      <header {...stylex.props(styles.header, isNarrowLayout && styles.headerNarrow)}>
        <div {...stylex.props(styles.headerMain)}>
          {isNarrowLayout && (
            <Button
              type="button"
              variant="ghost"
              size="medium"
              icon
              onClick={() => (canGoBack ? setMobileView('picker') : onOpenChange(false))}
              aria-label={
                canGoBack
                  ? t('settings.agent.dialog.back', 'Back to type list')
                  : t('common.close', 'Close')
              }
            >
              <ArrowLeft {...stylex.props(styles.glyphFill)} />
            </Button>
          )}
          <span {...stylex.props(styles.headerGlyph)}>
            {selectedOption ? (
              <OptionIcon
                option={selectedOption}
                className={stylex.props(styles.optionIconLarge).className}
              />
            ) : null}
          </span>
          <div {...stylex.props(styles.headerText)}>
            <h2 {...stylex.props(styles.title)}>{dialogTitle}</h2>
            {selectedOptionDescription && (
              <p {...stylex.props(styles.subtitle)}>{selectedOptionDescription}</p>
            )}
          </div>
        </div>
        {!waitingForBuiltinSetup && (
          <ProbeStatus
            isPreset={isPreset}
            probing={probing}
            probeError={probeError}
            ready={capabilitiesReady && !builtinNeedsCredentialCheck && !authRequired}
            showIdleAction={!isCustom}
            disabled={isQueuedBuiltin && (!!disableReason || submitting)}
            onRetry={() => {
              setProbeError(null);
              if (isQueuedBuiltin && backgroundBuiltinSetup) {
                if (disableReason || submitting) return;
                setTestingBuiltinSetup(true);
                void persistConfigBeforeMachineLaunch().catch((error) => {
                  setTestingBuiltinSetup(false);
                  setProbeError(error instanceof Error ? error.message : String(error));
                });
                return;
              }
              if (isCustom) {
                void runCustomProbe();
                return;
              }
              setManuallyTested(false);
              setVerifiedBuiltinContext(null);
              setProbeTick((n) => n + 1);
            }}
          />
        )}
      </header>

      <div
        ref={formScrollRef}
        className={[
          'scrollbar-pro',
          stylex.props(catalog.editorBody, isNarrowLayout && styles.bodyNarrow).className,
        ].join(' ')}
      >
        {waitingForBuiltinSetup &&
          (builtinSetup ? (
            <ProviderSetupRow
              setup={builtinSetup}
              machine={machine}
              onRetry={async (setup) => {
                try {
                  await retrySetup(setup.id);
                } catch (error) {
                  toast.error(
                    t('settings.agent.setup.retryFailed', 'Could not retry provider setup')
                  );
                  throw error;
                }
              }}
              onDelete={async (setup) => {
                try {
                  await deleteSetup(setup.id);
                  // Cancellation is durable for this id. A new test must be a
                  // new setup, or the daemon would cancel it again.
                  draftConfigIdRef.current = uuidv4() as AgentConfigId;
                  lastPersistedPayloadKeyRef.current = null;
                  setTestingBuiltinSetup(false);
                } catch (error) {
                  toast.error(
                    t('settings.agent.setup.deleteFailed', 'Could not delete provider setup')
                  );
                  throw error;
                }
              }}
            />
          ) : (
            <Spinner size="medium" />
          ))}
        <div
          hidden={waitingForBuiltinSetup}
          // `hidden` alone loses to a stylesheet's `display`.
          {...stylex.props(styles.groups, waitingForBuiltinSetup && styles.hidden)}
        >
          <Field
            htmlFor="agent-config-name"
            label={t('agents.configName', 'Name')}
            hint={t(
              'settings.agent.dialog.nameHint',
              'Shown in the provider list and session menus.'
            )}
          >
            <Input
              id="agent-config-name"
              value={formData.name}
              onChange={(event) => setFormData({ ...formData, name: event.target.value })}
              placeholder={t('agents.configNamePlaceholder', 'Enter configuration name')}
              autoComplete="off"
            />
          </Field>

          {activePreset ? (
            <PresetPanel
              preset={activePreset}
              credentialMode={activeCredentialMode}
              credentialModeId={activeCredentialMode?.id}
              onCredentialModeChange={updatePresetCredentialMode}
              token={formData.presetToken ?? ''}
              onTokenChange={updatePresetToken}
              baseUrlOptionId={formData.presetBaseUrlOptionId}
              onBaseUrlOptionChange={(value) =>
                setFormData({ ...formData, presetBaseUrlOptionId: value })
              }
              customBaseUrl={formData.presetBaseUrl ?? ''}
              onCustomBaseUrlChange={(value) => setFormData({ ...formData, presetBaseUrl: value })}
              injectedEnv={buildPresetInjectedEnvPreview(
                activePreset,
                activeCredentialMode,
                formData
              )}
            />
          ) : null}

          {isDeepSeekBuiltin ? (
            <DeepSeekHarnessPanel
              endpointMode={deepseekEndpointMode}
              onEndpointModeChange={updateDeepSeekEndpointMode}
              apiKey={formData.env[DEEPSEEK_HARNESS_API_KEY_ENV] ?? ''}
              onApiKeyChange={updateDeepSeekApiKey}
              customBaseUrl={formData.deepseekCustomBaseUrl ?? ''}
              onCustomBaseUrlChange={updateDeepSeekCustomBaseUrl}
            />
          ) : null}

          {isCustom && (
            <div {...stylex.props(styles.stack)}>
              <Field
                htmlFor="custom-acp-command"
                label={t('settings.agent.dialog.custom.commandLabel', 'Launch command')}
                hint={t(
                  'settings.agent.dialog.custom.commandHint',
                  'The full command that starts an ACP-compatible agent over stdio, e.g. "npx -y my-acp-agent --flag". Quotes are supported for arguments with spaces; shell features like pipes or $VARS are not.'
                )}
                icon={<SquareTerminal aria-hidden="true" {...stylex.props(catalog.icon)} />}
              >
                <div {...stylex.props(styles.inputWithTest)}>
                  <Input
                    id="custom-acp-command"
                    value={formData.customCommandLine ?? ''}
                    onChange={(event) =>
                      setFormData({ ...formData, customCommandLine: event.target.value })
                    }
                    placeholder={t(
                      'settings.agent.dialog.custom.commandPlaceholder',
                      'npx -y my-acp-agent'
                    )}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <TestButton
                    label={t('settings.agent.dialog.custom.test', 'Test command')}
                    status={
                      probing ? 'testing' : probeError ? 'error' : customReady ? 'ready' : 'idle'
                    }
                    disabled={!parsedCustomAcp || probing}
                    onClick={() => void runCustomProbe()}
                  />
                </div>
              </Field>
              <p {...stylex.props(styles.hint)}>
                {t(
                  'settings.agent.dialog.custom.testHint',
                  'Custom providers are only probed when you click Test — re-test after changing the command.'
                )}
              </p>
            </div>
          )}

          {builtinRuntimeOverrideKey && !activePreset ? (
            <div {...stylex.props(styles.stack)}>
              <Field
                htmlFor="builtin-runtime-path"
                label={t('settings.agent.dialog.runtimeOverride.label', 'Runtime binary path')}
                hint={t(
                  'settings.agent.dialog.runtimeOverride.hint',
                  'Advanced: leave empty to let Lody install and verify the managed runtime. Filling this is not recommended unless you need a local enterprise mirror or are debugging runtime startup.'
                )}
                icon={<SquareTerminal aria-hidden="true" {...stylex.props(catalog.icon)} />}
              >
                <div {...stylex.props(styles.inputWithTest)}>
                  <Input
                    id="builtin-runtime-path"
                    value={builtinRuntimeOverrideValue}
                    onChange={(event) => updateBuiltinRuntimeOverride(event.target.value)}
                    placeholder={
                      formData.agentType === 'codex'
                        ? t(
                            'settings.agent.dialog.runtimeOverride.codexPlaceholder',
                            '/path/to/codex'
                          )
                        : formData.agentType === 'kimi'
                          ? t(
                              'settings.agent.dialog.runtimeOverride.kimiPlaceholder',
                              '/path/to/kimi'
                            )
                          : formData.agentType === 'grok'
                            ? t(
                                'settings.agent.dialog.runtimeOverride.grokPlaceholder',
                                '/path/to/grok'
                              )
                            : t(
                                'settings.agent.dialog.runtimeOverride.claudePlaceholder',
                                '/path/to/claude'
                              )
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <TestButton
                    label={t('settings.agent.dialog.runtimeOverride.test', 'Test runtime')}
                    status={
                      probing
                        ? 'testing'
                        : probeError
                          ? 'error'
                          : capabilitiesReady
                            ? 'ready'
                            : 'idle'
                    }
                    disabled={!hasBuiltinRuntimeOverride || probing}
                    onClick={() => {
                      setProbeError(null);
                      setManuallyTested(false);
                      setVerifiedBuiltinContext(null);
                      setProbeTick((n) => n + 1);
                    }}
                  />
                </div>
              </Field>
            </div>
          ) : null}

          {probeError && !isPreset && (
            <div {...stylex.props(styles.warning)}>
              <AlertTriangle aria-hidden="true" {...stylex.props(styles.warningMark)} />
              <div {...stylex.props(styles.warningBody)}>{probeError}</div>
            </div>
          )}
          {probeError && isBubBuiltin && <BubInstallGuide />}

          {showAuthenticationPanel ? (
            <Field
              label={t('settings.agent.dialog.section.account', 'Account')}
              hint={
                authRequired
                  ? t(
                      'settings.agent.dialog.authRequiredHint',
                      'This provider has no credentials on this machine yet.'
                    )
                  : t(
                      'settings.agent.dialog.reauthenticateHint',
                      'Sign in again if this provider stopped accepting your account.'
                    )
              }
              icon={<KeyRound aria-hidden="true" {...stylex.props(catalog.icon)} />}
            >
              <AcpAuthenticationPanel
                machineId={machine.id}
                configId={agentConfigId}
                cliType={formData.cliType}
                agentType={formData.agentType}
                providerName={formData.name}
                customAcp={parsedCustomAcp ?? undefined}
                runtimeOverrides={formData.runtimeOverrides}
                env={formData.env}
                compact
                reauthentication={!authRequired}
                onBeforeStart={persistConfigBeforeMachineLaunch}
                onAuthenticated={() => {
                  setAuthRequired(false);
                  setProbeError(null);
                  setManuallyTested(true);
                  if (isCustom && parsedCustomAcp) {
                    setTestedCustomKey(customAcpKey);
                  }
                  if (requiresBuiltinCreationVerification) {
                    setVerifiedBuiltinContext(builtinVerificationContext);
                  }
                }}
              />
            </Field>
          ) : null}

          {showBinaryPanel && (
            <div {...stylex.props(surface.formBlock, styles.status)}>
              {incompatibleHostMessage ? (
                <p {...stylex.props(styles.statusWarning)}>{incompatibleHostMessage}</p>
              ) : binaryStatus === 'unsupported-platform' ? (
                <p {...stylex.props(styles.statusWarning)}>
                  {t(
                    'settings.agent.dialog.binaryUnsupported',
                    "This agent isn't available for this machine's platform."
                  )}
                </p>
              ) : binaryStatus === 'unknown' || binaryProgressActive ? (
                <p {...stylex.props(styles.statusBusy)}>
                  <Spinner size="small" />
                  {formatBinaryStatusText(
                    t,
                    binaryStatus,
                    effectiveBinaryState,
                    usesDefaultManagedRuntime
                  )}
                </p>
              ) : (
                <div {...stylex.props(styles.status)}>
                  <p {...stylex.props(styles.statusText)}>
                    {binaryStatus === 'error'
                      ? t(
                          'settings.agent.dialog.binaryDownloadFailed',
                          'The agent runtime download failed.'
                        )
                      : usesDefaultManagedRuntime
                        ? backgroundBuiltinSetup
                          ? t(
                              'settings.agent.dialog.managedRuntimeQueuedAfterCreate',
                              'The managed runtime is not downloaded or is out of date. Lody will download and verify it in the background after you add this provider.'
                            )
                          : t(
                              'settings.agent.dialog.managedRuntimeNotInstalled',
                              'The managed runtime is not downloaded or is out of date. Lody will download and verify it before creating this provider.'
                            )
                        : t(
                            'settings.agent.dialog.binaryNotInstalled',
                            'This agent must download a binary to this machine before it can be enabled.'
                          )}
                  </p>
                  {(effectiveBinaryState?.error ?? binaryError) && (
                    <p {...stylex.props(styles.statusWarning)}>
                      {effectiveBinaryState?.error ?? binaryError}
                    </p>
                  )}
                  {onInstallBinary &&
                  (binaryStatus === 'not-installed' || binaryStatus === 'error') ? (
                    <div {...stylex.props(styles.answer)}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        disabled={installingBinary || probing}
                        onClick={() => void handleInstallBinary()}
                      >
                        {installingBinary ? (
                          <>
                            <Spinner size="small" />
                            {t('settings.agent.dialog.binaryDownloading', 'Downloading…')}
                          </>
                        ) : (
                          <>
                            <Download {...stylex.props(catalog.icon)} />
                            {binaryStatus === 'error'
                              ? t('settings.agent.dialog.binaryRetryDownload', 'Retry download')
                              : t('settings.agent.dialog.binaryDownload', 'Download agent')}
                          </>
                        )}
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          )}

          {/* The optional settings are one block — a card of ruled rows, each
              naming its setting and folding open in place — so they hold the
              lower half of the form as one object rather than three captions. */}
          <div {...stylex.props(styles.sectionGroup)}>
            {!isPreset &&
              !acpProvidesSessionTitle &&
              (capabilitiesReady ? titleSelectors.length > 0 : true) && (
                <Section
                  title={t('settings.agent.dialog.section.titleGen', 'Title generation')}
                  defaultOpen
                  disabled={!capabilitiesReady}
                  disabledHint={
                    probing
                      ? t('settings.agent.dialog.probing', 'Probing…')
                      : t(
                          'settings.agent.dialog.testToRefreshCapabilities',
                          'Click Test to refresh available options.'
                        )
                  }
                >
                  <TitleGenerationFields
                    selectors={titleSelectors}
                    values={formData.titleGeneration?.configOptionValues}
                    onChange={(configId, value) => {
                      const nextValues = {
                        ...formData.titleGeneration?.configOptionValues,
                        [configId]: value,
                      };
                      setFormData({
                        ...formData,
                        titleGeneration: {
                          ...formData.titleGeneration,
                          configOptionValues: nextValues,
                        },
                      });
                    }}
                  />
                </Section>
              )}

            <Section
              title={t('settings.agent.dialog.section.prompt', 'Custom prompt')}
              action={
                formData.prompt.trim().length > 0 ? (
                  <InlineCopyButton value={formData.prompt} ariaLabel={t('common.copy', 'Copy')} />
                ) : null
              }
            >
              <Textarea
                value={formData.prompt}
                onChange={(event) => setFormData({ ...formData, prompt: event.target.value })}
                placeholder={t(
                  'agents.customPromptPlaceholder',
                  'Optional instructions to include before task details'
                )}
                rows={3}
              />
            </Section>

            <Section
              title={
                activePreset || isDeepSeekBuiltin
                  ? t(
                      'settings.agent.dialog.section.envAdditional',
                      'Additional environment variables'
                    )
                  : t('settings.agent.dialog.section.env', 'Environment variables')
              }
              count={envCount}
              action={
                envCount > 0 ? (
                  <InlineCopyButton
                    value={envVarsToText(additionalEnv)}
                    ariaLabel={t('common.copy', 'Copy')}
                  />
                ) : null
              }
            >
              {activePreset ? (
                <p {...stylex.props(styles.note)}>
                  {t(
                    'settings.agent.dialog.presetEnvHint',
                    'Preset variables (shown above) are injected automatically and cannot be overridden here.'
                  )}
                </p>
              ) : null}
              {!activePreset && isDeepSeekBuiltin ? (
                <p {...stylex.props(styles.note)}>
                  {t(
                    'settings.agent.dialog.deepseek.envHint',
                    'DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL are set above and cannot be overridden here.'
                  )}
                </p>
              ) : null}
              <EnvVarsTextarea
                value={additionalEnv}
                onChange={(env) => {
                  if (!isDeepSeekBuiltin) {
                    updateEnvironment(env);
                    return;
                  }
                  const next = omitDeepSeekProtectedEnv(env);
                  if (formData.env[DEEPSEEK_HARNESS_API_KEY_ENV]) {
                    next[DEEPSEEK_HARNESS_API_KEY_ENV] = formData.env[DEEPSEEK_HARNESS_API_KEY_ENV];
                  }
                  updateEnvironment(next);
                }}
                showLabel={false}
                rows={5}
              />
            </Section>
          </div>

          {formData.cliType === 'builtin' && formData.agentType === 'pi' && (
            <PiExtensionsField
              key={`${machine.id}:${agentConfigId}:${mode.kind === 'edit' ? (mode.config.env?.PI_CODING_AGENT_DIR ?? '') : ''}`}
              value={formData.runtimeOverrides?.piExtensions ?? []}
              supported={machineSupportsPiExtensions(machine)}
              onScan={
                onScanPiExtensions
                  ? () =>
                      onScanPiExtensions({
                        machineId: machine.id,
                        configId: mode.kind === 'edit' ? mode.config.id : undefined,
                      })
                  : undefined
              }
              onChange={(paths) => {
                invalidateBuiltinVerification();
                setFormData((prev) => {
                  const runtimeOverrides = { ...prev.runtimeOverrides };
                  if (paths.length) runtimeOverrides.piExtensions = paths;
                  else delete runtimeOverrides.piExtensions;
                  return {
                    ...prev,
                    runtimeOverrides: Object.keys(runtimeOverrides).length
                      ? runtimeOverrides
                      : undefined,
                  };
                });
              }}
            />
          )}
        </div>
      </div>

      <div {...stylex.props(isNarrowLayout && styles.footerNarrow)}>
        <Dialog.Footer>
          {selectedOption?.kind === 'registry' && (
            <span {...stylex.props(styles.footerNote)}>
              <FlaskConical aria-hidden="true" {...stylex.props(catalog.iconSmall)} />
              {t('settings.agent.dialog.registryNote', 'Experimental — uses ACP Providers.')}
            </span>
          )}
          <Button
            variant="secondary"
            size="small"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <span>
                  <Button
                    size="small"
                    onClick={() => void submit()}
                    disabled={
                      !!disableReason ||
                      submitting ||
                      waitingForBuiltinSetup ||
                      (builtinCreationPending && !probeError)
                    }
                  >
                    {(submitting || (builtinCreationPending && !authRequired && !probeError)) && (
                      <Spinner size="small" />
                    )}
                    {mode.kind === 'edit' || publishedSetupConfig
                      ? t('common.save', 'Save')
                      : t('common.create', 'Create')}
                  </Button>
                </span>
              }
            />
            {disableReason && <Tooltip.Content>{disableReason}</Tooltip.Content>}
          </Tooltip.Root>
        </Dialog.Footer>
      </div>
    </section>
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        backdropClassName={
          nestedInDialog
            ? // Radix portals are siblings under body. Matching the parent content's
              // z-index lets this later overlay cover it without stacking another /80 veil.
              'z-[var(--z-dialog)] bg-black/20'
            : undefined
        }
        // On the narrow layout the picker and form headers carry their own
        // left-aligned back button, which doubles as a close on the root step, so
        // a corner cross would be redundant and easy to hit by accident.
        closeButton={!isNarrowLayout}
        // Keep keyboard height changes synchronous on the narrow sheet: the form
        // scroll hook measures the container on the keyboard event.
        noAnimation={isNarrowLayout}
        style={isNarrowLayout ? PANEL_STYLE_NARROW : PANEL_STYLE}
      >
        <Dialog.Title className="sr-only">{dialogTitle}</Dialog.Title>
        <Dialog.Description className="sr-only">
          {t(
            'settings.agent.dialog.a11yDescription',
            'Choose an agent type on the left and fill in the configuration on the right.'
          )}
        </Dialog.Description>

        <div {...stylex.props(styles.layout)}>
          {showPicker && pickerPane}
          {showForm && formPane}
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * Returns true when the dialog should switch to the narrow / mobile two-step
 * flow. We watch viewport width directly (instead of `useIsMobile`) so a
 * narrow desktop window also switches.
 */
function useNarrowDialogLayout() {
  const [narrow, setNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 767px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mql = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    setNarrow(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return narrow;
}

// =============================================================================
// Presentational helpers
// =============================================================================

function isAutoGeneratedName(name: string) {
  const n = name.trim();
  if (!n) return true;
  return ALL_OPTIONS.some((o) => o.label === n);
}

function getOptionLabel(t: Translate, option: AgentTypeOption) {
  return option.labelKey ? t(option.labelKey, option.label) : option.label;
}

function getOptionDescription(t: Translate, option: AgentTypeOption) {
  if (option.descriptionKey && option.descriptionDefault) {
    return t(option.descriptionKey, option.descriptionDefault);
  }
  return option.description;
}

function RailGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div {...stylex.props(styles.railGroup)}>
      <div {...stylex.props(styles.railGroupTitle)}>{title}</div>
      <div {...stylex.props(styles.railGroupItems)}>{children}</div>
    </div>
  );
}

function RailItem({
  option,
  selected,
  disabled,
  onSelect,
  chevron,
}: {
  option: AgentTypeOption;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  /** Show a chevron-right at the end of the row (used in mobile picker). */
  chevron?: boolean;
}) {
  const { t } = useTranslation();
  const unavailable = !!disabled && !selected;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={unavailable}
      onClick={onSelect}
      {...stylex.props(
        surface.listRow,
        selected && surface.listRowSelected,
        styles.railItem,
        chevron && styles.railItemNarrow,
        unavailable && styles.railItemDisabled
      )}
    >
      <span
        {...stylex.props(
          styles.railIcon,
          chevron && styles.railIconNarrow,
          selected && styles.railIconSelected
        )}
      >
        <OptionIcon
          option={option}
          className={stylex.props(chevron ? styles.optionIconLarge : styles.optionIcon).className}
        />
      </span>
      <span {...stylex.props(surface.listRowLabel)}>{getOptionLabel(t, option)}</span>
      {selected && !chevron && <Check aria-hidden="true" {...stylex.props(styles.railCheck)} />}
      {chevron && <ChevronRight aria-hidden="true" {...stylex.props(styles.railChevron)} />}
    </button>
  );
}

function OptionIcon({ option, className }: { option: AgentTypeOption; className?: string }) {
  const brandId = option.presetId ? PRESETS_BY_ID[option.presetId]?.brandId : undefined;
  return (
    <AgentIcon
      cliType={option.cliType}
      agentType={option.agentType}
      brandId={brandId}
      className={className}
    />
  );
}

function formatBinaryStatusText(
  t: Translate,
  status: 'unknown' | AgentBinaryRuntimeStatus,
  state: { percent?: number } | null,
  managedRuntime: boolean
): string {
  if (status === 'downloading') {
    if (typeof state?.percent === 'number') {
      return t('settings.agent.dialog.binaryDownloadingPercent', 'Downloading… {{percent}}%', {
        percent: Math.round(state.percent),
      });
    }
    return t('settings.agent.dialog.binaryDownloading', 'Downloading…');
  }
  if (status === 'verifying') {
    return t('settings.agent.dialog.binaryVerifying', 'Verifying download…');
  }
  if (status === 'extracting') {
    return t('settings.agent.dialog.binaryExtracting', 'Extracting runtime…');
  }
  if (status === 'publishing') {
    return t('settings.agent.dialog.binaryPublishing', 'Installing runtime…');
  }
  if (status === 'not-installed') {
    return managedRuntime
      ? t('settings.agent.dialog.managedRuntimeDownloadRequired', 'Runtime download required…')
      : t('settings.agent.dialog.binaryDownloadRequired', 'Agent download required…');
  }
  return t('settings.agent.dialog.binaryChecking', 'Checking download status…');
}

function ProbeStatus({
  isPreset,
  probing,
  probeError,
  ready,
  showIdleAction,
  disabled = false,
  onRetry,
}: {
  isPreset: boolean;
  probing: boolean;
  probeError: string | null;
  ready: boolean;
  showIdleAction: boolean;
  disabled?: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (isPreset) {
    return (
      <Badge icon={<Sparkles {...stylex.props(styles.glyphFill)} />}>
        {t('settings.agent.dialog.presetBadge', 'Preset')}
      </Badge>
    );
  }
  if (probing) {
    return (
      <span {...stylex.props(styles.probing)}>
        <Spinner size="small" aria-hidden="true" />
        {t('settings.agent.dialog.probing', 'Probing…')}
      </span>
    );
  }
  if (probeError) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="small"
        onClick={onRetry}
        disabled={disabled}
        aria-label={t('settings.agent.dialog.retryProbe', 'Retry capability probe')}
      >
        <RefreshCw {...stylex.props(catalog.iconSmall)} />
        {t('common.retry', 'Retry')}
      </Button>
    );
  }
  if (ready) {
    return (
      <div {...stylex.props(styles.probeReady)}>
        <Tooltip.Root>
          <Tooltip.Trigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="small"
                icon
                onClick={onRetry}
                disabled={disabled}
                aria-label={t(
                  'settings.agent.dialog.refreshCapabilities',
                  'Refresh agent capabilities'
                )}
              >
                <RefreshCw aria-hidden="true" {...stylex.props(styles.glyphFill)} />
              </Button>
            }
          />
          <Tooltip.Content>
            {t(
              'settings.agent.dialog.refreshCapabilitiesHint',
              'Re-probe modes, models, and config options'
            )}
          </Tooltip.Content>
        </Tooltip.Root>
        <Badge tone="success" icon={<Check {...stylex.props(styles.glyphFill)} />}>
          {t('settings.agent.dialog.ready', 'Ready')}
        </Badge>
      </div>
    );
  }
  if (!showIdleAction) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="secondary"
      size="small"
      onClick={onRetry}
      disabled={disabled}
      aria-label={t('settings.agent.dialog.testCapabilities', 'Test agent capabilities')}
    >
      <FlaskConical {...stylex.props(catalog.iconSmall)} />
      {t('settings.agent.dialog.testCapabilitiesShort', 'Test')}
    </Button>
  );
}

function DeepSeekApiKeyField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <Field
      htmlFor="deepseek-api-key"
      label={label ?? t('settings.agent.dialog.deepseek.apiKeyLabel', 'DeepSeek API Key')}
      hint={t(
        'settings.agent.dialog.deepseek.apiKeyHelp',
        'Saved with this provider and injected as DEEPSEEK_API_KEY when DSH starts.'
      )}
      icon={<KeyRound aria-hidden="true" {...stylex.props(catalog.icon)} />}
    >
      <Input
        id="deepseek-api-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('settings.agent.dialog.deepseek.apiKeyPlaceholder', 'sk-XXXXXXXXXXXX')}
      />
    </Field>
  );
}

function DeepSeekHarnessPanel({
  endpointMode,
  onEndpointModeChange,
  apiKey,
  onApiKeyChange,
  customBaseUrl,
  onCustomBaseUrlChange,
}: {
  endpointMode: DeepSeekEndpointMode;
  onEndpointModeChange: (value: DeepSeekEndpointMode) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  customBaseUrl: string;
  onCustomBaseUrlChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Tabs.Root
      value={endpointMode}
      onValueChange={(value) => {
        if (value === 'official' || value === 'custom') {
          onEndpointModeChange(value);
        }
      }}
    >
      <Tabs.List stretch>
        <Tabs.Tab value="official">
          {t('settings.agent.dialog.deepseek.officialTab', 'DeepSeek official')}
        </Tabs.Tab>
        <Tabs.Tab value="custom">
          {t('settings.agent.dialog.deepseek.customTab', 'Custom Endpoint')}
        </Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="official">
        <DeepSeekApiKeyField value={apiKey} onChange={onApiKeyChange} />
      </Tabs.Panel>
      <Tabs.Panel value="custom">
        <div {...stylex.props(styles.stack)}>
          <Field
            htmlFor="deepseek-endpoint"
            label={t('settings.agent.dialog.deepseek.endpointLabel', 'API Endpoint')}
            hint={t(
              'settings.agent.dialog.deepseek.endpointHelp',
              'Required HTTP or HTTPS URL. Saved as DEEPSEEK_BASE_URL without adding or removing /v1.'
            )}
          >
            <Input
              id="deepseek-endpoint"
              type="url"
              autoComplete="off"
              spellCheck={false}
              value={customBaseUrl}
              onChange={(event) => onCustomBaseUrlChange(event.target.value)}
              placeholder={t(
                'settings.agent.dialog.deepseek.endpointPlaceholder',
                'https://example.com'
              )}
            />
          </Field>
          <p {...stylex.props(styles.note)}>
            {t(
              'settings.agent.dialog.deepseek.modelsDiscovered',
              'Available models are discovered automatically from the endpoint when this provider is verified.'
            )}
          </p>
          <DeepSeekApiKeyField
            value={apiKey}
            onChange={onApiKeyChange}
            label={t('settings.agent.dialog.deepseek.customApiKeyLabel', 'API Key')}
          />
        </div>
      </Tabs.Panel>
    </Tabs.Root>
  );
}

function PresetPanel({
  preset,
  credentialMode,
  credentialModeId,
  onCredentialModeChange,
  token,
  onTokenChange,
  baseUrlOptionId,
  onBaseUrlOptionChange,
  customBaseUrl,
  onCustomBaseUrlChange,
  injectedEnv,
}: {
  preset: PresetDefinition;
  credentialMode: PresetCredentialMode | undefined;
  credentialModeId: string | undefined;
  onCredentialModeChange: (value: string) => void;
  token: string;
  onTokenChange: (value: string) => void;
  baseUrlOptionId: string | undefined;
  onBaseUrlOptionChange: (value: string) => void;
  customBaseUrl: string;
  onCustomBaseUrlChange: (value: string) => void;
  injectedEnv: Record<string, string>;
}) {
  const { t } = useTranslation();
  const credentialModes = preset.credentialModes ?? [];
  const baseUrlOption = getBaseUrlOption(credentialMode, baseUrlOptionId);
  const selectedBaseUrlOptionId = baseUrlOption?.id;
  const showCustomBaseUrl =
    !!credentialMode?.baseUrlEnvKey && baseUrlOption?.id === credentialMode.customBaseUrlOptionId;
  const tokenEnvKey = getPresetTokenEnvKey(preset, credentialMode);
  const [injectedOpen, setInjectedOpen] = useState(false);
  return (
    <div {...stylex.props(styles.stack)}>
      {credentialModes.length > 0 ? (
        <Field
          label={t(
            preset.credentialModeGroupLabelKey ?? 'settings.agent.dialog.preset.usageMethod',
            preset.credentialModeGroupLabelDefault ?? 'Usage method'
          )}
          hint={t(
            preset.credentialModeGroupHintKey ?? 'settings.agent.dialog.preset.usageMethodHint',
            preset.credentialModeGroupHintDefault ??
              'Choose the MiMo credential type you copied from the console.'
          )}
        >
          <RadioGroup
            value={credentialModeId ?? null}
            onValueChange={(value) => {
              if (typeof value === 'string') onCredentialModeChange(value);
            }}
          >
            {credentialModes.map((mode) => (
              <label key={mode.id} {...stylex.props(styles.radioRow)}>
                <span {...stylex.props(styles.radioBox)}>
                  <Radio value={mode.id} />
                </span>
                <span {...stylex.props(styles.radioText)}>
                  <span {...stylex.props(styles.radioLabel)}>
                    {t(mode.labelKey, mode.labelDefault)}
                  </span>
                  <span {...stylex.props(styles.radioHint)}>
                    {t(mode.descriptionKey, mode.descriptionDefault)}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </Field>
      ) : null}

      <Field
        htmlFor="preset-token"
        label={t(
          credentialMode?.tokenLabelKey ?? preset.tokenLabelKey,
          credentialMode?.tokenLabelDefault ?? preset.tokenLabelDefault
        )}
        hint={
          <>
            {t(
              credentialMode?.tokenHelpKey ?? preset.tokenHelpKey,
              credentialMode?.tokenHelpDefault ?? preset.tokenHelpDefault
            )}
            {preset.helpUrl ? (
              <>
                {' '}
                <a
                  href={preset.helpUrl}
                  target="_blank"
                  rel="noreferrer"
                  {...stylex.props(styles.link)}
                >
                  {t(
                    preset.helpLinkLabelKey ?? 'settings.agent.dialog.preset.helpLink',
                    preset.helpLinkLabelDefault ?? 'Open setup guide'
                  )}
                </a>
              </>
            ) : null}
          </>
        }
        icon={<KeyRound aria-hidden="true" {...stylex.props(catalog.icon)} />}
      >
        <Input
          id="preset-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder={t(
            credentialMode?.tokenPlaceholderKey ?? preset.tokenPlaceholderKey,
            credentialMode?.tokenPlaceholderDefault ?? preset.tokenPlaceholderDefault
          )}
        />
      </Field>

      {credentialMode?.baseUrlEnvKey && credentialMode.baseUrlOptions ? (
        <Field
          htmlFor={showCustomBaseUrl ? 'preset-base-url' : undefined}
          label={t(
            credentialMode.baseUrlLabelKey ?? 'settings.agent.dialog.preset.baseUrlLabelFallback',
            credentialMode.baseUrlLabelDefault ?? 'Base URL'
          )}
          hint={t(
            credentialMode.baseUrlHelpKey ?? 'settings.agent.dialog.preset.baseUrlHelpFallback',
            credentialMode.baseUrlHelpDefault ?? 'Select or enter the provider Base URL.'
          )}
        >
          <div {...stylex.props(styles.stackTight)}>
            <Select.Root
              items={credentialMode.baseUrlOptions.map((option) => ({
                value: option.id,
                label: t(option.labelKey, option.labelDefault),
              }))}
              value={selectedBaseUrlOptionId}
              onValueChange={(value) => {
                if (value != null) onBaseUrlOptionChange(value);
              }}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {credentialMode.baseUrlOptions.map((option) => (
                  <Select.Item key={option.id} value={option.id}>
                    {t(option.labelKey, option.labelDefault)}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            {showCustomBaseUrl ? (
              <Input
                id="preset-base-url"
                type="url"
                autoComplete="off"
                spellCheck={false}
                value={customBaseUrl}
                onChange={(e) => onCustomBaseUrlChange(e.target.value)}
                placeholder={t(
                  credentialMode.baseUrlPlaceholderKey ??
                    'settings.agent.dialog.preset.baseUrlPlaceholderFallback',
                  credentialMode.baseUrlPlaceholderDefault ?? 'https://example.com/anthropic'
                )}
              />
            ) : null}
          </div>
        </Field>
      ) : null}

      <Collapsible.Root open={injectedOpen} onOpenChange={setInjectedOpen}>
        <div {...stylex.props(styles.answer)}>
          <Collapsible.Trigger render={<Button type="button" variant="ghost" size="small" />}>
            <ChevronDown
              {...stylex.props(styles.disclosureIcon, injectedOpen && styles.disclosureIconOpen)}
            />
            {t('settings.agent.dialog.preset.showInjected', 'Show injected variables')}
            <Lock aria-hidden="true" {...stylex.props(styles.lockIcon)} />
          </Collapsible.Trigger>
        </div>
        <Collapsible.Panel>
          <div {...stylex.props(styles.revealed)}>
            <dl {...stylex.props(styles.envList)}>
              {Object.entries(injectedEnv).map(([key, value], index) => (
                <div key={key} {...stylex.props(styles.envRow, index > 0 && surface.lineRuled)}>
                  <dt {...stylex.props(styles.envKey)}>{key}</dt>
                  <dd {...stylex.props(styles.envValue)}>
                    {value || t('settings.agent.dialog.required', '(required)')}
                  </dd>
                </div>
              ))}
              <div
                {...stylex.props(
                  styles.envRow,
                  Object.keys(injectedEnv).length > 0 && surface.lineRuled
                )}
              >
                <dt {...stylex.props(styles.envKey)}>{tokenEnvKey}</dt>
                <dd {...stylex.props(styles.envValue)}>
                  {token.trim() ? '••••••••' : t('settings.agent.dialog.required', '(required)')}
                </dd>
              </div>
            </dl>
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
}

/**
 * The one button that checks the field beside it. At rest it says what it will
 * do (its tooltip, opening away from the field); while it works it spins; once
 * the check passed it is a tick; a failure is a warning. The glyphs cross-fade
 * in one box, so the button changes what it says, not where it is.
 */
function TestButton({
  label,
  status,
  disabled,
  onClick,
}: {
  label: string;
  status: 'idle' | 'testing' | 'ready' | 'error';
  disabled?: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  // The tooltip says what the glyph means now: the action at rest, the result
  // once there is one. Pressing it again always re-runs the check.
  const said = status === 'ready' ? t('settings.agent.dialog.ready', 'Ready') : label;
  const glyph = (shown: boolean, extra?: false | stylex.StyleXStyles) =>
    stylex.props(styles.testGlyph, shown && styles.testGlyphShown, extra);
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button
            type="button"
            variant="secondary"
            size="medium"
            icon
            aria-label={said}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        <span aria-hidden="true" {...stylex.props(styles.testGlyphs)}>
          <CirclePlay {...glyph(status === 'idle')} />
          <span {...glyph(status === 'testing')}>
            <Spinner size="small" />
          </span>
          <CircleCheck {...glyph(status === 'ready', styles.testGlyphReady)} />
          <CircleAlert {...glyph(status === 'error', styles.testGlyphError)} />
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content side="left">{said}</Tooltip.Content>
    </Tooltip.Root>
  );
}

function Section({
  title,
  count,
  children,
  disabled,
  disabledHint,
  defaultOpen,
  action,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  disabled?: boolean;
  disabledHint?: string;
  defaultOpen?: boolean;
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div {...stylex.props(styles.sectionItem)}>
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <div {...stylex.props(styles.sectionHead)}>
          <Collapsible.Trigger
            render={<button type="button" {...stylex.props(styles.sectionTrigger)} />}
          >
            <span {...stylex.props(styles.sectionTitle)}>{title}</span>
            {typeof count === 'number' && count > 0 ? (
              <span {...stylex.props(styles.sectionCount)}>{count}</span>
            ) : null}
          </Collapsible.Trigger>
          {action}
          <ChevronDown
            aria-hidden="true"
            {...stylex.props(
              styles.disclosureIcon,
              styles.sectionChevron,
              open && styles.disclosureIconOpen
            )}
          />
        </div>
        <Collapsible.Panel>
          <div {...stylex.props(styles.sectionBody)}>
            {disabled ? <p {...stylex.props(styles.sectionHint)}>{disabledHint}</p> : children}
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
}

function InlineCopyButton({ value, ariaLabel }: { value: string; ariaLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="small"
      icon
      aria-label={ariaLabel}
      onClick={(event) => {
        event.stopPropagation();
        if (!value) return;
        void navigator.clipboard.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        <Check {...stylex.props(styles.glyphFill)} />
      ) : (
        <Copy {...stylex.props(styles.glyphFill)} />
      )}
    </Button>
  );
}

function TitleGenerationFields({
  selectors,
  values,
  onChange,
}: {
  selectors: AcpConfigOptionSelector[];
  values: Record<string, AcpConfigOptionValue> | undefined;
  onChange: (configId: string, value: AcpConfigOptionValue) => void;
}) {
  const { t } = useTranslation();
  if (selectors.length === 0) return null;
  return (
    <div {...stylex.props(styles.optionList)}>
      {selectors.map((sel) => {
        const stored = values?.[sel.configId];
        if (sel.type === 'boolean') {
          const isEnabled = (stored ?? sel.currentValue) === true;
          return (
            <div key={sel.configId} {...stylex.props(styles.optionRow)}>
              <UiField.Label>{sel.label}</UiField.Label>
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => onChange(sel.configId, !isEnabled)}
                  aria-pressed={isEnabled}
                >
                  {isEnabled ? <Check {...stylex.props(catalog.iconSmall)} /> : null}
                  {isEnabled
                    ? t('agents.booleanEnabled', 'Enabled')
                    : t('agents.booleanDisabled', 'Disabled')}
                </Button>
              </div>
            </div>
          );
        }
        return (
          <div key={sel.configId} {...stylex.props(styles.optionRow)}>
            <UiField.Label>{sel.label}</UiField.Label>
            <Select.Root
              items={sel.options}
              value={(stored as string | undefined) ?? sel.currentValue}
              onValueChange={(value) => {
                if (value != null) onChange(sel.configId, value);
              }}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {sel.options.map((opt) => (
                  <Select.Item key={opt.value} value={opt.value}>
                    {opt.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </div>
        );
      })}
    </div>
  );
}

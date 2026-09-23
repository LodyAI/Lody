import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import type { MachineId, SupportedLanguage } from '@lody/shared';
import type { MobileKeyboardAction } from '@/lib/mobile-keyboard-action';
import { isSymbolFontFamily } from '@/lib/local-fonts';
import { SETTINGS_DEFAULT_TAB, type SettingsTabId } from '@/components/settings/settings-tabs';

export const languageAtom = atomWithStorage<SupportedLanguage>('lody-language', 'en');

export const DEFAULT_CONVERSATION_FONT_SIZE = 14;
/**
 * The sizes settings offers, ascending — five named tiers (smaller, small, default,
 * large, larger). Free-form entry is deliberately gone: a number field silently rewrote
 * whatever the user typed (clamped into a range, rounded), which reads as the app
 * fighting the keystrokes. A short scale has one value per visible step.
 */
export const CONVERSATION_FONT_SIZES = [12, 13, 14, 15, 16] as const;
export type ConversationFontSize = number;

const LEGACY_CONVERSATION_FONT_SIZES: Record<string, ConversationFontSize> = {
  small: 12,
  default: DEFAULT_CONVERSATION_FONT_SIZE,
  large: 16,
};

/**
 * Snaps to the nearest offered size (ties go up) so a value persisted by an older build —
 * a preset name, or any number the old input accepted — keeps the closest size the user
 * chose instead of collapsing to the default.
 */
export function normalizeConversationFontSize(value: unknown): ConversationFontSize {
  const migratedValue = typeof value === 'string' ? LEGACY_CONVERSATION_FONT_SIZES[value] : value;
  if (typeof migratedValue !== 'number' || !Number.isFinite(migratedValue)) {
    return DEFAULT_CONVERSATION_FONT_SIZE;
  }
  return CONVERSATION_FONT_SIZES.reduce((closest, size) =>
    Math.abs(size - migratedValue) <= Math.abs(closest - migratedValue) ? size : closest
  );
}

const conversationFontSizeStorageAtom = atomWithStorage<unknown>(
  'lody-conversation-font-size',
  DEFAULT_CONVERSATION_FONT_SIZE
);

export const conversationFontSizeAtom = atom(
  (get) => normalizeConversationFontSize(get(conversationFontSizeStorageAtom)),
  (_get, set, nextValue: ConversationFontSize) => {
    set(conversationFontSizeStorageAtom, normalizeConversationFontSize(nextValue));
  }
);

export const INTERFACE_FONT_FAMILY_MAX_LENGTH = 100;

export function normalizeInterfaceFontFamily(value: unknown): string {
  return typeof value === 'string' && !isSymbolFontFamily(value)
    ? value.trim().slice(0, INTERFACE_FONT_FAMILY_MAX_LENGTH)
    : '';
}

const interfaceFontFamilyStorageAtom = atomWithStorage<unknown>('lody-interface-font-family', '');

export const interfaceFontFamilyAtom = atom(
  (get) => normalizeInterfaceFontFamily(get(interfaceFontFamilyStorageAtom)),
  (_get, set, nextValue: string) => {
    set(interfaceFontFamilyStorageAtom, normalizeInterfaceFontFamily(nextValue));
  }
);

export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const TERMINAL_FONT_SIZE_MIN = 9;
export const TERMINAL_FONT_SIZE_MAX = 24;
export const TERMINAL_FONT_FAMILY_MAX_LENGTH = 100;

export function normalizeTerminalFontFamily(value: unknown): string {
  return typeof value === 'string' && !isSymbolFontFamily(value)
    ? value.trim().slice(0, TERMINAL_FONT_FAMILY_MAX_LENGTH)
    : '';
}

export function normalizeTerminalFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)));
}

const terminalFontFamilyStorageAtom = atomWithStorage<unknown>('lody-terminal-font-family', '');

export const terminalFontFamilyAtom = atom(
  (get) => normalizeTerminalFontFamily(get(terminalFontFamilyStorageAtom)),
  (_get, set, nextValue: string) => {
    set(terminalFontFamilyStorageAtom, normalizeTerminalFontFamily(nextValue));
  }
);

const terminalFontSizeStorageAtom = atomWithStorage<unknown>(
  'lody-terminal-font-size',
  DEFAULT_TERMINAL_FONT_SIZE
);

export const terminalFontSizeAtom = atom(
  (get) => normalizeTerminalFontSize(get(terminalFontSizeStorageAtom)),
  (_get, set, nextValue: number) => {
    set(terminalFontSizeStorageAtom, normalizeTerminalFontSize(nextValue));
  }
);

// Desktop settings modal open state. On desktop (non-mobile) the settings UI is a
// modal overlay driven by this atom instead of a full-page route. Mobile keeps the
// route-based settings page and ignores this atom.
export const settingsDialogOpenAtom = atom<boolean>(false);

// Which tab the desktop settings modal shows. Mirrors the route-based tab on mobile.
export const settingsActiveTabAtom = atom<SettingsTabId>(SETTINGS_DEFAULT_TAB);

// Optional resource targets used by Account shortcuts. Routes keep the same
// values in search params on mobile; the desktop modal keeps them here while
// switching between its Account, Agents, Projects, and machine-detail views.
export const settingsSelectedMachineIdAtom = atom<MachineId | null>(null);
export const settingsSelectedProjectKeyAtom = atom<string | null>(null);

// Notification prompt dismissed state - persisted to localStorage
// When true, the notification permission prompt will not be shown again
export const notificationPromptDismissedAtom = atomWithStorage<boolean>(
  'lody-notification-prompt-dismissed',
  false
);

// Desktop app: whether to send a native notification when an AI turn completes.
export const electronSessionCompletionNotificationsEnabledAtom = atomWithStorage<boolean>(
  'lody-electron-session-completion-notifications-enabled',
  true
);

// File viewer (Monaco) line-wrap toggle. Defaults on so a long single line
// (e.g. an unwrapped Markdown paragraph) stays readable without horizontal
// scrolling — especially on mobile. Shared by every SessionMonacoTextViewer
// mount via the viewer reading this atom directly.
export const fileViewerWordWrapAtom = atomWithStorage<boolean>('lody-file-viewer-word-wrap', true);

// Mobile composer keyboard return key behavior.
export const mobileKeyboardActionAtom = atomWithStorage<MobileKeyboardAction>(
  'lody-mobile-keyboard-action',
  'send'
);

// iOS app: whether to keep the conversation Live Activity / Dynamic Island enabled.
export const iosLiveActivitiesEnabledAtom = atomWithStorage<boolean>(
  'lody-ios-live-activities-enabled',
  true
);

// Sidebar session rows: show only source-code line changes when enabled.
export const sessionSidebarCodeChangesOnlyAtom = atomWithStorage<boolean>(
  'lody-session-sidebar-code-changes-only',
  false
);

export const QUEUED_MESSAGE_BEHAVIOR_VALUES = ['queue', 'guide'] as const;
export type QueuedMessageBehavior = (typeof QUEUED_MESSAGE_BEHAVIOR_VALUES)[number];

const queuedMessageBehaviorStorageAtom = atomWithStorage<string>(
  'lody-queued-message-behavior',
  'queue'
);

export const queuedMessageBehaviorAtom = atom(
  (get): QueuedMessageBehavior =>
    get(queuedMessageBehaviorStorageAtom) === 'guide' ? 'guide' : 'queue',
  (_get, set, nextValue: QueuedMessageBehavior) => {
    set(queuedMessageBehaviorStorageAtom, nextValue);
  }
);

// Auto-archive a session when its linked PR is merged. Per-user, browser-local.
export const autoArchiveOnPrMergedAtom = atomWithStorage<boolean>(
  'lody-auto-archive-on-pr-merged',
  false
);

// Auto-archive a session when its linked PR is closed (without merge). Per-user, browser-local.
export const autoArchiveOnPrClosedAtom = atomWithStorage<boolean>(
  'lody-auto-archive-on-pr-closed',
  false
);

/** localStorage keys for developer-only beta gates — keep in sync with the atoms below. */
export const DEVELOPER_MODE_STORAGE_KEY = 'lody-developer-mode-enabled';
export const INBOX_BETA_STORAGE_KEY = 'lody-inbox-beta-enabled';

// getOnInit samples storage when the atom module loads so a cold SPA boot
// already has the right init value.
export const developerModeEnabledAtom = atomWithStorage<boolean>(
  DEVELOPER_MODE_STORAGE_KEY,
  false,
  undefined,
  { getOnInit: true }
);

// Opt-in for the unfinished mobile Inbox. Reachable only from the beta section
// while Developer mode is on.
export const inboxBetaEnabledAtom = atomWithStorage<boolean>(
  INBOX_BETA_STORAGE_KEY,
  false,
  undefined,
  { getOnInit: true }
);

/** The single gate for showing the unfinished mobile Inbox entry. */
export const inboxFeatureEnabledAtom = atom(
  (get) => get(developerModeEnabledAtom) && get(inboxBetaEnabledAtom)
);

// Developer-only opt-in. Turning Developer mode off retains the local choice.
export const promptShortcutsBetaEnabledAtom = atomWithStorage<boolean>(
  'lody-prompt-shortcuts-beta-enabled',
  false,
  undefined,
  { getOnInit: true }
);

/** Shared gate for Shortcut settings, discovery and the workspace runtime. */
export const promptShortcutsFeatureEnabledAtom = atom(
  (get) => get(developerModeEnabledAtom) && get(promptShortcutsBetaEnabledAtom)
);

export const semanticShortcutsBetaEnabledAtom = atomWithStorage<boolean>(
  'lody-semantic-shortcuts-beta-enabled',
  false,
  undefined,
  { getOnInit: true }
);

export const semanticShortcutsFeatureEnabledAtom = atom(
  (get) => get(developerModeEnabledAtom) && get(semanticShortcutsBetaEnabledAtom)
);

/** localStorage keys for the experimental features gate. */
export const EXPERIMENTAL_FEATURES_STORAGE_KEY = 'lody-experimental-features-enabled';
export const REVIEW_AGENT_EXPERIMENT_STORAGE_KEY = 'lody-review-agent-enabled';

/**
 * Master switch for user-facing experimental features.
 *
 * Deliberately NOT behind Developer mode. That gate is for internal diagnostics
 * and is reached by a hidden gesture, which is the right shape for a debug
 * surface and the wrong one for a feature people are meant to find and try.
 * Experimental features are opt-in, not hidden.
 */
export const experimentalFeaturesEnabledAtom = atomWithStorage<boolean>(
  EXPERIMENTAL_FEATURES_STORAGE_KEY,
  false,
  undefined,
  { getOnInit: true }
);

/** Opt-in for the review agent, listed once experimental features are on. */
export const reviewAgentExperimentEnabledAtom = atomWithStorage<boolean>(
  REVIEW_AGENT_EXPERIMENT_STORAGE_KEY,
  false,
  undefined,
  { getOnInit: true }
);

/**
 * The single gate every review-agent surface reads.
 *
 * Note what this gate does NOT control: a run already authorized on a session
 * keeps going, because the authorization is durable session state that the
 * machine acts on, and this switch is per-device UI visibility. Turning the
 * experiment off hides the controls; it does not silently abandon a branch the
 * user was told would be merged.
 */
export const reviewAgentFeatureEnabledAtom = atom(
  (get) => get(experimentalFeaturesEnabledAtom) && get(reviewAgentExperimentEnabledAtom)
);

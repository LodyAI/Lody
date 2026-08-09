import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import type { SupportedLanguage } from '@lody/shared';
import type { MobileKeyboardAction } from '@/lib/mobile-keyboard-action';
import {
  SETTINGS_DEFAULT_TAB,
  type SettingsTabId,
} from '@/components/settings/settings-tabs';

export const languageAtom = atomWithStorage<SupportedLanguage>('lody-language', 'en');

export const CONVERSATION_FONT_SIZE_VALUES = ['small', 'default', 'large'] as const;
export type ConversationFontSize = (typeof CONVERSATION_FONT_SIZE_VALUES)[number];

export function isConversationFontSize(value: unknown): value is ConversationFontSize {
  return (
    typeof value === 'string' &&
    (CONVERSATION_FONT_SIZE_VALUES as readonly string[]).includes(value)
  );
}

export function normalizeConversationFontSize(value: unknown): ConversationFontSize {
  return isConversationFontSize(value) ? value : 'default';
}

const conversationFontSizeStorageAtom = atomWithStorage<string>(
  'lody-conversation-font-size',
  'default'
);

export const conversationFontSizeAtom = atom(
  (get) => normalizeConversationFontSize(get(conversationFontSizeStorageAtom)),
  (_get, set, nextValue: ConversationFontSize) => {
    set(conversationFontSizeStorageAtom, nextValue);
  }
);

export const INTERFACE_FONT_FAMILY_MAX_LENGTH = 100;

export function normalizeInterfaceFontFamily(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, INTERFACE_FONT_FAMILY_MAX_LENGTH) : '';
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
  return typeof value === 'string' ? value.trim().slice(0, TERMINAL_FONT_FAMILY_MAX_LENGTH) : '';
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
export const fileViewerWordWrapAtom = atomWithStorage<boolean>(
  'lody-file-viewer-word-wrap',
  true
);

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
export const TASKS_BETA_STORAGE_KEY = 'lody-tasks-beta-enabled';
export const INBOX_BETA_STORAGE_KEY = 'lody-inbox-beta-enabled';

/**
 * Synchronous read of the Tasks feature gate from localStorage.
 *
 * `atomWithStorage` without a settled store can still report its default on the
 * first paint (and `getOnInit` only samples storage once at module load, so a
 * test or late write is invisible). Route guards that redirect on `false` must
 * use this on that first frame so a bookmarked `/tasks/$taskId` is not bounced
 * to chat before hydration finishes.
 */
export function readTasksFeatureEnabledFromStorage(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const developerMode = JSON.parse(
      localStorage.getItem(DEVELOPER_MODE_STORAGE_KEY) ?? 'false'
    );
    const tasksBeta = JSON.parse(localStorage.getItem(TASKS_BETA_STORAGE_KEY) ?? 'false');
    return developerMode === true && tasksBeta === true;
  } catch {
    return false;
  }
}

// getOnInit samples storage when the atom module loads so a cold SPA boot
// (the deep-link case) already has the right init value.
export const developerModeEnabledAtom = atomWithStorage<boolean>(
  DEVELOPER_MODE_STORAGE_KEY,
  false,
  undefined,
  { getOnInit: true }
);

// Opt-in for the Tasks beta. Reachable only from the beta section of Settings,
// which itself only renders while Developer mode is on.
export const tasksBetaEnabledAtom = atomWithStorage<boolean>(
  TASKS_BETA_STORAGE_KEY,
  false,
  undefined,
  { getOnInit: true }
);

/**
 * The single gate every Tasks surface reads — sidebar entry, routes, commands,
 * quick-add, index sync, status watcher, session task chip, and the agent's task
 * proposal card. When it is false the feature must be indistinguishable from one
 * that was never built.
 *
 * Developer mode is part of the condition, not merely the way to reach the
 * switch: turning Developer mode off has to hide Tasks again, and it does so
 * without discarding the opt-in, so turning it back on restores the choice.
 */
export const tasksFeatureEnabledAtom = atom(
  (get) => get(developerModeEnabledAtom) && get(tasksBetaEnabledAtom)
);

// Opt-in for the unfinished mobile Inbox. Like Tasks, this is reachable only
// from the beta section while Developer mode is on.
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

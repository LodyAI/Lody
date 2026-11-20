import {
  Archive,
  ArrowDown,
  ArrowLeft,
  CalendarDays,
  ArrowRight,
  ArrowUp,
  AtSign,
  Bot,
  Brain,
  ChevronsLeft,
  ChevronsRight,
  Command,
  Focus,
  FolderInput,
  GitBranch,
  Info,
  Link,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  Plus,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  SquarePen,
  SquareTerminal,
  SunMoon,
  TextCursorInput,
  TextSearch,
} from 'lucide-react';
import type { PaletteIcon } from './command-palette-view';

/**
 * What each command does, as a glyph in the ⌘K palette. Keyed by command id
 * rather than stored on the command, because a built-in placeholder and the
 * component that later registers the real command under the same id must show
 * the same glyph. The glyph names the action — the same one the product uses
 * for it elsewhere where it has one (the sidebar toggle, the terminal, a pin) —
 * and a command missing here gets an empty column, never a generic stand-in:
 * one glyph on every row is a column of noise.
 */
export const COMMAND_ICONS: Record<string, PaletteIcon> = {
  'nav.back': ArrowLeft,
  'nav.forward': ArrowRight,
  'workspace.openSettings': Settings,
  'workspace.openAboutSettings': Info,
  'app.cycleTheme': SunMoon,
  'layout.toggleZenMode': Focus,
  'palette.toggle': Command,
  'project.importLocal': FolderInput,
  'sidebar.toggle': PanelLeft,
  'session.new': SquarePen,
  'today.open': CalendarDays,
  'session.archiveCurrent': Archive,
  'session.toggleCurrentPinned': Pin,
  'session.searchCurrent': TextSearch,
  'session.focusInput': TextCursorInput,
  'session.toggleExplorerSidebar': PanelRight,
  'session.copyCurrentBranch': GitBranch,
  'session.copyUrl': Link,
  'session.renameCurrent': Pencil,
  'session.newTabOrTerminal': Plus,
  'session.toggleTerminal': SquareTerminal,
  'session.saveCurrentFile': Save,
  'session.nextTab': ChevronsRight,
  'session.previousTab': ChevronsLeft,
  'session.previousVisible': ArrowUp,
  'session.nextVisible': ArrowDown,
  'session.cycleMode': ShieldCheck,
  'session.cycleProvider': Bot,
  'session.cycleModel': Sparkles,
  'session.cycleThinkEffort': Brain,
  'mention.toggleSessionProjectScope': AtSign,
};

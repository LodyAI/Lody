import { normalizeWorktreePathsInText } from '@/lib/worktree-path';

type TerminalCommandLike = { command?: unknown; args?: readonly unknown[] | null };

/** `bash`, `/bin/zsh`, `/usr/bin/sh`… — a shell that only wraps the real script. */
const SHELL_WRAPPER = /^(?:\/(?:usr\/)?(?:local\/)?bin\/)?(?:bash|sh|zsh|dash|fish)$/u;
/** `-c`, `-lc`, `-cl`: the flag after which the shell's one argument is the script. */
const SHELL_SCRIPT_FLAG = /^-(?:l?c|cl)$/u;
const SHELL_SAFE_WORD = /^[\w@%+=:,./~-]+$/u;

const quoteShellWord = (word: string) =>
  word === '' ? "''" : SHELL_SAFE_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * The command a reader would have typed. Codex stores `["/bin/bash", "-lc",
 * "<script>"]`; showing the wrapper put one fixed prefix in front of every
 * command and made the script one quoted word, so the highlighter coloured it
 * as a string. Any other argv is joined with the quoting a shell needs, so a
 * pattern with a space reads as one argument, not two. Session worktree roots
 * shorten to `.` the way the step's title already does.
 */
export function formatToolCommand(block: TerminalCommandLike): string {
  const command = normalizeWorktreePathsInText(String(block.command ?? ''));
  const args = (block.args ?? []).map((arg) => normalizeWorktreePathsInText(String(arg)));
  if (SHELL_WRAPPER.test(command)) {
    const [first, second, third] = args;
    if (args.length === 2 && first && SHELL_SCRIPT_FLAG.test(first)) return second ?? '';
    if (args.length === 3 && first === '-l' && second === '-c') return third ?? '';
  }
  if (args.length === 0) return command;
  return [command, ...args.map(quoteShellWord)].filter(Boolean).join(' ');
}

const collapseWhitespace = (value: string) => value.replace(/\s+/gu, ' ').trim();

const stripFence = (value: string) => {
  const fenced = extractFencedToolText(value);
  if (fenced !== null) return fenced;
  const inline = /^`([^`]+)`$/u.exec(value.trim());
  return inline ? (inline[1] ?? '') : value;
};

/**
 * Whether a tool's text block only restates its command. Some agents send the
 * command as a text block beside the structured one, and that block used to
 * render as Markdown above the command itself — the same script twice, the
 * first copy with `*` read as emphasis and paths turned into file chips.
 */
export function isToolCommandEcho(text: string, commands: readonly string[]): boolean {
  const echoed = collapseWhitespace(normalizeWorktreePathsInText(stripFence(text)));
  if (!echoed) return false;
  return commands.some((command) => collapseWhitespace(command) === echoed);
}

/** ToolSearch returns a machine-readable reference, not prose from the agent. */
export function isToolSearchTitle(title: string | null | undefined): boolean {
  return title?.replace(/[\s_-]+/gu, '').toLowerCase() === 'toolsearch';
}

/**
 * The body of a text result that is exactly one fenced block (a terminal
 * snapshot, a file excerpt). It is machine text, so it renders verbatim rather
 * than as a Markdown code block inside the tool's own sheet.
 */
export function extractFencedToolText(text: string): string | null {
  const fenced = /^```[^\n`]*\n([\s\S]*?)\n?```\s*$/u.exec(text.trim());
  return fenced ? (fenced[1] ?? '') : null;
}

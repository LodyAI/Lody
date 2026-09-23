/**
 * Quotes one argv token for the custom-agent command line typed into the
 * desktop settings dialog. The dialog tokenizes that line with the shared
 * POSIX-style parser (`parseCustomAcpCommandLine`), where an unquoted
 * backslash escapes the next character — so Windows paths like
 * `D:\a\agent.mjs` must always be emitted inside double quotes with `\`
 * doubled, or every `\x` is silently eaten and the spawned command resolves
 * to a nonexistent executable (ENOENT). This is why the allowlist below
 * deliberately excludes `\`: any value containing a backslash gets quoted.
 */
export function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/u.test(value)) return value;
  return `"${value.replace(/["\\]/gu, '\\$&')}"`;
}

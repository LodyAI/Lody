import { z } from 'zod';

/**
 * NOTE: This schema is NOT part of ACP.
 *
 * Claude Code ACP uses a different format than Codex for `rawInput/rawOutput` and
 * uses `_meta.claudeCode` for tool responses. This module handles parsing those
 * Claude Code-specific structures.
 *
 * `rawInput/rawOutput` are explicitly unstructured in the ACP spec, and their
 * shape is implementation-defined.
 *
 * We validate + parse defensively and use this as a best-effort fallback.
 */

// Claude Code rawInput for Bash tool
export const ClaudeCodeBashRawInputSchema = z
  .object({
    command: z.string().optional(),
    description: z.string().optional(),
    timeout: z.number().optional(),
  })
  .passthrough();

export type ClaudeCodeBashRawInput = z.infer<typeof ClaudeCodeBashRawInputSchema>;

// Claude Code Bash toolResponse (v0.19+): {stdout, stderr, interrupted, ...}
export const ClaudeCodeBashToolResponseSchema = z
  .object({
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    interrupted: z.boolean().optional(),
    isImage: z.boolean().optional(),
    noOutputExpected: z.boolean().optional(),
  })
  .passthrough()
  .refine((data) => data.stdout !== undefined || data.stderr !== undefined, {
    message: 'At least one of stdout or stderr must be present',
  });

export type ClaudeCodeBashToolResponse = z.infer<typeof ClaudeCodeBashToolResponseSchema>;

// Legacy toolResponse format (pre-v0.19): [{type, text}]
const LegacyToolResponseSchema = z.array(
  z.object({
    type: z.string(),
    text: z.string().optional(),
  })
);

// Claude Code _meta structure
// `toolResponse` is tool-specific and unstructured — we accept `unknown` and parse per-tool.
export const ClaudeCodeMetaSchema = z
  .object({
    claudeCode: z
      .object({
        toolName: z.string().optional(),
        toolResponse: z.unknown().optional(),
      })
      .optional(),
  })
  .passthrough();

export type ClaudeCodeMeta = z.infer<typeof ClaudeCodeMetaSchema>;

/**
 * Parse Claude Code terminal command from rawInput.
 *
 * Claude Code uses a simpler format than Codex:
 * - `command`: the shell command string
 * - `description`: human-readable description
 * - `timeout`: optional timeout in ms
 */
export const parseClaudeCodeTerminalCommand = (
  rawInput: unknown
): { command: string; args: string[]; cwd?: string } | null => {
  const parsed = ClaudeCodeBashRawInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return null;
  }

  const value = parsed.data;
  if (typeof value.command !== 'string' || value.command.length === 0) {
    return null;
  }

  return {
    command: value.command,
    args: [],
    cwd: undefined,
  };
};

/**
 * Parse Claude Code terminal output from _meta.claudeCode.toolResponse.
 *
 * Claude Code puts tool responses in `_meta.claudeCode.toolResponse` rather than `rawOutput`.
 *
 * v0.19+ format (current): `{stdout, stderr, interrupted, isImage, noOutputExpected}`
 * Pre-v0.19 format (legacy): `[{type: "text", text: "Exited with code 0.Final output:\n\n..."}]`
 */
export const parseClaudeCodeTerminalOutput = (
  meta: unknown
): {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
} | null => {
  const parsed = ClaudeCodeMetaSchema.safeParse(meta);
  if (!parsed.success) {
    return null;
  }

  const claudeCode = parsed.data.claudeCode;
  if (!claudeCode?.toolResponse) {
    return null;
  }

  const toolResponse = claudeCode.toolResponse;

  // v0.19+ format: {stdout, stderr, interrupted, ...}
  const bashParsed = ClaudeCodeBashToolResponseSchema.safeParse(toolResponse);
  if (bashParsed.success) {
    const data = bashParsed.data;
    return {
      stdout: data.stdout,
      stderr: data.stderr,
      exitCode: undefined, // exit code comes from rawOutput or status in v0.19+
      truncated: undefined,
    };
  }

  // Legacy format (pre-v0.19): [{type: "text", text: "Exited with code ..."}]
  const legacyParsed = LegacyToolResponseSchema.safeParse(toolResponse);
  if (legacyParsed.success) {
    const textResponse = legacyParsed.data.find(
      (r) => r.type === 'text' && typeof r.text === 'string'
    );
    if (textResponse?.text) {
      return parseLegacyTerminalOutputText(textResponse.text);
    }
  }

  return null;
};

/**
 * Parse legacy "Exited with code X.Final output:\n\n<output>" text format.
 */
const parseLegacyTerminalOutputText = (
  text: string
): { output?: string; exitCode?: number; truncated?: boolean } => {
  // "Exited with code X.Final output:\n\n<output>"
  const exitMatch = text.match(/^Exited with code (\d+)\.(?:Final output:)?\s*\n\n?([\s\S]*)$/);
  if (exitMatch) {
    return {
      output: exitMatch[2] ?? '',
      exitCode: parseInt(exitMatch[1] ?? '0', 10),
      truncated: false,
    };
  }

  // Truncated variant
  const truncatedMatch = text.match(
    /^Exited with code (\d+)\.(?:Final output \(truncated\):)?\s*\n\n?([\s\S]*)$/
  );
  if (truncatedMatch) {
    return {
      output: truncatedMatch[2] ?? '',
      exitCode: parseInt(truncatedMatch[1] ?? '0', 10),
      truncated: true,
    };
  }

  // Fallback: treat entire text as output
  return { output: text, exitCode: undefined, truncated: false };
};

/**
 * Check if the tool is a Claude Code tool based on _meta.
 */
export const isClaudeCodeTool = (meta: unknown): boolean => {
  if (!meta || typeof meta !== 'object') return false;
  const record = meta as Record<string, unknown>;
  return record.claudeCode !== undefined;
};

/**
 * Get Claude Code tool name from _meta.
 */
export const getClaudeCodeToolName = (meta: unknown): string | undefined => {
  const parsed = ClaudeCodeMetaSchema.safeParse(meta);
  if (!parsed.success) return undefined;
  return parsed.data.claudeCode?.toolName;
};

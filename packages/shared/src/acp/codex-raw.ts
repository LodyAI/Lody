import { z } from 'zod';

/**
 * NOTE: This schema is NOT part of ACP.
 *
 * `rawInput/rawOutput` are explicitly unstructured in the ACP spec, and their
 * shape is implementation-defined. The Codex ACP agent currently reports a
 * Node-shell execution result with a particular object structure.
 *
 * We validate + parse it defensively and only use it as a best-effort fallback
 * when the agent does not use ACP terminals RPCs.
 *
 * Keep this file small, and keep the e2e assertion that detects drift.
 */

const CodexShellCommandArraySchema = z.array(z.string()).min(1);

export const CodexToolRawInputSchema = z
  .object({
    command: z.union([CodexShellCommandArraySchema, z.string()]).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  })
  .passthrough();

export type CodexToolRawInput = z.infer<typeof CodexToolRawInputSchema>;

export const CodexToolRawOutputSchema = z
  .object({
    exit_code: z.number().optional(),
    exitCode: z.number().optional(),
    truncated: z.boolean().optional(),
    aggregated_output: z.string().optional(),
    output: z.string().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    formatted_output: z.string().optional(),
  })
  .passthrough()
  .refine(
    (v) =>
      v.exit_code !== undefined ||
      v.exitCode !== undefined ||
      v.aggregated_output !== undefined ||
      v.output !== undefined ||
      v.stdout !== undefined ||
      v.stderr !== undefined,
    {
      message: 'Expected codex raw output to include at least one output/exit field',
    }
  );

export type CodexToolRawOutput = z.infer<typeof CodexToolRawOutputSchema>;

export const parseCodexTerminalCommand = (
  rawInput: unknown
): { command: string; args: string[]; cwd?: string } | null => {
  const parsed = CodexToolRawInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return null;
  }
  const value = parsed.data;
  const cwd = value.cwd;

  if (Array.isArray(value.command)) {
    const [command, ...args] = value.command;
    if (!command) return null;
    return { command, args, cwd };
  }

  if (typeof value.command === 'string') {
    return { command: value.command, args: value.args ?? [], cwd };
  }

  return null;
};

export const parseCodexTerminalOutput = (
  rawOutput: unknown
): {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
} | null => {
  const parsed = CodexToolRawOutputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    return null;
  }

  const value = parsed.data;
  const exitCode = value.exit_code ?? value.exitCode;
  const output = value.output ?? value.aggregated_output ?? value.formatted_output;

  return {
    output,
    stdout: value.stdout,
    stderr: value.stderr,
    exitCode,
    truncated: value.truncated,
  };
};

import { z } from 'zod';
import { runCommandTextLegacy } from '@lody/shared/node/process';
import { getLoginShellEnvLegacy } from '@/agent/login-shell-env';
import { toShared } from '@/platform/process-options';
import { withEverMeNode } from './everme-node';

/**
 * The commands memory providers run, kept apart from the provider registry so
 * an adapter can take its runner without importing the registry that lists it.
 */
type CommandResult = { stdout: string; stderr?: string; code?: string | number };
export type MemoryCommandRunner = (args: string[]) => Promise<CommandResult>;
/**
 * A package manager running a package's script exports its own settings as
 * `npm_config_*`, and `npm_config_prefix` among them names that package's own
 * directory. A nested `npm install --global` reads it as its own prefix, so
 * the install lands inside the checkout instead of on the machine and nothing
 * can find it afterwards. Observed with `pnpm run` driving Lody from source.
 * The child gets the machine's npm configuration, never the parent's.
 */
export const withoutInheritedPackageManagerConfig = (
  env: Record<string, string | undefined>
): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_config_/i.test(key)));

const createCommandRunner =
  (
    command: string,
    timeout: number,
    prepareEnv?: (env: Record<string, string | undefined>) => Record<string, string | undefined>
  ): MemoryCommandRunner =>
  async (args) => {
    try {
      const inherited = { ...process.env, ...(await getLoginShellEnvLegacy()) };
      const result = await runCommandTextLegacy(
        {
          command,
          args,
          check: 'none',
          env: prepareEnv ? prepareEnv(inherited) : inherited,
          timeout,
          maxOutputBytes: 1024 * 1024,
        },
        toShared()
      );
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code === 0 ? undefined : (result.code ?? 'failed'),
      };
    } catch (error) {
      const parsed = z
        .object({
          code: z.union([z.string(), z.number()]).optional(),
          stdout: z.string().optional(),
          stderr: z.string().optional(),
        })
        .safeParse(error);
      return {
        stdout: parsed.success ? (parsed.data.stdout ?? '') : '',
        stderr: parsed.success ? parsed.data.stderr : undefined,
        code: parsed.success ? (parsed.data.code ?? 'failed') : 'failed',
      };
    }
  };
export const runNmem = createCommandRunner('nmem', 15_000);
/** Connecting reaches EverMe's backend to register the agent, so it is slower. */
export const runEvercli = createCommandRunner('evercli', 20_000, (env) =>
  withEverMeNode(withoutInheritedPackageManagerConfig(env))
);
/**
 * Installing fetches a release binary over whatever connection the machine
 * has, so it gets a wall-clock budget rather than a request-sized one; the
 * job outlives the reply that started it either way.
 */
export const runNpm = createCommandRunner('npm', 10 * 60_000, (env) =>
  withEverMeNode(withoutInheritedPackageManagerConfig(env))
);

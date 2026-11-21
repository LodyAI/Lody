/**
 * glibc gives every thread that contends on malloc its own arena (up to 8 per core) and
 * returns little of a freed arena to the OS, so a long-lived daemon's RSS ratchets up
 * after any peak. The daemon's own Node processes cap arenas at two. glibc reads the
 * limit once at process start, so each child removes it again from its environment and
 * Agents, terminals and user commands it launches keep the caller's allocator settings.
 */
const MALLOC_ARENA_MAX_ENV = 'MALLOC_ARENA_MAX';
const SCOPED_MALLOC_ARENA_MAX_ENV = 'LODY_SCOPED_MALLOC_ARENA_MAX';
const DAEMON_MALLOC_ARENA_MAX = '2';

/** Environment for a daemon-owned Node child; an explicit caller value is kept as is. */
export const withDaemonMallocArenaLimit = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv =>
  platform !== 'linux' || env[MALLOC_ARENA_MAX_ENV] !== undefined
    ? env
    : {
        ...env,
        [MALLOC_ARENA_MAX_ENV]: DAEMON_MALLOC_ARENA_MAX,
        [SCOPED_MALLOC_ARENA_MAX_ENV]: '1',
      };

/** Called at process start: drops a limit the daemon injected, before anything is spawned. */
export const releaseScopedMallocArenaLimit = (env: NodeJS.ProcessEnv = process.env): void => {
  if (env[SCOPED_MALLOC_ARENA_MAX_ENV] !== '1') return;
  delete env[SCOPED_MALLOC_ARENA_MAX_ENV];
  delete env[MALLOC_ARENA_MAX_ENV];
};

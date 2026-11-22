import path from 'node:path';

export const ps = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const getWindowsPowerShellExecutable = (env: NodeJS.ProcessEnv = process.env): string =>
  path.win32.join(
    env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );

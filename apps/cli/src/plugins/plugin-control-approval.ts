import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runCommandTextLegacy } from '@lody/shared/node/process';
import { z } from 'zod';

const command = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('install'),
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({ action: z.literal('link'), path: z.string().min(1), dev: z.literal(true) }),
  z.strictObject({
    action: z.literal('remove'),
    pluginId: z.string().min(1),
    purgeData: z.literal(true).optional(),
  }),
  z.strictObject({
    action: z.enum(['reload', 'disable', 'rollback', 'logs']),
    pluginId: z.string().min(1),
  }),
]);
export const pluginControlEnvelope = z.strictObject({
  command,
  encryptedWorkspaceId: z.string().min(1).optional(),
});

export type PluginControlEnvelope = z.infer<typeof pluginControlEnvelope>;

/** The native dialog belongs to the daemon. Nothing supplied by the socket caller is an approval. */
export function makePluginApproval() {
  let pending = false;
  return async (request: object, signal?: AbortSignal) => {
    if (pending || signal?.aborted) return false;
    const summary = JSON.stringify(
      request,
      (key, value) => (key === 'changes' && value ? Object.keys(value) : value),
      2
    );
    if (summary.length > 4096 || /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(summary))
      return false;
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const text = `Allow this Lody plugin action once?\n${summary}\nRequest SHA-256: ${digest}`;
    pending = true;
    try {
      let spec;
      if (process.platform === 'darwin')
        spec = {
          command: '/usr/bin/osascript',
          args: [
            '-e',
            'on run argv\ndisplay dialog (item 1 of argv) with title "Lody plugin approval" buttons {"Deny", "Allow once"} default button "Deny" cancel button "Deny"\nend run',
            text,
          ],
        };
      else if (process.platform === 'linux')
        spec = {
          command: '/usr/bin/zenity',
          args: [
            '--question',
            '--no-markup',
            '--default-cancel',
            '--title=Lody plugin approval',
            `--text=${text}`,
          ],
        };
      else if (process.platform === 'win32' && process.env.SystemRoot)
        spec = {
          command: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Add-Type -AssemblyName PresentationFramework; if ([System.Windows.MessageBox]::Show($env:LODY_PLUGIN_APPROVAL_TEXT,'Lody plugin approval','YesNo','Question','No') -ne 'Yes') { exit 1 }`,
          ],
          env: { ...process.env, LODY_PLUGIN_APPROVAL_TEXT: text },
        };
      if (!spec) return false;
      const result = await runCommandTextLegacy({
        ...spec,
        check: 'none',
        timeout: 45000,
        maxOutputBytes: 2048,
      });
      return result.code === 0 && !signal?.aborted;
    } catch {
      return false;
    } finally {
      pending = false;
    }
  };
}

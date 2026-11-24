import path from 'node:path';
import { Effect } from 'effect';
import { Command } from 'commander';
import inquirer from 'inquirer';
import type { MachineId } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { makeLocalControlClientAuto } from '@lody/shared/node/local-ipc';
import { getCliPlatformKind } from '@/lib/cli-platform';
import {
  getAuthContextOrThrow,
  printJson,
  resolveWorkspaceOrThrow,
  runOneShotCommand,
  withWorkspaceManager,
} from '@/lib/command-runtime';
import { makeLocalWorkspaceCatalog } from '@/lib/local-workspace-catalog';
import { daemonBundleWorkspace } from '@/lib/workspace-bundle/daemon';
import type { ImportPlan, RoomPlan } from '@/lib/workspace-bundle/import';
import type { BundleKind } from '@lody/shared/workspace-bundle-control';
import {
  runWorkspaceExport,
  runWorkspaceImport,
  type ExportSummary,
  type ImportOutcome,
} from '@/lib/workspace-bundle/service';
import { version } from '@/pkg';

/** Bundles can be large; the daemon reports only when the whole operation ends. */
const DAEMON_BUNDLE_TIMEOUT_MS = 60 * 60 * 1000;

const SKIP_REASONS: Record<string, string> = {
  'unrelated-same-id': 'same ID, unrelated history',
  'deleted-in-target': 'deleted in this workspace',
  'machine-room': 'machine settings stay with their machine',
  'roost-exists': 'this workspace already has this Roost conversation',
};

const KIND_NAMES: Record<BundleKind, string> = {
  conversations: 'Conversations',
  schedules: 'Schedules',
  previewComments: 'Preview comments',
  catalog: 'Projects, Agent Roles and MCP',
  machines: 'Machine settings',
  other: 'Other data',
};

export function formatImportPlan(plan: ImportPlan): string {
  const lines = [`From workspace ${plan.sourceWorkspaceId} into ${plan.targetWorkspaceId}`];
  for (const kind of Object.keys(KIND_NAMES) as BundleKind[]) {
    const rooms = plan.rooms.filter((room) => room.kind === kind && room.counted);
    if (rooms.length === 0) continue;
    const count = (match: (room: RoomPlan) => boolean, label: string) => {
      const n = rooms.filter(match).length;
      return n > 0 ? [`${n} ${label}`] : [];
    };
    const parts = [
      ...count((room) => room.action === 'merge' && room.state === 'new', 'new'),
      ...count((room) => room.action === 'merge' && room.state === 'merge', 'updated'),
      ...count((room) => room.action === 'merge' && room.state === 'unchanged', 'already here'),
      ...count((room) => room.action === 'skip', 'skipped'),
    ];
    lines.push(`${KIND_NAMES[kind]}: ${parts.join(', ')}`);
  }
  for (const room of plan.rooms) {
    if (room.action !== 'skip') continue;
    const kindName = KIND_NAMES[room.kind].charAt(0).toLowerCase() + KIND_NAMES[room.kind].slice(1);
    const name = room.label ? `"${room.label}" (${kindName})` : kindName;
    lines.push(`Skipped ${name}: ${room.detail ?? SKIP_REASONS[room.reason ?? ''] ?? room.reason}`);
  }
  for (const gap of plan.gaps)
    lines.push(`Not in this bundle: ${gap.id} (${gap.kind}): ${gap.reason}`);
  return lines.join('\n');
}

const PLAINTEXT_WARNING =
  'The bundle contains every conversation and attachment in plain text. Anyone with the file can read it.';

type Target =
  | { kind: 'local'; machineId: MachineId; workspaceId: string }
  | { kind: 'cloud'; selector: string | undefined };

async function resolveTarget(selector: string | undefined): Promise<Target> {
  if (getCliPlatformKind() !== 'local') return { kind: 'cloud', selector };
  const catalog = await Effect.runPromise(makeLocalWorkspaceCatalog().read());
  const wanted = selector ?? process.env.LODY_WORKSPACE_ID;
  const candidates = catalog.workspaces.filter(
    (row) =>
      row.state === 'active' && (!wanted || [row.workspaceId, row.slug, row.name].includes(wanted))
  );
  const workspace = candidates.length === 1 ? candidates[0] : undefined;
  if (!workspace || !catalog.machine)
    throw new Error('Choose an active workspace with --workspace; start the daemon first');
  return {
    kind: 'local',
    machineId: catalog.machine.machineId as MachineId,
    workspaceId: workspace.workspaceId,
  };
}

async function viaDaemon(
  request: Parameters<ReturnType<typeof makeLocalControlClientAuto>['workspaceBundleControl']>[0]
): Promise<unknown> {
  const response = await Effect.runPromise(
    makeLocalControlClientAuto().workspaceBundleControl(request, {
      timeoutMs: DAEMON_BUNDLE_TIMEOUT_MS,
    })
  );
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

async function exportBundle(target: Target, out: string, offline: boolean): Promise<ExportSummary> {
  if (target.kind === 'local')
    return (await viaDaemon({
      operation: 'export',
      machineId: target.machineId,
      workspaceId: target.workspaceId,
      out,
    })) as ExportSummary;
  const auth = getAuthContextOrThrow('workspace-export');
  const workspace = await resolveWorkspaceOrThrow(auth, target.selector, { offline });
  return await withWorkspaceManager(auth, workspace, 'workspace-export', async (manager) =>
    runWorkspaceExport({
      workspace: daemonBundleWorkspace(workspace.id, manager, { sync: !offline }),
      role: workspace.role,
      actor: { userId: auth.userId, machineId: auth.machineId, lodyVersion: version },
      out,
    })
  );
}

async function importBundle(target: Target, file: string, dryRun: boolean): Promise<ImportOutcome> {
  if (target.kind === 'local')
    return (await viaDaemon({
      operation: 'import',
      machineId: target.machineId,
      workspaceId: target.workspaceId,
      file,
      ...(dryRun ? { dryRun: true } : {}),
    })) as ImportOutcome;
  const auth = getAuthContextOrThrow('workspace-import');
  const workspace = await resolveWorkspaceOrThrow(auth, target.selector);
  return await withWorkspaceManager(auth, workspace, 'workspace-import', async (manager) =>
    runWorkspaceImport({
      workspace: daemonBundleWorkspace(workspace.id, manager, { sync: true }),
      role: workspace.role,
      actor: { userId: auth.userId, machineId: auth.machineId, lodyVersion: version },
      file,
      journalDir: path.join(getLodyDataDir(), 'workspace-imports'),
      dryRun,
    })
  );
}

type ExportOptions = {
  out: string;
  workspace?: string;
  offline?: boolean;
  json?: boolean;
  debug?: boolean;
};
type ImportOptions = {
  workspace?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  debug?: boolean;
};

export const workspaceExportCommand = new Command('export')
  .description('Export a complete workspace bundle that can be imported again (owners and admins)')
  .requiredOption('--out <file>', 'Bundle file to create (must not exist)')
  .option('--workspace <selector>', 'Workspace id, slug, or name')
  .option('--offline', 'Read the local cache without syncing first')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (options: ExportOptions) => {
    await runOneShotCommand('workspace-export', options, async () => {
      const out = path.resolve(options.out);
      if (!options.json) console.error(PLAINTEXT_WARNING);
      const summary = await exportBundle(
        await resolveTarget(options.workspace),
        out,
        options.offline === true
      );
      if (options.json) {
        printJson({ ok: true, ...summary });
        return;
      }
      console.log(`Exported ${summary.rooms} rooms and ${summary.blobs} files to ${summary.file}`);
      for (const gap of summary.gaps)
        console.log(`Not included: ${gap.id} (${gap.kind}): ${gap.reason}`);
    });
  });

function reportImport(outcome: ImportOutcome, json: boolean): void {
  if (json) {
    printJson({ ok: true, ...outcome });
    return;
  }
  console.log(
    `Imported ${outcome.result?.imported ?? 0} rooms; skipped ${outcome.result?.skipped ?? 0}.`
  );
  if (outcome.uploadPending.length > 0)
    console.log(
      `Saved locally but not yet uploaded: ${outcome.uploadPending.join(', ')}. Run \`lody sync\` to retry.`
    );
}

export const workspaceImportCommand = new Command('import')
  .description('Merge a workspace bundle into a workspace (owners and admins)')
  .argument('<file>', 'Bundle file')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--dry-run', 'Show what would change without writing')
  .option('--yes', 'Import without asking for confirmation')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (fileArg: string, options: ImportOptions) => {
    await runOneShotCommand('workspace-import', options, async () => {
      const file = path.resolve(fileArg);
      const target = await resolveTarget(options.workspace);
      if (options.yes && !options.dryRun) {
        await reportImport(await importBundle(target, file, false), options.json === true);
        return;
      }
      const preview = await importBundle(target, file, true);
      if (options.dryRun) {
        if (options.json) printJson({ ok: true, plan: preview.plan });
        else console.log(formatImportPlan(preview.plan));
        return;
      }
      if (!process.stdin.isTTY) throw new Error('Pass --yes to import without confirmation.');
      console.log(formatImportPlan(preview.plan));
      const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
        {
          type: 'confirm',
          name: 'confirmed',
          message: 'Merge this bundle into the workspace?',
          default: false,
        },
      ]);
      if (!confirmed) {
        console.log('Nothing was imported.');
        return;
      }
      await reportImport(await importBundle(target, file, false), options.json === true);
    });
  });

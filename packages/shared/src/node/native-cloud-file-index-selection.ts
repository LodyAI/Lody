import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\0'));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const authorityId = z.string().regex(/^[a-f0-9]{64}$/);
const selectionSchema = z.object({
  version: z.literal(1),
  account: identifier,
  workspace: identifier,
  authority: authorityId,
  machine: identifier,
  cohort: identifier,
  selected: z.string(),
});
const ownersSchema = z.array(z.object({ owner: identifier, stage: z.enum(['frozen', 'native']) }));
export function cloudFileIndexAuthorityId(deploymentUrl: string, authSiteUrl: string) {
  const normalize = (value: string) => {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Trusted Cloud FI authority URL required');
    return url.href.replace(/\/$/, '');
  };
  return digest(JSON.stringify([normalize(deploymentUrl), normalize(authSiteUrl)]));
}
function selectionRoot(dataRoot: string, accountId: string, workspaceId: string) {
  return join(
    dataRoot,
    'native-repo',
    'cloud-file-index',
    'v1',
    digest(JSON.stringify([identifier.parse(accountId), identifier.parse(workspaceId)]))
  );
}
/** Discoverable without Cloud clients. Deployment authority is independent of
 * account identity, and never inferred from a renderer/bootstrap identifier. */
export function cloudFileIndexSelectionPath(
  dataRoot: string,
  accountId: string,
  workspaceId: string,
  authority: string
) {
  return join(
    selectionRoot(dataRoot, accountId, workspaceId),
    authorityId.parse(authority),
    'owners.sqlite3'
  );
}
export function readCloudFileIndexSelection(
  dataRoot: string,
  accountId: string,
  workspaceId: string,
  authority: string
) {
  const filename = cloudFileIndexSelectionPath(dataRoot, accountId, workspaceId, authority);
  if (!existsSync(filename)) return null;
  const database = new DatabaseSync(filename, { readOnly: true, timeout: 0 });
  try {
    const rows = database
      .prepare(
        'SELECT version,account,workspace,authority,machine,cohort,selected FROM file_index_binding'
      )
      .all();
    if (rows.length !== 1) throw new Error('Native Cloud FI binding recovery required');
    const binding = selectionSchema.parse(rows[0]);
    if (
      binding.account !== accountId ||
      binding.workspace !== workspaceId ||
      binding.authority !== authority
    )
      throw new Error('Native Cloud FI binding changed');
    const selected = z.array(identifier).min(1).max(32).parse(JSON.parse(binding.selected));
    if (
      new Set(selected).size !== selected.length ||
      binding.cohort !== digest(JSON.stringify([...selected].sort()))
    )
      throw new Error('Native Cloud FI cohort corrupt');
    const owners = ownersSchema.parse(
      database.prepare('SELECT owner,stage FROM file_index_owners').all()
    );
    if (owners.some((owner) => !selected.includes(owner.owner)))
      throw new Error('Native Cloud FI room outside cohort');
    return { ...binding, selected, owners };
  } finally {
    database.close();
  }
}
export function listCloudFileIndexSelections(
  dataRoot: string,
  accountId: string,
  workspaceId: string,
  authority?: string
) {
  const root = selectionRoot(dataRoot, accountId, workspaceId);
  const authorities = authority ? [authority] : existsSync(root) ? readdirSync(root) : [];
  return authorities
    .map((authority) => readCloudFileIndexSelection(dataRoot, accountId, workspaceId, authority))
    .filter((value) => value !== null);
}

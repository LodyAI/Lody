import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { SqliteControlStore } from '../src/node-store';
import { invariant } from '../src/wire';

// Isolated synthetic fixture. Parent coordinates each boundary through IPC,
// then terminates only this child to exercise OS lock release and disk recovery.
const path = process.argv[2]!;
const input = once(process, 'message');
process.send!('ready');
const command: unknown = (await input)[0];
invariant(
  typeof command === 'object' &&
    command !== null &&
    'mode' in command &&
    (command.mode === 'save' || command.mode === 'hold' || command.mode === 'uncommitted') &&
    'genesis' in command &&
    typeof command.genesis === 'string' &&
    'pending' in command &&
    typeof command.pending === 'string',
  'invalid-fixture-command'
);
const { mode, genesis, pending } = command;
const release = once(process, 'message');
if (mode === 'uncommitted') {
  const db = new DatabaseSync(path);
  db.exec("BEGIN IMMEDIATE; UPDATE journal SET payload='incomplete-change' WHERE id=1;");
  process.send!('locked');
  await release;
  db.exec('ROLLBACK');
  db.close();
} else {
  await new SqliteControlStore(path).exclusive(async (tx) => {
    if (mode === 'save') await tx.save({ genesis, pages: [], pending });
    process.send!('locked');
    await release;
  });
}
process.send!('released');
process.disconnect();

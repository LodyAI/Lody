import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { decodeLedgerJournal, SqliteLedgerStore } from '../src/ledger/node-store';

const path = process.argv[2]!;
const input = once(process, 'message');
process.send!('ready');
const command: unknown = (await input)[0];
if (
  typeof command !== 'object' ||
  command === null ||
  !('mode' in command) ||
  (command.mode !== 'save' && command.mode !== 'hold' && command.mode !== 'uncommitted') ||
  !('journal' in command) ||
  typeof command.journal !== 'string'
) {
  throw new Error('invalid-fixture-command');
}
const { mode, journal } = command;
const parsed = decodeLedgerJournal(journal);
const release = once(process, 'message');
if (mode === 'uncommitted') {
  const db = new DatabaseSync(path);
  db.exec("BEGIN IMMEDIATE; UPDATE journal SET payload='incomplete-change' WHERE id=1;");
  process.send!('locked');
  await release;
  db.exec('ROLLBACK');
  db.close();
} else {
  await new SqliteLedgerStore(path).exclusive(async (tx) => {
    if (mode === 'save') await tx.save(parsed);
    process.send!('locked');
    await release;
  });
}
process.send!('released');
process.disconnect();

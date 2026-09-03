import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const argumentsList = process.argv.slice(2);
const requestedReport = argumentsList.find((argument) => !argument.startsWith('--'));
const statusArgument = argumentsList.find((argument) => argument.startsWith('--status='));
const ledgerArgument = argumentsList.find((argument) => argument.startsWith('--ledger='));
// New entries land on `debt`, never `wont-fix`. Telling "we will fix this" from
// "this is not a defect" IS the review; a tool that guessed would be recording
// a decision nobody made.
const status = statusArgument?.slice('--status='.length) ?? 'debt';
if (status !== 'new' && status !== 'debt') {
  throw new Error('--status must be new or debt');
}

const reportDirectory = path.resolve(packageRoot, requestedReport ?? 'geometry-report');
const findingsPath = path.join(reportDirectory, 'findings.json');
const ledgerPath = ledgerArgument
  ? path.resolve(packageRoot, ledgerArgument.slice('--ledger='.length))
  : path.join(packageRoot, 'geometry-ledger.json');
const [findingText, ledgerText] = await Promise.all([
  readFile(findingsPath, 'utf8'),
  readFile(ledgerPath, 'utf8'),
]);
const artifact = JSON.parse(findingText);
const ledger = JSON.parse(ledgerText);
if (artifact.version !== 1 || !Array.isArray(artifact.findings)) {
  throw new Error(`Unsupported geometry finding artifact: ${findingsPath}`);
}
if (ledger.version !== 1 || typeof ledger.findings !== 'object' || ledger.findings === null) {
  throw new Error(`Unsupported geometry ledger: ${ledgerPath}`);
}

// Re-key migration. The DECISION is made in TypeScript, beside the identity
// rules that caused the re-key (`diffGeometryFindings`), and the report writes
// it out; this script only applies the moves, so a status, a reason and a
// baseline a human recorded survive a structural identity change.
const diffPath = path.join(reportDirectory, 'finding-diff.json');
let diff = null;
try {
  diff = JSON.parse(await readFile(diffPath, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const reviewedIdentity = (finding) => ({
  label: finding.label,
  axis: finding.axis,
  anchor: finding.anchor,
  surfaceFamily: finding.surfaceFamily,
});
const findingByKey = new Map(artifact.findings.map((finding) => [finding.key, finding]));
const migrated = [];
for (const pair of diff?.rekeyed ?? []) {
  const entry = ledger.findings[pair.from];
  const finding = findingByKey.get(pair.to);
  if (!entry || !finding) continue;
  delete ledger.findings[pair.from];
  ledger.findings[pair.to] = { ...entry, identity: reviewedIdentity(finding) };
  migrated.push(`${pair.label} (${pair.reason})`);
}

let added = 0;
for (const finding of artifact.findings) {
  const existing = ledger.findings[finding.key];
  if (existing) {
    ledger.findings[finding.key] = {
      ...existing,
      identity: existing.identity ?? reviewedIdentity(finding),
    };
    continue;
  }
  ledger.findings[finding.key] = {
    status,
    baseline: { offset: finding.offset },
    identity: reviewedIdentity(finding),
  };
  added += 1;
}
ledger.findings = Object.fromEntries(
  Object.entries(ledger.findings).sort(([left], [right]) => left.localeCompare(right))
);
await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
console.log(
  `Geometry ledger: added ${added} ${status} finding${added === 1 ? '' : 's'} from ${findingsPath}`
);
if (migrated.length > 0) {
  console.log(
    `Geometry ledger: migrated ${migrated.length} re-keyed review${
      migrated.length === 1 ? '' : 's'
    }: ${migrated.join(', ')}`
  );
}

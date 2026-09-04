import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const featureDir = join(e2eRoot, 'src', 'features');
const stepDir = join(e2eRoot, 'src', 'steps');
const pageDir = join(e2eRoot, 'src', 'support', 'pages');
const featureReadmePath = join(featureDir, 'README.md');
const stepReadmePath = join(stepDir, 'README.md');
const supportReadmePath = join(e2eRoot, 'src', 'support', 'README.md');
const coveragePath = join(e2eRoot, 'COVERAGE.md');

const cucumberRequire = createRequire(import.meta.resolve('@cucumber/cucumber/package.json'));
const { generateMessages } = cucumberRequire('@cucumber/gherkin');
const { IdGenerator, SourceMediaType } = cucumberRequire('@cucumber/messages');
const failures = [];

function fail(message) {
  failures.push(message);
}

function filesIn(directory, suffix) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => entry.name)
    .sort();
}

function assertIndexed(readmePath, filenames, label) {
  const readme = readFileSync(readmePath, 'utf8');
  for (const filename of filenames) {
    if (!readme.includes(`\`${filename}\``)) {
      fail(`${relative(e2eRoot, readmePath)} does not index ${label} ${filename}`);
    }
  }
}

const featureFiles = filesIn(featureDir, '.feature');
const pickles = [];
for (const filename of featureFiles) {
  const uri = `src/features/${filename}`;
  const envelopes = generateMessages(
    readFileSync(join(featureDir, filename), 'utf8'),
    uri,
    SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN,
    {
      defaultDialect: 'zh-CN',
      includeSource: false,
      includeGherkinDocument: true,
      includePickles: true,
      newId: IdGenerator.incrementing(),
    }
  );
  for (const envelope of envelopes) {
    if (envelope.parseError) {
      fail(
        `${uri}:${envelope.parseError.source?.location?.line ?? '?'} ${envelope.parseError.message}`
      );
    }
    if (envelope.pickle) pickles.push(envelope.pickle);
  }
}

const stableIds = new Map();
const p0StableIds = new Set();
let p0Count = 0;
let p1Count = 0;
for (const pickle of pickles) {
  const tags = pickle.tags.map((tag) => tag.name);
  const location = `${pickle.uri}:${pickle.location?.line ?? '?'}`;
  if (!tags.includes('@lody')) fail(`${location} ${pickle.name} is missing @lody`);
  if (!tags.includes('@essence')) fail(`${location} ${pickle.name} is missing @essence`);
  if (tags.includes('@wip')) fail(`${location} ${pickle.name} must not use @wip`);

  const priorities = tags.filter((tag) => tag === '@P0' || tag === '@P1');
  if (priorities.length !== 1) {
    fail(`${location} ${pickle.name} must have exactly one of @P0 or @P1`);
  }
  if (priorities[0] === '@P0') p0Count += 1;
  if (priorities[0] === '@P1') p1Count += 1;

  const runtimes = tags.filter((tag) =>
    ['@runtime-none', '@runtime-simulator', '@runtime-codex'].includes(tag)
  );
  if (runtimes.length !== 1) {
    fail(`${location} ${pickle.name} must have exactly one supported @runtime-* owner`);
  }

  const ids = tags.filter((tag) => /^@LODY-[A-Z0-9-]+-\d{3}$/u.test(tag));
  if (ids.length !== 1) {
    fail(`${location} ${pickle.name} must have exactly one stable @LODY-AREA-NNN id`);
    continue;
  }
  const id = ids[0];
  const previous = stableIds.get(id);
  if (previous) fail(`${location} duplicates ${id} already used by ${previous}`);
  stableIds.set(id, `${location} ${pickle.name}`);
  if (priorities[0] === '@P0') p0StableIds.add(id.slice(1));
}

assertIndexed(featureReadmePath, featureFiles, 'feature');
assertIndexed(stepReadmePath, filesIn(stepDir, '.steps.ts'), 'step file');
assertIndexed(
  supportReadmePath,
  filesIn(pageDir, '.ts').map((name) => `pages/${name}`),
  'Page Object'
);

const expectedCount = `The active suite contains ${pickles.length} scenario${pickles.length === 1 ? '' : 's'}: ${p0Count} \`@P0\` smoke journey${p0Count === 1 ? '' : 's'} and ${p1Count} \`@P1\` deeper journey${p1Count === 1 ? '' : 's'}.`;
if (!readFileSync(featureReadmePath, 'utf8').includes(expectedCount)) {
  fail(`src/features/README.md must contain the current count sentence: ${expectedCount}`);
}

const coverage = readFileSync(coveragePath, 'utf8');
for (const stableId of p0StableIds) {
  if (!coverage.includes(`\`${stableId}\``)) {
    fail(`COVERAGE.md does not include P0 scenario ${stableId}`);
  }
}

for (const markdownPath of [coveragePath, featureReadmePath, stepReadmePath, supportReadmePath]) {
  const markdown = readFileSync(markdownPath, 'utf8');
  for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = match[1].split('#')[0];
    if (!target || /^https?:/u.test(target)) continue;
    if (!existsSync(resolve(dirname(markdownPath), target))) {
      fail(`${relative(e2eRoot, markdownPath)} links to missing path ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`E2E suite contract failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `E2E suite contract passed: ${pickles.length} scenarios (${p0Count} P0, ${p1Count} P1), ${stableIds.size} unique IDs.`
  );
}

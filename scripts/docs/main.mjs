#!/usr/bin/env node
/** Read-only document triage and scoped Git-content review; confirm is the only write command. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractAnchors, sourceRoots, sourceExtension } from './anchors.mjs';
import { git } from './git.mjs';

const documentRoots = ['specs', '.agents/docs', '.agents/notes'];
/** Word ceilings for AGENTS.md files; unlisted files use `default`, and raising one is a reviewed PR change. */
const agentsBudgetFile = 'scripts/docs/agents-budgets.json';
const agentsBudgetFallback = { default: 1200, files: {} };
/** Warn once a file consumes this share of its ceiling, so relocation happens before the gate. */
const agentsBudgetWarningShare = 0.9;
const recordSuffix = '.anchors.json';
/** Proposal-era headings that an implemented note may not carry; it describes shipped reality. */
const proposalHeadings =
  /^## (?:Proposal|Plan|Migration plan|Rollout plan|Acceptance criteria|提案|方案|计划|迁移计划|验收标准)\s*$/m;
/** Run-log phrases: a note links what pins the behavior and names what is unverified, not what passed. */
const runLogPhrases = [
  /\b(?:all|every|\d+)\s+(?:\w+[- ])*(?:tests?|cases?|suites?|specs?)\s+(?:now\s+)?pass(?:es|ed)?\b/i,
  /\btests?\s+(?:now\s+)?pass(?:es|ed)?\b/i,
  /\bthis checkout\b/i,
  /\bno installed dependencies\b/i,
  /\btype-?check(?:ing|s)?\s+(?:passes|passed|succeeds|succeeded|is clean)\b/i,
  /\b(?:lint|linting|formatting|format check|docs? check)\s+(?:passes|passed|succeeds|succeeded|reports?|is clean)\b/i,
  /\bexisting (?:lint |declaration-order )?warnings?\b/i,
  /(?:全部|所有|\d+ ?个)?(?:测试|用例|套件)(?:均|全部|都|现已|现在)?通过/,
  /本机|此检出|当前检出|本检出/,
  /未安装依赖|没有安装依赖/,
  /类型检查(?:均|都)?通过|lint (?:均|都)?通过|文档检查(?:均|都)?通过/,
];
/** Backticked repository paths whose disappearance means an active note describes code that moved. */
const repositoryPath =
  /`((?:apps|packages|scripts|specs|e2e|site-docs|\.agents|\.github)\/[\w@./-]*[\w-])`/g;
const classes = new Set([
  'architecture',
  'feature',
  'bug-fix',
  'simplification',
  'process',
  'testing',
]);
const lifecycles = new Set(['proposed', 'implemented', 'rejected', 'archived']);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Reject path escapes and symlinks so a review cannot silently hash another checkout. */
function localPath(root, relative) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    path.posix.isAbsolute(relative) ||
    relative.split('/').some((p) => !p || p === '.' || p === '..' || p === '.git')
  ) {
    throw new Error(`Invalid repository path: ${relative}`);
  }
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error(`Symlink is not a review source: ${relative}`);
  }
  return current;
}

function walk(root, relative) {
  const absolute = localPath(root, relative);
  if (!existsSync(absolute)) return [];
  if (lstatSync(absolute).isFile()) return [relative];
  if (existsSync(path.join(absolute, '.git'))) return []; // Separate submodule workspaces.
  return readdirSync(absolute)
    .sort()
    .filter((name) => !['node_modules', '.git', 'dist', 'build'].includes(name))
    .flatMap((name) => {
      const child = `${relative}/${name}`;
      return lstatSync(path.join(root, child)).isSymbolicLink() ? [] : walk(root, child);
    });
}

const gitHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const reviewReference = (value) =>
  typeof value === 'string' &&
  (/^PR #[1-9][0-9]*$/.test(value) ||
    gitHash.test(value) ||
    (() => {
      try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) && !!url.hostname;
      } catch {
        return false;
      }
    })());
function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label}: expected an object`);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`);
}
function validateBaseline(baseline, label) {
  if (baseline === undefined) return;
  exactKeys(
    baseline,
    ['scopeHash', 'revision', 'files', 'inventory', 'sourceBlobs', 'reason', 'evidence'],
    label
  );
  if (
    !gitHash.test(baseline.revision ?? '') ||
    !/^[a-f0-9]{64}$/.test(baseline.scopeHash ?? '') ||
    !Array.isArray(baseline.inventory) ||
    baseline.inventory.some((p) => typeof p !== 'string') ||
    typeof baseline.reason !== 'string' ||
    !baseline.reason.trim() ||
    typeof baseline.evidence !== 'string' ||
    !baseline.evidence.trim()
  )
    throw new Error(`${label}: malformed baseline`);
  for (const key of ['files', 'sourceBlobs']) {
    if (!baseline[key] || typeof baseline[key] !== 'object' || Array.isArray(baseline[key]))
      throw new Error(`${label}: invalid ${key}`);
    for (const hash of Object.values(baseline[key])) {
      if (
        typeof hash !== 'string' ||
        !(gitHash.test(hash) || (key === 'files' && /^sha256:[a-f0-9]{64}$/.test(hash)))
      )
        throw new Error(`${label}: invalid ${key} hash`);
    }
  }
}

function readScope(root, topic) {
  localPath(root, topic);
  if (!documentRoots.some((directory) => topic.startsWith(`${directory}/`)))
    throw new Error('Topic must name a document under specs or .agents/notes.');
  const file = `${topic}${recordSuffix}`;
  const scope = JSON.parse(readFileSync(localPath(root, file), 'utf8'));
  exactKeys(
    scope,
    ['version', 'rationale', 'scopeReview', 'documents', 'sources', 'watch', 'baseline', 'retired'],
    file
  );
  validateBaseline(scope.baseline, file);
  if (scope.retired !== undefined) {
    exactKeys(scope.retired, ['date', 'reason', 'scopeReview'], `${file}: retired`);
    const { date, reason, scopeReview } = scope.retired;
    if (
      typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      typeof reason !== 'string' ||
      !reason.trim() ||
      !reviewReference(scopeReview)
    )
      throw new Error(`${file}: invalid retirement record`);
  }
  if (scope.version !== 1 || typeof scope.rationale !== 'string' || !scope.rationale.trim())
    throw new Error(`${file}: missing version/rationale`);
  for (const key of ['documents', 'sources', 'watch']) {
    if (!Array.isArray(scope[key]) || scope[key].some((value) => typeof value !== 'string'))
      throw new Error(`${file}: invalid ${key}`);
    for (const value of scope[key]) {
      localPath(root, value);
      if (value.endsWith(recordSuffix)) throw new Error('Review metadata cannot protect itself.');
    }
  }
  if (
    !scope.documents.some((document) => document === `${topic}.md` || document === `${topic}.zh.md`)
  )
    throw new Error(`${file}: record must protect its adjacent owning document`);
  if (scope.documents.some((p) => !p.endsWith('.md')))
    throw new Error(`${file}: documents must be Markdown`);
  if (scope.scopeReview !== null && !reviewReference(scope.scopeReview))
    throw new Error(`${file}: invalid scopeReview`);
  const files = [...scope.documents, ...scope.sources];
  if (new Set(files).size !== files.length) throw new Error(`${file}: duplicate protected file`);
  const fingerprint = sha(
    JSON.stringify({
      documents: scope.documents,
      sources: scope.sources,
      watch: scope.watch,
      rationale: scope.rationale,
      scopeReview: scope.scopeReview,
    })
  );
  return { file, scope, fingerprint };
}

const countWords = (text) => text.split(/\s+/).filter(Boolean).length;

function agentsBudgets(root) {
  const file = path.join(root, agentsBudgetFile);
  if (!existsSync(file)) return agentsBudgetFallback;
  const budgets = JSON.parse(readFileSync(file, 'utf8'));
  exactKeys(budgets, ['default', 'files'], agentsBudgetFile);
  const ceiling = (value, label) => {
    if (!Number.isInteger(value) || value <= 0)
      throw new Error(`${agentsBudgetFile}: ${label} must be a positive integer`);
  };
  ceiling(budgets.default, 'default');
  exactKeys(budgets.files, Object.keys(budgets.files), agentsBudgetFile);
  for (const [relative, value] of Object.entries(budgets.files)) {
    localPath(root, relative);
    if (path.basename(relative) !== 'AGENTS.md')
      throw new Error(`${agentsBudgetFile}: ${relative} is not an AGENTS.md file`);
    ceiling(value, relative);
  }
  return budgets;
}

/**
 * Files this task changed or added: the working tree against `base` (default HEAD) plus
 * untracked files. A rename counts as changed, not added, so a lifecycle move is not a new note.
 */
async function changedFiles(root, base) {
  const changed = new Set();
  const added = new Set();
  const list = (bytes) => bytes.toString().split('\0').filter(Boolean);
  const diff = ['diff', '--name-only', '-z', '--find-renames'];
  for (const file of list(await git(root, [...diff, base ?? 'HEAD', '--']))) changed.add(file);
  for (const file of list(await git(root, [...diff, '--diff-filter=A', base ?? 'HEAD', '--'])))
    added.add(file);
  for (const file of list(await git(root, ['ls-files', '--others', '--exclude-standard', '-z']))) {
    changed.add(file);
    added.add(file);
  }
  return { changed, added };
}

/** Dated note records; rule files such as `.agents/notes/AGENTS.md` are owners, not notes. */
const noteRecord = /^\.agents\/notes\/(?:proposed|implemented|rejected|archived)\//;
/** One key per note pair, so a link to either language counts for both. */
const noteKey = (file) => file.replace(/\.zh\.md$/, '.md');

function noteLinkTargets(value) {
  const links = [...value.matchAll(/\]\(<?([^\s)>]+)>?\)/g)].map((match) => match[1]);
  return links.length
    ? links
    : value
        .split(/[,\s]+/)
        .map((token) => token.trim())
        .filter(Boolean);
}

function scopeNames(root) {
  return documentRoots
    .flatMap((directory) => walk(root, directory))
    .filter((file) => file.endsWith(recordSuffix))
    .map((file) => file.slice(0, -recordSuffix.length));
}

async function snapshot(root, scope, topic) {
  const objectFormat = (await git(root, ['rev-parse', '--show-object-format'])).toString().trim();
  const files = Object.fromEntries(
    [...scope.documents, ...scope.sources].map((relative) => {
      const file = localPath(root, relative);
      const bytes = existsSync(file) && lstatSync(file).isFile() ? readFileSync(file) : null;
      const blob =
        bytes === null
          ? null
          : createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      return [relative, blob];
    })
  );
  const sourceBlobs = {};
  for (const source of scope.sources) {
    if (
      !sourceRoots.some((directory) => source.startsWith(`${directory}/`)) ||
      !sourceExtension.test(source)
    )
      throw new Error(`${source}: code anchors support JS/TS sources under apps/ or packages/`);
    sourceBlobs[source] = files[source];
    if (!files[source]) continue;
    delete files[source];
    const anchors = extractAnchors(source, readFileSync(localPath(root, source), 'utf8')).filter(
      (anchor) => anchor.topic === topic
    );
    if (!anchors.length) throw new Error(`${source}: missing @dec:${topic}`);
    for (const anchor of anchors) {
      const key = `${source}::${anchor.signature}`;
      if (key in files)
        throw new Error(`${source}: ambiguous anchor signature ${anchor.signature}`);
      files[key] = anchor.hash;
    }
  }
  const inventory = [...new Set(scope.watch.flatMap((p) => walk(root, p)))].sort();
  return { files, inventory, sourceBlobs };
}

function checkAnchorLinks(root, topic) {
  const errors = [];
  for (const file of sourceRoots
    .flatMap((directory) => walk(root, directory))
    .filter((file) => sourceExtension.test(file))) {
    let anchors;
    try {
      anchors = extractAnchors(file, readFileSync(localPath(root, file), 'utf8'));
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
      continue;
    }
    for (const anchor of anchors) {
      if (topic && anchor.topic !== topic) continue;
      try {
        const { scope } = readScope(root, anchor.topic);
        if (scope.retired)
          errors.push(`${file}: marker points to retired topic ${anchor.topic}; remove the marker`);
        else if (!scope.sources.includes(file))
          errors.push(`${file}: @dec:${anchor.topic} is absent from its document's sources`);
      } catch (error) {
        errors.push(`${file}: invalid @dec:${anchor.topic}: ${error.message}`);
      }
    }
  }
  return errors;
}

/** Compare bytes and watched membership, not timestamps or HEAD identity. */
export async function inspectTopic(root, topic) {
  const { scope, fingerprint } = readScope(root, topic);
  if (scope.retired) return { topic, status: 'retired', retired: scope.retired, changes: [] };
  const current = await snapshot(root, scope, topic);
  const baseline = scope.baseline;
  const changes = [];
  for (const [file, hash] of Object.entries(current.files)) {
    if (!hash) changes.push({ file, kind: 'missing' });
    else if (baseline?.files?.[file] !== hash)
      changes.push({ file, kind: 'changed', before: baseline?.files?.[file] ?? null, after: hash });
  }
  if (baseline) {
    if (baseline.scopeHash !== fingerprint) changes.push({ kind: 'scope-changed' });
    for (const file of Object.keys(baseline.files ?? {}))
      if (!(file in current.files)) changes.push({ file, kind: 'protection-removed' });
    for (const file of current.inventory)
      if (!baseline.inventory?.includes(file)) changes.push({ file, kind: 'added-to-watch' });
    for (const file of baseline.inventory ?? [])
      if (!current.inventory.includes(file)) changes.push({ file, kind: 'removed-from-watch' });
  }
  const status = !scope.scopeReview
    ? 'scope-pending'
    : !baseline
      ? 'unreviewed'
      : changes.length
        ? 'stale'
        : 'current';
  return { topic, status, changes };
}

/**
 * Produce queues directly from document metadata; pending translation is not a check failure.
 * Note hygiene gates apply only to notes this task changed (against `base`, default HEAD):
 * earlier records are not cleaned up retroactively.
 */
export async function documentStatus(root, { base } = {}) {
  const documents = [];
  const errors = [];
  const warnings = [];
  const staleReferences = [];
  const unlinkedNotes = new Set();
  const markdown = await checkRepositoryMarkdown(root);
  const { changed, added } = await changedFiles(root, base);
  for (const file of ['specs', '.agents/notes'].flatMap((p) => walk(root, p))) {
    if (
      !file.endsWith('.md') ||
      ['AGENTS.md', 'README.md', 'README.zh.md'].includes(path.basename(file))
    )
      continue;
    const text = readFileSync(path.join(root, file), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
    const status = /^Status:\s*(\S+)/m.exec(text)?.[1] ?? null;
    const translation = /^Translation:\s*(\S+)/m.exec(text)?.[1] ?? null;
    const archived = file.startsWith('.agents/notes/archived/');
    if (archived) continue;
    if (file.startsWith('specs/') && !['draft', 'approved', 'outdated'].includes(status))
      errors.push(`${file}: invalid/missing Spec status`);
    if (file.startsWith('.agents/notes/')) {
      const opening = /^## ([^\n]+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(text);
      const expected = file.endsWith('.zh.md') ? '摘要' : 'Abstract';
      if (!opening || opening[1].trim() !== expected || !opening[2].trim())
        errors.push(`${file}: start with a nonempty ${expected} section`);
      const [, , lifecycle, type, name, ...rest] = file.split('/');
      if (
        rest.length ||
        !lifecycles.has(lifecycle) ||
        !classes.has(type) ||
        !/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(name ?? '') ||
        status !== lifecycle
      )
        errors.push(`${file}: invalid note lifecycle/type/name/status`);
      const supersedes = /^Supersedes:[ \t]*(.+)$/m.exec(text)?.[1];
      for (const target of supersedes ? noteLinkTargets(supersedes) : []) {
        const resolved = path.relative(
          root,
          path.resolve(root, path.dirname(file), target.split(/[?#]/)[0])
        );
        if (
          !resolved.startsWith('.agents/notes/archived/') ||
          !existsSync(path.join(root, resolved))
        )
          errors.push(
            `${file}: Supersedes target ${target} must be an archived note; archive a fully ` +
              'superseded note in the same change (.agents/notes/AGENTS.md#supersession)'
          );
      }
      if (!file.endsWith('.zh.md')) {
        const missing = [...new Set([...text.matchAll(repositoryPath)].map((m) => m[1]))].filter(
          (reference) => !existsSync(path.join(root, reference))
        );
        if (missing.length) staleReferences.push({ file, missing });
      }
      if (
        ['proposed', 'implemented'].includes(lifecycle) &&
        !markdown.ownerLinkedNotes.has(noteKey(file))
      ) {
        const key = noteKey(file);
        const counterpartAdded = added.has(key) || added.has(key.replace(/\.md$/, '.zh.md'));
        if (counterpartAdded && !unlinkedNotes.has(key))
          errors.push(
            `${key}: a new note needs an inbound link from its current-state owner (a README, ` +
              '.agents/docs page, AGENTS.md or Spec) so readers of that code find it ' +
              '(.agents/notes/AGENTS.md#linking)'
          );
        unlinkedNotes.add(key);
      }
      if (changed.has(file)) {
        const heading = proposalHeadings.exec(text)?.[0];
        if (lifecycle === 'implemented' && heading)
          errors.push(
            `${file}: implemented notes describe shipped reality; replace "${heading.trim()}" ` +
              'with Decision/Consequences (.agents/notes/AGENTS.md#lifecycle-and-type)'
          );
        const phrase = runLogPhrases.map((pattern) => pattern.exec(text)?.[0]).find(Boolean);
        if (phrase)
          warnings.push(
            `${file}: run-log phrase "${phrase}". Verification links what pins the behavior and ` +
              'names what remains unverified; omit pass counts and environment logs ' +
              '(.agents/notes/AGENTS.md#verification)'
          );
      }
    }
    if (
      (file.startsWith('specs/') || file.startsWith('.agents/notes/')) &&
      !['pending', 'current', 'stale'].includes(translation)
    )
      errors.push(`${file}: invalid/missing translation status`);
    const counterpart = file.endsWith('.zh.md')
      ? file.replace(/\.zh\.md$/, '.md')
      : file.replace(/\.md$/, '.zh.md');
    const missingTranslation = !existsSync(path.join(root, counterpart));
    if (translation === 'current' && missingTranslation)
      errors.push(`${file}: translation marked current but counterpart missing`);
    else if (missingTranslation && file.startsWith('.agents/notes/'))
      warnings.push(
        `${file}: ${counterpart} is missing. Agent-authored notes ship both languages ` +
          'in the same change; see .agents/notes/AGENTS.md#history-and-language'
      );
    if (!missingTranslation) {
      const other = readFileSync(localPath(root, counterpart), 'utf8');
      const otherStatus = /^Status:[ \t]*(\S+)/m.exec(other)?.[1];
      if (status !== otherStatus) errors.push(`${file}: Status differs from ${counterpart}`);
    }
    documents.push({ file, status, translation, missingTranslation });
  }
  errors.push(...markdown.errors);
  warnings.push(...markdown.warnings);
  return { documents, staleReferences, unlinkedNotes: [...unlinkedNotes], errors, warnings };
}

/**
 * Check tracked and untracked non-ignored Markdown, including hubs and archives, and collect
 * the notes that a non-note document links to.
 */
async function checkRepositoryMarkdown(root) {
  const errors = [];
  const warnings = [];
  const ownerLinkedNotes = new Set();
  const files = [
    ...new Set(
      (await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
        .toString()
        .split('\0')
    ),
  ];
  let budgets;
  try {
    budgets = agentsBudgets(root);
  } catch (error) {
    errors.push(error.message);
    budgets = agentsBudgetFallback;
  }
  for (const relative of Object.keys(budgets.files))
    if (!files.includes(relative))
      errors.push(
        `${agentsBudgetFile}: ${relative} is budgeted but does not exist; update the manifest in the same change`
      );
  for (const file of files.filter((file) => /\.md$/i.test(file))) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink()) continue;
    const bytes = readFileSync(localPath(root, file));
    if (path.basename(file) === 'AGENTS.md') {
      const ceiling = budgets.files[file] ?? budgets.default;
      const words = countWords(bytes.toString());
      if (words > ceiling)
        errors.push(
          `${file}: ${words} words exceeds its ${ceiling}-word ceiling. Relocate a topic per ` +
            '.agents/README.md#where-content-goes, condense without losing a rule, or raise the ' +
            `ceiling in ${agentsBudgetFile} with the justification in the PR`
        );
      else if (words > ceiling * agentsBudgetWarningShare)
        warnings.push(
          `${file}: ${words} of ${ceiling} words; ${ceiling - words} left. Route a topic to a ` +
            'child scope or owning doc before the ceiling binds, rather than compressing sentences'
        );
    }
    const text = bytes
      .toString()
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm, '')
      .replace(/`[^`\n]*`/g, '');
    const targets = [...text.matchAll(/\]\(<?([^\s)>]+)>?(?:[ \t]+["'][^\n]*?["'])?\)/g)].map(
      (match) => match[1]
    );
    targets.push(
      ...[...text.matchAll(/^ {0,3}\[[^\]]+\]:[ \t]*<?([^\s>]+)>?/gm)].map((match) => match[1])
    );
    for (const target of targets) {
      if (/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(target)) continue;
      let relative;
      try {
        relative = decodeURIComponent(target.split(/[?#]/)[0]);
      } catch {
        errors.push(`${file}: invalid link encoding ${target}`);
        continue;
      }
      if (!relative) continue;
      const destination = relative.startsWith('/')
        ? path.resolve(root, `.${relative}`)
        : path.resolve(root, path.dirname(file), relative);
      if (
        !(destination === root || destination.startsWith(root + path.sep)) ||
        !existsSync(destination)
      )
        errors.push(`${file}: broken local link ${target}`);
      else if (!noteRecord.test(file)) {
        const linked = path.relative(root, destination).split(path.sep).join('/');
        if (linked.startsWith('.agents/notes/')) ownerLinkedNotes.add(noteKey(linked));
      }
    }
  }
  return { errors, warnings, ownerLinkedNotes };
}

/** Explicit confirmation requires committed, recoverable content and never edits a Spec. */
export async function confirmTopic(root, topic, reason, evidence) {
  if (!reason?.trim() || !evidence?.trim())
    throw new Error('confirm requires --reason and --evidence.');
  const { scope, file, fingerprint } = readScope(root, topic);
  if (scope.retired) throw new Error('Retired topics cannot be confirmed.');
  if (!scope.scopeReview) throw new Error('Human scope confirmation is pending.');
  const linkErrors = checkAnchorLinks(root, topic);
  if (linkErrors.length) throw new Error(linkErrors.join('\n'));
  const current = await snapshot(root, scope, topic);
  if (Object.values(current.files).some((hash) => !hash))
    throw new Error('Cannot confirm missing protected files.');
  const revision = (await git(root, ['rev-parse', 'HEAD'])).toString().trim();
  for (const [relative, hash] of Object.entries({
    ...Object.fromEntries(Object.entries(current.files).filter(([key]) => !key.includes('::'))),
    ...current.sourceBlobs,
  })) {
    const committed = (await git(root, ['rev-parse', `${revision}:${relative}`])).toString().trim();
    if (committed !== hash) throw new Error(`Commit reviewed content first: ${relative}`);
  }
  if (scope.watch.length) {
    const committedInventory = (
      await git(root, ['ls-tree', '-r', '-z', revision, '--', ...scope.watch])
    )
      .toString()
      .split('\0')
      .filter(Boolean)
      .filter((entry) => entry.startsWith('100644 blob ') || entry.startsWith('100755 blob '))
      .map((entry) => entry.slice(entry.indexOf('\t') + 1))
      .filter((p) => !p.split('/').some((part) => ['node_modules', 'dist', 'build'].includes(part)))
      .sort();
    if (JSON.stringify(committedInventory) !== JSON.stringify(current.inventory))
      throw new Error('Commit watched file additions/deletions first.');
  }
  scope.baseline = { scopeHash: fingerprint, revision, ...current, reason, evidence };
  writeFileSync(localPath(root, file), JSON.stringify(scope, null, 2) + '\n');
  return inspectTopic(root, topic);
}

/** Display recorded bytes against current files without changing Git or the record. */
export async function topicDiff(root, topic) {
  const { scope } = readScope(root, topic);
  const report = await inspectTopic(root, topic);
  const output = [JSON.stringify(report, null, 2)];
  if (!scope.baseline) return output.join('\n');
  const displayed = new Set();
  for (const change of report.changes) {
    if (!['changed', 'missing', 'protection-removed'].includes(change.kind)) continue;
    const source = change.file.split('::')[0];
    if (displayed.has(source)) continue;
    displayed.add(source);
    const hash = change.file.includes('::')
      ? scope.baseline.sourceBlobs?.[source]
      : scope.baseline.files?.[source];
    if (!hash) continue;
    if (!gitHash.test(hash)) throw new Error(`Invalid baseline blob: ${source}`);
    let before;
    try {
      before = await git(root, ['cat-file', 'blob', hash]);
    } catch (error) {
      throw new Error(
        `Missing baseline blob ${hash} for ${source}; obtain history containing this content before reviewing. No baseline was changed. ${error.message}`,
        { cause: error }
      );
    }
    const currentPath = localPath(root, source);
    const after = existsSync(currentPath) ? readFileSync(currentPath) : Buffer.alloc(0);
    const temporary = mkdtempSync(path.join(tmpdir(), 'lody-doc-diff-'));
    try {
      writeFileSync(path.join(temporary, 'before'), before);
      writeFileSync(path.join(temporary, 'after'), after);
      const result = await git(
        temporary,
        ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', 'before', 'after'],
        { diff: true }
      );
      output.push(
        result.toString().replaceAll('a/before', `a/${source}`).replaceAll('b/after', `b/${source}`)
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  return output.join('\n');
}

export async function main(root, args) {
  const [command, ...rest] = args;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (
      !['--topic', '--reason', '--evidence', '--base'].includes(rest[i]) ||
      !rest[i + 1] ||
      options[rest[i]]
    )
      throw new Error('Invalid or repeated option');
    options[rest[i]] = rest[i + 1];
  }
  if (!['status', 'check', 'diff', 'confirm'].includes(command))
    throw new Error(
      'Usage: pnpm run docs status | check [--base COMMIT] | diff --topic NAME | confirm --topic NAME --reason TEXT --evidence TEXT'
    );
  const allowed =
    command === 'confirm'
      ? ['--topic', '--reason', '--evidence']
      : command === 'diff'
        ? ['--topic']
        : command === 'check'
          ? ['--base']
          : [];
  if (Object.keys(options).some((key) => !allowed.includes(key)))
    throw new Error(`Unexpected option for ${command}`);
  if (command === 'confirm' || command === 'diff') {
    if (!options['--topic']) throw new Error('--topic is required');
    console.log(
      command === 'diff'
        ? await topicDiff(root, options['--topic'])
        : JSON.stringify(
            await confirmTopic(
              root,
              options['--topic'],
              options['--reason'],
              options['--evidence']
            ),
            null,
            2
          )
    );
    return 0;
  }
  const base = options['--base']
    ? (
        await git(root, [
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${options['--base']}^{commit}`,
        ])
      )
        .toString()
        .trim()
    : undefined;
  const report = await documentStatus(root, { base });
  report.errors.push(...checkAnchorLinks(root));
  report.topics = [];
  for (const topic of scopeNames(root)) {
    try {
      report.topics.push(await inspectTopic(root, topic));
    } catch (error) {
      report.topics.push({ topic, status: 'error', message: error.message });
    }
  }
  if (base) {
    const previous = (
      await git(root, ['ls-tree', '-r', '--name-only', base, '--', ...documentRoots])
    )
      .toString()
      .split('\n')
      .filter((p) => p.endsWith(recordSuffix));
    for (const file of previous)
      if (!existsSync(localPath(root, file)))
        report.errors.push(
          `Protected topic removed: ${file}; restore the record and review scope retirement explicitly.`
        );
  }
  console.log(JSON.stringify(report, null, 2));
  return command === 'check' &&
    (report.errors.length || report.topics.some((t) => !['current', 'retired'].includes(t.status)))
    ? 1
    : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(
      path.resolve(import.meta.dirname, '../..'),
      process.argv.slice(2)
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

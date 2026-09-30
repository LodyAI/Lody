import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { rankSlashMatch, sortRankedSlashItems } from '../../src/lib/command-slash-search.ts';

// Synthetic judgments describe the command the user is most likely typing.
// Each case has at most one Agent Command, so the baseline's command-internal
// scorer cannot affect its comparison with the new cross-source ranking.
const cases = [
  {
    name: 'reported /video prefix',
    query: 'video',
    top: 'videoer',
    rows: [
      { id: 'create-intro-video', kind: 'shortcut', token: 'create-intro-video', grade: 1 },
      { id: 'videoer', kind: 'shortcut', token: 'videoer', grade: 3 },
    ],
  },
  {
    name: 'exact Agent Command across sources',
    query: 'video',
    top: 'agent-video',
    rows: [
      { id: 'create-intro-video', kind: 'shortcut', token: 'create-intro-video', grade: 1 },
      { id: 'videoer', kind: 'shortcut', token: 'videoer', grade: 2 },
      { id: 'agent-video', kind: 'command', token: 'video', grade: 3 },
    ],
  },
  {
    name: 'word start over embedded substring',
    query: 'video',
    top: 'create-intro-video',
    rows: [
      { id: 'myvideotool', kind: 'shortcut', token: 'myvideotool', grade: 1 },
      { id: 'create-intro-video', kind: 'shortcut', token: 'create-intro-video', grade: 3 },
    ],
  },
  {
    name: 'exact review command beats shortcut group',
    query: 'review',
    top: 'agent-review',
    rows: [
      { id: 'create-review', kind: 'shortcut', token: 'create-review', grade: 1 },
      { id: 'review-pr', kind: 'shortcut', token: 'review-pr', grade: 2 },
      { id: 'agent-review', kind: 'command', token: 'review', grade: 3 },
    ],
  },
  {
    name: 'description match follows token prefix',
    query: 'video',
    top: 'videoer',
    rows: [
      { id: 'clip', kind: 'shortcut', token: 'clip', description: 'Video summary', grade: 1 },
      { id: 'videoer', kind: 'shortcut', token: 'videoer', grade: 3 },
    ],
  },
  {
    name: 'display name exact match',
    query: 'video',
    top: 'create-clip',
    rows: [
      { id: 'create-clip', kind: 'shortcut', token: 'create-clip', name: 'Video', grade: 3 },
      { id: 'videoer', kind: 'shortcut', token: 'videoer', grade: 2 },
    ],
  },
  {
    name: 'unavailable exact stays behind usable prefix',
    query: 'video',
    top: 'videoer',
    rows: [
      { id: 'video', kind: 'shortcut', token: 'video', disabled: true, grade: 0 },
      { id: 'videoer', kind: 'shortcut', token: 'videoer', grade: 3 },
    ],
  },
  {
    name: 'subsequence recall',
    query: 'vdo',
    top: 'videoer',
    rows: [{ id: 'videoer', kind: 'shortcut', token: 'videoer', grade: 3 }],
  },
  {
    name: 'Agent Command prefix beats shortcut word match',
    query: 'video',
    top: 'agent-videoer',
    rows: [
      { id: 'create-intro-video', kind: 'shortcut', token: 'create-intro-video', grade: 1 },
      { id: 'agent-videoer', kind: 'command', token: 'videoer', grade: 3 },
    ],
  },
  {
    name: 'case-insensitive query',
    query: 'VIDEO',
    top: 'videoer',
    rows: [
      { id: 'create-intro-video', kind: 'shortcut', token: 'create-intro-video', grade: 1 },
      { id: 'videoer', kind: 'shortcut', token: 'videoer', grade: 3 },
    ],
  },
];

function visible(row, query) {
  if (!row.disabled) return true;
  const term = query.toLowerCase();
  return row.token === term || row.name?.toLowerCase() === term;
}

function legacyOrder(rows, query) {
  const term = query.toLowerCase();
  const shortcuts = rows
    .filter((row) => row.kind === 'shortcut' && visible(row, query))
    .filter((row) =>
      [row.token, row.name ?? '', row.description ?? ''].some((field) =>
        field.toLowerCase().includes(term)
      )
    )
    .sort(
      (a, b) =>
        Number(b.token === term) - Number(a.token === term) || a.token.localeCompare(b.token)
    );
  const commands = rows.filter(
    (row) => row.kind === 'command' && rankSlashMatch(row, query) !== null
  );
  return [...shortcuts, ...commands];
}

function pocOrder(rows, query) {
  return sortRankedSlashItems(
    rows.flatMap((row) => {
      if (!visible(row, query)) return [];
      const rank = rankSlashMatch(row, query);
      return rank ? [{ ...row, rank }] : [];
    })
  );
}

function dcg(rows) {
  return rows.slice(0, 5).reduce((sum, row, index) => {
    return sum + (2 ** row.grade - 1) / Math.log2(index + 2);
  }, 0);
}

const results = cases.map((entry) => {
  const old = legacyOrder(entry.rows, entry.query);
  const next = pocOrder(entry.rows, entry.query);
  assert.equal(next[0]?.id, entry.top, entry.name);
  const ideal = [...entry.rows].sort((a, b) => b.grade - a.grade);
  return {
    name: entry.name,
    oldTop: old[0]?.id ?? 'none',
    newTop: next[0]?.id ?? 'none',
    oldNdcg: dcg(old) / dcg(ideal),
    newNdcg: dcg(next) / dcg(ideal),
  };
});

const average = (key) => results.reduce((sum, row) => sum + row[key], 0) / results.length;
console.table(results.map(({ name, oldTop, newTop }) => ({ name, oldTop, newTop })));
console.log(
  JSON.stringify({
    cases: results.length,
    oldTop1: results.filter((row, index) => row.oldTop === cases[index].top).length,
    newTop1: results.filter((row, index) => row.newTop === cases[index].top).length,
    oldNdcgAt5: Number(average('oldNdcg').toFixed(3)),
    newNdcgAt5: Number(average('newNdcg').toFixed(3)),
  })
);

const corpus = Array.from({ length: 1000 }, (_, index) => ({
  id: String(index),
  token: `task-${String(index).padStart(4, '0')}-video-${index % 17}`,
  name: `Task ${index}`,
  description: 'Generate a summary for the current conversation',
}));
const samples = [];
for (let iteration = 0; iteration < 100; iteration += 1) {
  const start = performance.now();
  pocOrder(corpus, 'video');
  samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    corpus: corpus.length,
    runs: samples.length,
    medianMs: Number(samples[49].toFixed(2)),
    p95Ms: Number(samples[94].toFixed(2)),
    scope: 'filter and rank only; no React rendering or network',
  })
);

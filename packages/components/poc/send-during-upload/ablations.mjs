import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const composer = 'packages/components/src/components/sessions/session-chat-input-area.tsx';
const submission = 'packages/components/src/components/chat/submission/use-composer-submission.ts';

const variants = [
  {
    name: 'stale-send-callback',
    witness: 'waits once and uses the latest routing callback',
    edits: [[composer, 'await sendStateRef.current.onSendMessage(', 'await onSendMessage(']],
  },
  {
    name: 'no-submission-lock',
    witness: 'boundary: same-batch Enter sends one accepted message',
    edits: [
      [
        submission,
        'if (scope.submission) return null;',
        '// Ablation: permit concurrent submissions.',
      ],
    ],
  },
  {
    name: 'no-visibility-guard',
    witness: 'preserves the draft and prevents automatic delivery after hidden',
    edits: [[composer, '!isVisible ||\n          isArchived', 'isArchived']],
  },
  {
    name: 'no-hidden-entry-guard',
    witness: 'boundary: hidden composer rejects synthetic Enter',
    edits: [
      [composer, 'if (!isVisible) return;', '// Ablation: hidden keyboard entry is allowed.'],
    ],
  },
  {
    name: 'no-immediate-failure-cancel',
    witness: 'boundary: a failed image ends waiting before the other image settles',
    edits: [
      [
        composer,
        'if (failed || sendStateRef.current.blocked || !uploading)',
        'if (sendStateRef.current.blocked || !uploading)',
      ],
    ],
  },
  {
    name: 'no-attachment-membership-guard',
    witness: 'boundary: removing an attachment never silently sends a partial payload',
    edits: [
      [
        composer,
        'expectedFiles.length !== actualFiles.length ||\n            expectedFiles.some((file) => !actualFiles.includes(file)) ||\n            ',
        '',
      ],
    ],
  },
  {
    name: 'no-waiting-draft-guard',
    witness: 'boundary: an external text edit cancels the waiting payload',
    edits: [[composer, 'sessionDraftsCache.get(session.id) !== submittedDraft.text', 'false']],
  },
  {
    name: 'clear-on-rejected-acceptance',
    witness: 'restores uploaded attachments when downstream acceptance rejects the send',
    edits: [
      [
        composer,
        'if (accepted) {\n            if (submission.isCurrent())',
        'if (true) {\n            if (submission.isCurrent())',
      ],
    ],
  },
  {
    name: 'clear-newer-text-on-acceptance',
    witness: 'boundary: a late acceptance preserves an external replacement draft',
    edits: [
      [
        composer,
        'if (sessionDraftsCache.get(session.id) === submittedDraft.text) clearInput();',
        'clearInput();',
      ],
    ],
  },
  {
    name: 'count-old-failed-files',
    witness: 'boundary: an already failed file does not cancel waiting',
    edits: [
      [
        composer,
        "wait.files.has(file.file) && file.status === 'failed'",
        "file.status === 'failed'",
      ],
    ],
  },
  {
    name: 'discard-shortcut-intent',
    witness: 'waits for every image and retains the inverted-send shortcut',
    edits: [
      [
        composer,
        'agentRoleTurnSelectionRef.current,\n            options',
        'agentRoleTurnSelectionRef.current,\n            undefined',
      ],
    ],
  },
  {
    name: 'no-current-token-check',
    witness: 'boundary: retiring the scope during the ready commit',
    edits: [
      [
        composer,
        '!ready || !submission.isCurrent() || sendStateRef.current.blocked',
        '!ready || sendStateRef.current.blocked',
      ],
    ],
  },
];

export function runAblations(worktree, outputDirectory) {
  const originals = new Map();
  for (const variant of variants) {
    for (const [relative] of variant.edits) {
      if (!originals.has(relative))
        originals.set(relative, readFileSync(join(worktree, relative), 'utf8'));
    }
  }
  const results = [];
  for (const variant of variants) {
    const reportPath = join(outputDirectory, `${variant.name}.json`);
    try {
      for (const [relative, before, after] of variant.edits) {
        const path = join(worktree, relative);
        const source = readFileSync(path, 'utf8');
        if (source.split(before).length !== 2)
          throw new Error(`Ambiguous mutation: ${variant.name}`);
        writeFileSync(path, source.replace(before, after));
      }
      const run = spawnSync(
        'pnpm',
        [
          '--filter',
          '@lody/components',
          'exec',
          'vitest',
          'run',
          'tests/session-chat-input-submission.test.tsx',
          'tests/session-message-submit-route.test.ts',
          '--reporter=json',
          `--outputFile=${reportPath}`,
        ],
        { cwd: worktree, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } }
      );
      if (run.error || run.signal)
        throw run.error ?? new Error(`Interrupted mutation: ${variant.name}`);
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
      if (
        !assertions.length ||
        assertions.length !== report.numTotalTests ||
        (report.numRuntimeErrorTestSuites ?? 0) > 0
      ) {
        throw new Error(`Incomplete test collection: ${variant.name}`);
      }
      const failures = assertions.filter((test) => test.status === 'failed');
      const assertionFailures = failures.filter((test) =>
        test.failureMessages.some((message) => message.includes('AssertionError'))
      );
      if (run.status !== 0 && assertionFailures.length === 0) {
        throw new Error(
          `Inconclusive mutation (no behavioral assertion failed): ${variant.name}\n${run.stderr}`
        );
      }
      if (
        variant.witness &&
        !assertionFailures.some((test) => test.fullName.includes(variant.witness))
      ) {
        throw new Error(`Expected behavioral witness did not fail: ${variant.name}`);
      }
      const result = {
        name: variant.name,
        outcome: run.status === 0 ? 'survived' : 'caught',
        collectedTests: assertions.length,
        failedTests: failures.map((test) => test.fullName),
      };
      results.push(result);
      console.log(`${result.outcome}: ${result.name} (${failures.length} failing tests)`);
    } finally {
      for (const [relative, source] of originals) writeFileSync(join(worktree, relative), source);
    }
  }
  console.log(JSON.stringify({ ablations: results }, null, 2));
  return results;
}

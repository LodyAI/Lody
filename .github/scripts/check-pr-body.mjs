#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { hasRelatedIssueLink } from './pr-issue-link.mjs';

const REQUIRED_HEADINGS = [
  '## Related issue',
  '## Problem / pressure',
  '## Summary',
  '## Test plan',
  '## Context handoff',
];
const CONTEXT_HANDOFF_BEGIN = '<!-- context-handoff:begin -->';
const CONTEXT_HANDOFF_END = '<!-- context-handoff:end -->';
const REQUIRED_CONTEXT_HEADINGS = [
  '### Instructions for reviewing agents',
  '### Authoring context',
];
const REVIEW_INSTRUCTION_FIELDS = [
  'Review focus',
  'Decisions to challenge',
  'Plausible failures / evidence gaps',
];
const MAX_REVIEW_INSTRUCTIONS_LENGTH = 1_200;
const AUTHORING_CONTEXT_FIELDS = [
  'User goal / directives',
  'Constraints / non-goals',
  'Risk-bearing decisions',
  'Destructive or irreversible behavior',
  'Deliberately not done or tested',
  'Unknowns / confidence',
];
const PLACEHOLDER_ONLY = /^(?:<!--[\s\S]*?-->|\s|N\/?A|TODO|TBD|\(optional\))*$/i;
const WITHHELD_CONTEXT = /^(?:N\/?A\b|redacted\b)/i;

function parseArgs(argv) {
  const options = {
    body: process.env.PR_BODY ?? '',
    bodyFile: null,
    eventFile: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--body') {
      options.body = argv[++index] ?? '';
    } else if (argument === '--body-file') {
      options.bodyFile = argv[++index] ?? null;
    } else if (argument === '--event-file') {
      options.eventFile = argv[++index] ?? null;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function headingCount(markdown, heading) {
  return markdown.split('\n').filter((line) => line.trimEnd() === heading).length;
}

function sectionBody(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) {
    return null;
  }

  const level = heading.startsWith('### ') ? 3 : 2;
  const nextHeading = level === 3 ? /^#{2,3}(?:\s|$)/ : /^##(?:\s|$)/;
  const next = lines.findIndex((line, index) => index > start && nextHeading.test(line));
  return lines
    .slice(start + 1, next === -1 ? undefined : next)
    .join('\n')
    .trim();
}

function isFilledSection(section) {
  if (section == null) {
    return false;
  }

  const withoutComments = section.replace(/<!--[\s\S]*?-->/g, '').trim();
  return Boolean(withoutComments) && !PLACEHOLDER_ONLY.test(withoutComments);
}

function markdownField(section, field) {
  const prefix = `- **${field}:**`;
  const line = section?.split('\n').find((candidate) => candidate.trimStart().startsWith(prefix));
  if (!line) {
    return null;
  }

  return line
    .trimStart()
    .slice(prefix.length)
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function isCompleteContext(value) {
  const normalized = value?.replaceAll('`', '').trim() ?? '';
  return isFilledSection(normalized) && !WITHHELD_CONTEXT.test(normalized);
}

export function hasRelatedIssueReference(body) {
  return hasRelatedIssueLink(body);
}

export function checkPullRequestBody(body) {
  const text = (body ?? '').replace(/\r\n/g, '\n');
  const findings = [];

  if (!text.trim()) {
    return {
      ok: false,
      findings: ['PR body is empty. Fill `.github/PULL_REQUEST_TEMPLATE.md`.'],
    };
  }

  const requiredHeadingCounts = new Map(
    REQUIRED_HEADINGS.map((heading) => [heading, headingCount(text, heading)])
  );
  for (const [heading, count] of requiredHeadingCounts) {
    if (count === 0) {
      findings.push(`Missing required heading: ${heading}`);
    } else if (count > 1) {
      findings.push(
        `Duplicate required section: ${heading} appears ${count} times; each required section must appear exactly once.`
      );
    }
  }

  if (requiredHeadingCounts.get('## Related issue') === 1 && !hasRelatedIssueReference(text)) {
    findings.push(
      '## Related issue must contain a Lody issue reference such as `Closes #123` or `Refs #123`.'
    );
  }

  for (const heading of ['## Problem / pressure', '## Summary', '## Test plan']) {
    if (requiredHeadingCounts.get(heading) === 1 && !isFilledSection(sectionBody(text, heading))) {
      findings.push(
        `${heading} must contain meaningful content, not only comments or placeholders.`
      );
    }
  }

  const contextHeadingCounts = new Map();
  for (const heading of REQUIRED_CONTEXT_HEADINGS) {
    const count = headingCount(text, heading);
    contextHeadingCounts.set(heading, count);
    if (count === 0) {
      findings.push(`Context handoff must include ${heading}.`);
    } else if (count > 1) {
      findings.push(
        `Duplicate required Context handoff section: ${heading} appears ${count} times; each required section must appear exactly once.`
      );
    }
  }
  if (!text.includes(CONTEXT_HANDOFF_BEGIN) || !text.includes(CONTEXT_HANDOFF_END)) {
    findings.push('Context handoff must keep <!-- context-handoff:begin/end --> markers.');
  }

  if (contextHeadingCounts.get('### Authoring context') === 1) {
    const context = sectionBody(text, '### Authoring context');
    for (const field of AUTHORING_CONTEXT_FIELDS) {
      const value = markdownField(context, field);
      if (!isCompleteContext(value)) {
        findings.push(
          `Authoring context must fill **${field}** with a meaningful public summary; N/A and redacted values are not accepted.`
        );
      }
    }
  }

  if (contextHeadingCounts.get('### Instructions for reviewing agents') === 1) {
    const instructions = sectionBody(text, '### Instructions for reviewing agents');
    for (const field of REVIEW_INSTRUCTION_FIELDS) {
      if (!isCompleteContext(markdownField(instructions, field))) {
        findings.push(
          `Review instructions must fill **${field}** with concise, PR-specific content; N/A and redacted values are not accepted.`
        );
      }
    }
    const visibleInstructions = instructions.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (visibleInstructions.length > MAX_REVIEW_INSTRUCTIONS_LENGTH) {
      findings.push(
        `Review instructions must stay under ${MAX_REVIEW_INSTRUCTIONS_LENGTH} characters and include only the highest-value review guidance.`
      );
    }
  }

  return { ok: findings.length === 0, findings };
}

function bodyFromOptions(options) {
  if (options.eventFile) {
    const event = JSON.parse(readFileSync(options.eventFile, 'utf8'));
    return event.pull_request?.body ?? '';
  }
  if (options.bodyFile) {
    return readFileSync(options.bodyFile, 'utf8');
  }
  return options.body;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (options.help) {
    console.log(
      'Usage: node .github/scripts/check-pr-body.mjs [--event-file event.json | --body-file body.md | --body text]'
    );
    return;
  }

  const result = checkPullRequestBody(bodyFromOptions(options));
  if (result.ok) {
    console.log('PR body format OK');
    return;
  }

  console.error('PR body does not match the Lody pull request template:\n');
  for (const finding of result.findings) {
    console.error(`- ${finding}`);
  }
  console.error('\nSee `.github/PULL_REQUEST_TEMPLATE.md`.');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

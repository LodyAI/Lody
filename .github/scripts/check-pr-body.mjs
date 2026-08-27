#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REQUIRED_HEADINGS = ['## Author type', '## Problem / pressure', '## Summary', '## Test plan'];
const AGENT_CHECKBOX = /- \[x\] I am an Agent/i;
const HUMAN_CHECKBOX = /- \[x\] I am a human/i;
const AGENT_HANDOFF_BEGIN = '<!-- agent-handoff:begin -->';
const AGENT_HANDOFF_END = '<!-- agent-handoff:end -->';
const REQUIRED_AGENT_HEADINGS = [
  '## Agent handoff',
  '### Instructions for reviewing agents',
  '### Authoring context',
  '### Sharing consent (author side)',
];
const PLACEHOLDER_ONLY = /^(?:<!--[\s\S]*?-->|\s|N\/?A|TODO|TBD|\(optional\))*$/i;

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

export function checkPullRequestBody(body) {
  const text = (body ?? '').replace(/\r\n/g, '\n');
  const findings = [];

  if (!text.trim()) {
    return {
      ok: false,
      findings: ['PR body is empty. Fill `.github/PULL_REQUEST_TEMPLATE.md`.'],
      agent: false,
      human: false,
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

  const agent = AGENT_CHECKBOX.test(text);
  const human = HUMAN_CHECKBOX.test(text);
  if (!agent && !human) {
    findings.push(
      'Author type: check exactly one of "I am an Agent" or "I am a human" (`- [x] ...`).'
    );
  } else if (agent && human) {
    findings.push('Author type: check only one of Agent or human, not both.');
  }

  for (const heading of ['## Problem / pressure', '## Summary', '## Test plan']) {
    if (requiredHeadingCounts.get(heading) === 1 && !isFilledSection(sectionBody(text, heading))) {
      findings.push(
        `${heading} must contain meaningful content, not only comments or placeholders.`
      );
    }
  }

  if (agent) {
    for (const heading of REQUIRED_AGENT_HEADINGS) {
      const count = headingCount(text, heading);
      if (count === 0) {
        findings.push(`Agent PRs must include ${heading}.`);
      } else if (count > 1) {
        findings.push(
          `Duplicate required Agent section: ${heading} appears ${count} times; each required Agent section must appear exactly once.`
        );
      }
    }
    if (!text.includes(AGENT_HANDOFF_BEGIN) || !text.includes(AGENT_HANDOFF_END)) {
      findings.push('Agent PRs must keep <!-- agent-handoff:begin/end --> markers.');
    }
  }

  return { ok: findings.length === 0, findings, agent, human };
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
    console.log(
      `PR body format OK${result.agent ? ' (agent)' : ''}${result.human ? ' (human)' : ''}`
    );
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

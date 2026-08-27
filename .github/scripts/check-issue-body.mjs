const ISSUE_FORMS = [
  Object.freeze({
    name: 'Bug report',
    titlePrefix: '[Bug]',
    requiredHeadings: [
      '### Affected area',
      '### Installation method',
      '### Lody version or commit',
      '### Operating system',
      '### What happened?',
      '### What did you expect?',
      '### How can we reproduce it?',
      '### How often does it happen?',
      '### Before submitting',
    ],
    requiredConfirmations: [
      'I searched the existing issues and did not find a duplicate.',
      'This report concerns an open-source component in this repository, not a hosted service, Web or mobile app, account, or billing issue.',
      "This is not a security vulnerability; security reports follow the repository's security policy.",
      'I removed credentials, private source, conversations, prompts, personal data, and other sensitive information.',
      'If I plan to submit a pull request, I will wait for a Lody maintainer to explicitly agree on the scope and approach before implementation.',
    ],
  }),
  Object.freeze({
    name: 'Feature request',
    titlePrefix: '[Feature Request]',
    requiredHeadings: [
      '### Affected area',
      '### Problem or workflow pressure',
      '### Desired outcome',
      '### Before submitting',
    ],
    requiredConfirmations: [
      'I searched the existing issues and did not find a duplicate request.',
      'This request concerns an open-source component in this repository, not a hosted service, Web or mobile app, account, or billing issue.',
      'I removed credentials, private source, conversations, prompts, personal data, and other sensitive information.',
      'I will wait for a Lody maintainer to explicitly agree on the scope and approach before implementation or a pull request.',
    ],
  }),
];

const PLACEHOLDER_ONLY = /^(?:<!--[\s\S]*?-->|\s|_?No response_?|N\/?A|TODO|TBD)*$/i;

function headingCount(markdown, heading) {
  return markdown.split('\n').filter((line) => line.trimEnd() === heading).length;
}

function sectionBody(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) {
    return null;
  }

  const next = lines.findIndex((line, index) => index > start && /^#{1,3}(?:\s|$)/.test(line));
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasCheckedConfirmation(section, text) {
  return new RegExp(`^- \\[x\\] ${escapeRegExp(text)}$`, 'im').test(section ?? '');
}

export function checkIssueBody(issue) {
  const title = issue?.title?.trim() ?? '';
  const body = (issue?.body ?? '').replace(/\r\n/g, '\n');
  const form = ISSUE_FORMS.find((candidate) => title.startsWith(candidate.titlePrefix));
  const findings = [];

  if (!form) {
    return {
      ok: false,
      findings: [
        'Title must begin with `[Bug]` or `[Feature Request]`; open the matching Issue Form and keep its structure.',
      ],
      form: null,
    };
  }

  if (!title.slice(form.titlePrefix.length).trim()) {
    findings.push(`Add a descriptive title after ${form.titlePrefix}.`);
  }
  if (!body.trim()) {
    findings.push(`Issue body is empty; use the ${form.name} form.`);
    return { ok: false, findings, form: form.name };
  }

  for (const heading of form.requiredHeadings) {
    const count = headingCount(body, heading);
    if (count === 0) {
      findings.push(`Missing required section: ${heading}`);
    } else if (count > 1) {
      findings.push(`Duplicate required section: ${heading}`);
    } else if (!isFilledSection(sectionBody(body, heading))) {
      findings.push(`${heading} must contain a meaningful answer.`);
    }
  }

  const confirmations = sectionBody(body, '### Before submitting');
  for (const confirmation of form.requiredConfirmations) {
    if (!hasCheckedConfirmation(confirmations, confirmation)) {
      findings.push(`Required confirmation is missing or unchecked: ${confirmation}`);
    }
  }

  return { ok: findings.length === 0, findings, form: form.name };
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkIssueBody } from './check-issue-body.mjs';

const bugBody = `### Affected area

CLI / daemon

### Installation method

Built from source

### Lody version or commit

test

### Operating system

macOS

### What happened?

The command failed.

### What did you expect?

The command should succeed.

### How can we reproduce it?

Run the command.

### How often does it happen?

Always

### Before submitting

- [x] I searched the existing issues and did not find a duplicate.
- [x] This report concerns an open-source component in this repository, not a hosted service, Web or mobile app, account, or billing issue.
- [x] This is not a security vulnerability; security reports follow the repository's security policy.
- [x] I removed credentials, private source, conversations, prompts, personal data, and other sensitive information.
`;

const featureBody = `### Affected area

CLI / daemon

### Problem or workflow pressure

The workflow is difficult.

### Desired outcome

The workflow becomes easier.

### Before submitting

- [x] I searched the existing issues and did not find a duplicate request.
- [x] This request concerns an open-source component in this repository, not a hosted service, Web or mobile app, account, or billing issue.
- [x] I removed credentials, private source, conversations, prompts, personal data, and other sensitive information.
`;

void describe('Issue body validation', () => {
  void it('does not require maintainer agreement for bug reports', () => {
    const result = checkIssueBody({ title: '[Bug] Command failure', body: bugBody });
    assert.equal(result.ok, true);
  });

  void it('does not require maintainer agreement for feature requests', () => {
    const result = checkIssueBody({
      title: '[Feature Request] Better workflow',
      body: featureBody,
    });
    assert.equal(result.ok, true);
  });
});

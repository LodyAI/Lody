# Contributing Guide

Thank you for your interest in contributing to Lody! Bug reports, documentation improvements, tests, and new features are all welcome.

## Contribution Terms

By submitting a pull request, patch, or other contribution to Lody, you agree to the following terms:

- You have the right to submit the contribution. It is your original work, or you have the necessary permission to contribute it.
- Unless you explicitly state otherwise in writing, your contribution is submitted under the Apache License, Version 2.0.
- You retain copyright in your contribution. You grant Lody and all recipients the rights provided by the Apache License, including the right to use, modify, distribute, and sublicense the contribution.
- Lody may use contributions in open-source and commercial products and services, subject to the Apache License.
- If you cannot agree to these terms, please do not submit the contribution. A separate written agreement with Lody takes precedence over these terms.

## Before You Start

1. Search existing issues and pull requests to avoid duplicate work.
2. Report reproducible problems with the [bug report form](https://github.com/LodyAI/Lody/issues/new?template=01-bug-report.yml).
3. For substantial improvements, use the [feature request form](https://github.com/LodyAI/Lody/issues/new?template=02-feature-request.yml) to discuss the need, scope, and approach with maintainers before implementation.
4. Do not report security vulnerabilities in a public issue; follow the [security policy](./SECURITY.md) instead.

Keep the selected Issue Form structure, required answers, confirmations, and `[Bug]` or `[Feature Request]` title prefix. Issues that do not conform are marked `status:needs-issue-body` with a warning until corrected. Only repository owners and automated bots are exempt; regular organization members must also use the forms.

## Get the Code

The repository uses Git submodules for ACP runtimes, so clone it recursively:

```bash
git clone --recurse-submodules https://github.com/LodyAI/lody.git
cd lody
```

For an existing checkout, initialise the submodules:

```bash
git submodule update --init --recursive
```

## Local Development

You need Node.js 22 or later and the pnpm version specified by this project.

```bash
pnpm install
pnpm start:local
```

This builds the local CLI and open-source desktop renderer, then launches Electron. The first run may take a while. Fully quit any existing Lody desktop process first because the app allows only one running instance.

The open-source build is local-first: it needs no `.env` file, Lody account, or cloud environment variables. Cloud endpoints and telemetry variables are not used.

## Isolate Local Data While Developing

By default, the open-source desktop app stores data in `~/.lody-oss`. To avoid using existing data during development, set `LODY_DATA_DIR`:

```bash
LODY_DATA_DIR="$(pwd)/.lody-dev-data" pnpm start:local
```

PowerShell:

```powershell
$env:LODY_DATA_DIR = "$PWD/.lody-dev-data"
pnpm start:local
```

This variable is optional. Never commit the generated data or credentials.

## Submitting Changes

1. Create a clearly named branch from the latest code.
2. Keep changes focused; avoid unrelated formatting or refactoring.
3. Add or update tests for behavior changes, and make sure the existing tests pass.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, for example:

   ```text
   feat: add workspace search
   fix: handle empty session title
   docs: improve local setup guide
   ```

5. Open a pull request using the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md). Every external pull request must link the full URL of a Lody issue and fill in the problem, summary, test plan, and Context handoff. The handoff gives the maintainers' reviewing Agent concise, PR-specific review focus, decisions to challenge, plausible failures or evidence gaps, and a public summary of the authoring context. Every field is required; `N/A` and redacted answers are rejected because they do not provide enough context for a safe review.

An external pull request with an invalid body is marked `status:needs-pr-body`. Fix the body within seven days to clear the status automatically. If it remains invalid beyond that grace period, the pull request is marked `status:pr-body-expired` and closed; submit a new pull request with the current template to continue contributing the change.

Keep external contributions at or below 200 changed lines, counted as additions plus deletions. Larger changes are closed by default unless the pull request links the Lody issue where the design and scope were discussed first. Open the issue, wait for maintainers to agree that a pull request is appropriate, and then submit the pull request; the automation checks for the issue reference but does not decide whether maintainers approved the design. A large pull request closed under this policy is marked `status:pr-too-large` and will not be reopened, so continue through a new pull request after discussion.

Pull requests are automatically labeled with one or more `scope:*` labels based on the changed paths. The [scope mapping](./.github/labeler.yml) uses each top-level key as a label name and its globs as matching paths; the [scope workflow](./.github/workflows/pr-scope.yml) creates or applies matching labels and removes configured labels that stop matching. Manually applied and unconfigured labels are left unchanged.

## Code Guidelines

- Follow the existing code style and directory structure.
- Do not commit secrets, access tokens, real user data, or user/agent transcripts. Test data must be synthetic.

Thank you for contributing!

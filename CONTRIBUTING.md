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
2. For substantial features, please open an issue first to discuss the approach with maintainers.
3. Do not report security vulnerabilities in a public issue; follow the [security policy](./SECURITY.md) instead.

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

5. Open a pull request using the provided template. Identify whether an Agent or a human authored it, then fill in the problem, summary, and test plan. Before publishing Agent handoff context, the authoring Agent must ask the author-side user for permission and record exactly one consent answer. For external contributors, an automated check enforces this format.

Pull requests are automatically labeled with one or more `scope:*` labels based on the changed paths. These labels describe the affected product areas; contributors do not need to select them manually.

## Code Guidelines

- Follow the existing code style and directory structure.
- Do not commit secrets, access tokens, real user data, or user/agent transcripts. Test data must be synthetic.

Thank you for contributing!

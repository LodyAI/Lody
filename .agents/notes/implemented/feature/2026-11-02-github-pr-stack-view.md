# GitHub pull request stack context

Status: implemented
Translation: current

[中文](2026-11-02-github-pr-stack-view.zh.md)

## Abstract

GitHub now records stacked pull requests explicitly. The PR panel reads that membership and the stack's ordered members, showing their states and links to GitHub. If the stack details request fails, the panel retains the known position and offers the GitHub link. Stack merges remain on GitHub because the existing synchronous merge endpoint cannot merge a stack.

## Decision and limits

Use GitHub's membership, not inferred branch relationships: related branches are not necessarily a registered stack. Fetch stack details with the same access identity as PR details, and keep the PR usable if the extra read fails. Links open each layer on GitHub; in-panel navigation and stack creation, rebase, and asynchronous merge are future work. A fresh PR read also guards the legacy merge action against a PR that joined a stack after the panel loaded.

The stack rows reuse the existing PR status icons and colors, with a highlighted current layer. Their accessible link labels include the status, so color is not the only signal. The visual convention follows GitHub's [Primer icon guidance](https://primer.style/octicons/usage-guidelines/).

GitHub documents [stack membership and merge requirements](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks) and the [stack endpoint](https://docs.github.com/en/rest/pulls/stacks). This extends the existing [local observation decision](../feature/2026-09-24-local-github-pr-observation.md); local summary access alone still opens GitHub externally.

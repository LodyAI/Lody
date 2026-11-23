# Route desktop Nightly notifications through release approval

Status: implemented
Translation: pending

## Abstract

Publishing a desktop build for every main update creates more releases than
maintainers want to approve. The OSS notification now targets the recipient's
Nightly release-PR maintenance workflow instead of its publisher. Notifications
carry an accepted source SHA and may be coalesced into one pending PR; only a
subsequent approved merge authorizes publishing. The public workflow still has
no installer signing or storage credentials.

## Contract and rollout

Keep the existing destination-scoped GitHub App and Actions-write permission.
Send `source_repository` and the full main SHA to `nightly-release-pr.yml` on the
configured recipient's main branch. Do not restore a direct publisher dispatch.
Deploy the receiving maintenance workflow before this notification target changes;
otherwise notifications fail rather than bypassing approval. Receiving build and
release configuration remains outside this public repository.

Validation covers workflow parsing and the receiving implementation's admission
and race tests. Live notification and release-PR creation require the coordinated
workflow rollout; they have not been claimed as completed by local tests.

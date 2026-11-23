# Personal host workflows

Parent package and repository instructions apply. Edit `AGENTS.md` only.

- `restoreVaultWorkspaces` restores at most four distinct workspace targets concurrently.
  Keep every reference for the same target in its original serial order and return
  results in vault-index order. Each attempt retains its own Scope and durable
  progress; parent completion joins all admitted work before releasing the vault.
  `onResult` observes each adopted result after its attempt scope drains; observer
  failure cannot undo committed work. Partial epoch keys remain explicitly marked.
  Rationale and ownership are in the
  [recovery integration note](../../../.agents/notes/proposed/feature/2026-10-30-e2ee-recovery-vault-desktop.md#restore-scheduling).

Restores report partial epoch-key recovery separately from admission and content
readiness, and retain the retryable journal until the current epoch key is installed.
The host's single-workspace `restoreRecovery` writes the same progress markers through
`recoveryRestoreProgress`. Without a retained offer it restores the account identity,
and an identity the verified history shows revoked restores as its replacement.

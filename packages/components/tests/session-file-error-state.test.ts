import { describe, expect, it } from 'vitest';
import {
  getSessionFileErrorPresentation,
  offersFileActions,
} from '../src/components/sessions/session-file-error-state';

const t = (_key: string, fallback: string) => fallback;

describe('getSessionFileErrorPresentation', () => {
  it('turns workspace escape diagnostics into a clear security explanation', () => {
    expect(getSessionFileErrorPresentation('Path escapes workspace root.', undefined, t)).toEqual({
      kind: 'outside-workspace',
      title: 'File is outside the workspace',
      description:
        'For security, Lody can only read files inside this session’s workspace and Lody’s own temporary directories. Choose a file from the workspace and try again.',
    });
  });

  it('prefers the outside-workspace explanation over a generic permission reason', () => {
    // File Preview v3 reports a rejected path as `permission-denied`; "Access
    // denied" would wrongly suggest a filesystem permission problem.
    expect(
      getSessionFileErrorPresentation(
        'File is outside the workspace: preview is limited to this session’s workspace and Lody temporary directories.',
        'permission-denied',
        t
      )
    ).toMatchObject({ kind: 'outside-workspace' });
  });

  it('uses structured provider reasons for actionable file errors', () => {
    expect(getSessionFileErrorPresentation('Text too large', 'text-too-large', t)).toMatchObject({
      kind: 'too-large',
      title: 'File is too large to preview',
    });
    expect(
      getSessionFileErrorPresentation('Permission denied', 'permission-denied', t)
    ).toMatchObject({
      kind: 'permission-denied',
      title: 'Access denied',
    });
  });

  it('keeps unexpected diagnostics behind technical details', () => {
    expect(getSessionFileErrorPresentation('RPC failed with code -32000', undefined, t)).toEqual({
      kind: 'unknown',
      title: 'Could not open this file',
      description:
        'Lody could not read this file. Try again, or check the file on the host machine.',
      technicalDetails: 'RPC failed with code -32000',
    });
  });

  it('classifies an unavailable session worktree as a host availability problem', () => {
    expect(
      getSessionFileErrorPresentation('Session worktree is unavailable.', undefined, t)
    ).toMatchObject({ kind: 'temporarily-unavailable' });
  });

  it('tells the user to retry an owner-session mismatch instead of giving up on the file', () => {
    // The client derives the owner from synced session meta and the machine
    // from the live session, so they disagree while a session is (re)starting.
    expect(
      getSessionFileErrorPresentation('Code Collab RPC owner session mismatch.', undefined, t)
    ).toMatchObject({
      kind: 'temporarily-unavailable',
      title: 'File is not ready yet',
    });
  });

  it('prefers the retry explanation over the permission reason the machine sends with it', () => {
    // The machine codes an owner mismatch as `permission_denied`, which the
    // provider maps to `permission-denied`. Taking the reason at face value
    // renders "Access denied" — a permanent verdict on a transient race.
    expect(
      getSessionFileErrorPresentation(
        'Code Collab RPC owner session mismatch.',
        'permission-denied',
        t
      )
    ).toMatchObject({ kind: 'temporarily-unavailable', title: 'File is not ready yet' });
  });
  it('offers a way out only where opening the file outside Lody would help', () => {
    // On a missing, denied, or offline file every action on the card would
    // fail, so the card must not grow one.
    expect(offersFileActions('too-large')).toBe(true);
    expect(offersFileActions('unsupported')).toBe(true);
    expect(offersFileActions('not-found')).toBe(false);
    expect(offersFileActions('permission-denied')).toBe(false);
    expect(offersFileActions('temporarily-unavailable')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { SessionStatusFactory, isActiveSessionStatus } from '../src/session-status-machine';

describe('session-status-machine', () => {
  describe('SessionStatusFactory', () => {
    it('creates idle status', () => {
      const status = SessionStatusFactory.idle();
      expect(status).toEqual({ type: 'idle' });
    });

    it('creates running status', () => {
      const status = SessionStatusFactory.running();
      expect(status).toEqual({ type: 'running' });
    });

    it('creates running status with activity', () => {
      const status = SessionStatusFactory.running('image_generation');
      expect(status).toEqual({ type: 'running', activity: 'image_generation' });
    });

    it('creates initializing status without stage', () => {
      const status = SessionStatusFactory.initializing();
      expect(status).toEqual({ type: 'initializing', stage: undefined, detail: undefined });
    });

    it('creates initializing status with stage', () => {
      const status = SessionStatusFactory.initializing('git-clone');
      expect(status).toEqual({ type: 'initializing', stage: 'git-clone', detail: undefined });
    });

    it('creates initializing status with stage and detail', () => {
      const status = SessionStatusFactory.initializing('git-clone', 'owner/repo');
      expect(status).toEqual({ type: 'initializing', stage: 'git-clone', detail: 'owner/repo' });
    });

    it('supports all initializing stages', () => {
      expect(SessionStatusFactory.initializing('git-clone').stage).toBe('git-clone');
      expect(SessionStatusFactory.initializing('acp').stage).toBe('acp');
      expect(SessionStatusFactory.initializing('resuming').stage).toBe('resuming');
    });
  });

  describe('isActiveSessionStatus', () => {
    it('returns false for undefined status', () => {
      expect(isActiveSessionStatus(undefined)).toBe(false);
    });

    it('returns false for idle status', () => {
      expect(isActiveSessionStatus(SessionStatusFactory.idle())).toBe(false);
    });

    it('returns true for running status', () => {
      expect(isActiveSessionStatus(SessionStatusFactory.running())).toBe(true);
    });

    it('returns true for initializing status', () => {
      expect(isActiveSessionStatus(SessionStatusFactory.initializing())).toBe(true);
    });

    it('returns true for initializing status with any stage', () => {
      expect(isActiveSessionStatus(SessionStatusFactory.initializing('git-clone'))).toBe(true);
      expect(isActiveSessionStatus(SessionStatusFactory.initializing('acp'))).toBe(true);
      expect(isActiveSessionStatus(SessionStatusFactory.initializing('resuming'))).toBe(true);
    });
  });
});

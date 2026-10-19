import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  registerLocalSupervisorControl,
  resolveLocalSupervisorIdentity,
  scrubLocalSupervisorCapabilityEnv,
  toRuntimeSupervisorIdentity,
} from './local-supervisor-control';

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

describe('local supervisor control', () => {
  it('requires a complete contract-matched supervisor identity', () => {
    expect(
      resolveLocalSupervisorIdentity({
        LODY_DAEMON_SUPERVISED: '1',
        LODY_SUPERVISOR_CONTRACT: '3',
      })
    ).toEqual({ status: 'invalid', reason: 'Invalid daemon supervisor identity' });
    expect(
      resolveLocalSupervisorIdentity({
        LODY_DAEMON_SUPERVISED: '1',
        LODY_ELECTRON_BOOTSTRAP: '1',
      })
    ).toEqual({
      status: 'invalid',
      reason: 'Conflicting daemon and Electron supervisor launch markers',
    });
    expect(resolveLocalSupervisorIdentity({})).toEqual({ status: 'unsupervised' });

    const resolution = resolveLocalSupervisorIdentity({
      LODY_DAEMON_SUPERVISED: '1',
      LODY_SUPERVISOR_CONTRACT: '3',
      LODY_SUPERVISOR_PID: '123',
      LODY_SUPERVISOR_INSTANCE_ID: 'instance-a',
      LODY_SUPERVISOR_TOKEN: 'x'.repeat(32),
    });

    expect(resolution).toEqual({
      status: 'supervised',
      identity: {
        launchMode: 'daemon',
        pid: 123,
        instanceId: 'instance-a',
        token: 'x'.repeat(32),
      },
    });
    const identity = resolution.status === 'supervised' ? resolution.identity : null;
    expect(toRuntimeSupervisorIdentity(identity)).toEqual({
      launchMode: 'daemon',
      pid: 123,
      instanceId: 'instance-a',
    });
  });

  it('rejects a supervisor speaking a different contract version', () => {
    const mismatched = resolveLocalSupervisorIdentity({
      LODY_DAEMON_SUPERVISED: '1',
      LODY_SUPERVISOR_CONTRACT: '0',
      LODY_SUPERVISOR_PID: '123',
      LODY_SUPERVISOR_INSTANCE_ID: 'instance-a',
      LODY_SUPERVISOR_TOKEN: 'x'.repeat(32),
    });
    expect(mismatched.status).toBe('invalid');
    expect(mismatched.status === 'invalid' && mismatched.reason).toContain('contract version 0');

    const missing = resolveLocalSupervisorIdentity({ LODY_DAEMON_SUPERVISED: '1' });
    expect(missing.status).toBe('invalid');
    expect(missing.status === 'invalid' && missing.reason).toContain('contract version (none)');
  });

  it.each(['1', '2'])(
    'rejects old launch contract %s before runtime ownership is granted',
    (version) => {
      const result = resolveLocalSupervisorIdentity({
        LODY_DAEMON_SUPERVISED: '1',
        LODY_SUPERVISOR_CONTRACT: version,
        LODY_SUPERVISOR_PID: '123',
        LODY_SUPERVISOR_INSTANCE_ID: 'old-host',
        LODY_SUPERVISOR_TOKEN: 'x'.repeat(32),
      });
      expect(result).toEqual({
        status: 'invalid',
        reason: `The daemon supervisor speaks contract version ${version}, but this worker requires version 3`,
      });
    }
  );

  it('scrubs the private supervisor capability after validation', () => {
    const env: NodeJS.ProcessEnv = {
      LODY_DAEMON_SUPERVISED: '1',
      LODY_SUPERVISOR_CONTRACT: '3',
      LODY_SUPERVISOR_PID: '123',
      LODY_SUPERVISOR_INSTANCE_ID: 'instance-a',
      LODY_SUPERVISOR_TOKEN: 'x'.repeat(32),
      KEEP_ME: 'yes',
    };

    scrubLocalSupervisorCapabilityEnv(env);

    expect(env).toEqual({ KEEP_ME: 'yes' });
  });

  it('accepts shutdown only for the matching private IPC capability', () => {
    const shutdown = vi.fn();
    const messageSource = new EventEmitter();
    Object.assign(messageSource, { send: vi.fn(), connected: true });
    const dispose = registerLocalSupervisorControl({
      identity: {
        launchMode: 'electron',
        pid: 321,
        instanceId: 'instance-b',
        token: 'secret'.repeat(6),
      },
      logger: { info: vi.fn() } as never,
      shutdown,
      messageSource,
    });
    cleanup.push(dispose);

    messageSource.emit('message', {
      type: 'lody/supervisor-shutdown',
      instanceId: 'instance-b',
      token: 'wrong'.repeat(7),
    });
    expect(shutdown).not.toHaveBeenCalled();

    messageSource.emit('message', {
      type: 'lody/supervisor-shutdown',
      instanceId: 'instance-b',
      token: 'secret'.repeat(6),
    });
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('shuts down once when the supervisor IPC channel disconnects', () => {
    const shutdown = vi.fn();
    const messageSource = new EventEmitter();
    Object.assign(messageSource, { send: vi.fn(), connected: true });
    const dispose = registerLocalSupervisorControl({
      identity: {
        launchMode: 'electron',
        pid: 321,
        instanceId: 'instance-c',
        token: 'private'.repeat(5),
      },
      logger: { info: vi.fn() } as never,
      shutdown,
      messageSource,
    });
    cleanup.push(dispose);

    messageSource.emit('disconnect');
    messageSource.emit('disconnect');

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('fails closed when a supervised worker has no live IPC parent', async () => {
    const shutdown = vi.fn();
    const messageSource = new EventEmitter();
    const dispose = registerLocalSupervisorControl({
      identity: {
        launchMode: 'daemon',
        pid: 321,
        instanceId: 'instance-d',
        token: 'private'.repeat(5),
      },
      logger: { info: vi.fn() } as never,
      shutdown,
      messageSource,
    });
    cleanup.push(dispose);

    await Promise.resolve();

    expect(shutdown).toHaveBeenCalledOnce();
  });
});

import { daemonLossObserver } from './e2ee/client-loss-observer';
import type * as http from 'http';
import * as os from 'os';
import type { CliRuntimeState, MachineId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

export interface LocalProbeConfig {
  machineId: MachineId;
  cliVersion: string;
  logger: Logger;
  getRuntimeState: () => CliRuntimeState;
}

export function createLocalProbeRequestHandler(config: LocalProbeConfig): http.RequestListener {
  const responseBody = JSON.stringify({
    ok: true,
    machineId: config.machineId,
    pid: process.pid,
    cliVersion: config.cliVersion,
    homeDir: os.homedir(),
  });

  return (req, res) => {
    if (
      daemonLossObserver.enabled &&
      req.method === 'GET' &&
      req.url?.startsWith('/e2e/client-loss?')
    ) {
      const url = new URL(req.url, 'http://local');
      const workspaceId = url.searchParams.get('workspaceId');
      const requesterDevice = url.searchParams.get('requesterDevice');
      const after = url.searchParams.get('afterSequence');
      const wait = url.searchParams.get('wait');
      if (
        !requesterDevice ||
        !/^[0-9a-f]{64}$/.test(requesterDevice) ||
        !workspaceId ||
        workspaceId.length > 128 ||
        !/^[a-zA-Z0-9_-]+$/.test(workspaceId) ||
        [...url.searchParams.keys()].some(
          (key) => !['workspaceId', 'requesterDevice', 'afterSequence', 'wait'].includes(key)
        ) ||
        [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1) ||
        (after !== null && !/^(0|[1-9][0-9]{0,14})$/.test(after)) ||
        (wait !== null && wait !== '1') ||
        (wait === '1' && after === null)
      ) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'daemon_loss_input' }));
        return;
      }
      const abort = new AbortController();
      res.once('close', () => abort.abort());
      const respond = async () => {
        try {
          const value =
            wait === '1'
              ? await daemonLossObserver.wait(
                  workspaceId,
                  Number(after),
                  abort.signal,
                  30_000,
                  requesterDevice
                )
              : daemonLossObserver.inspect(workspaceId, requesterDevice);
          res.writeHead(value ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(value ?? { error: 'daemon_loss_missing' }));
        } catch (cause) {
          if (abort.signal.aborted) return;
          const code =
            cause instanceof Error && cause.message === 'daemon_loss_deadline'
              ? 'daemon_loss_deadline'
              : 'daemon_loss_unavailable';
          res.writeHead(code === 'daemon_loss_deadline' ? 504 : 500, {
            'Content-Type': 'application/json',
          });
          res.end(JSON.stringify({ error: code }));
        }
      };
      void respond();
      return;
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(responseBody);
      return;
    }

    if (req.method === 'GET' && req.url === '/state') {
      try {
        const state = config.getRuntimeState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
      } catch (error) {
        const message = formatErrorMessage(error);
        config.logger.debug(`Failed to read runtime state for local probe: ${message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'state_unavailable',
            message,
          })
        );
      }
      return;
    }

    res.writeHead(404);
    res.end();
  };
}

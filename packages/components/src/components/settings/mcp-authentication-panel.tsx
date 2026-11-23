import { McpAuthenticationView } from './mcp-authentication-view';
import { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { McpAuthenticationResult, WorkspaceMcpServerMeta } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { userAtom } from '@/atoms';
import { openExternalUrl } from '@/lib/native-browser';

const failed: McpAuthenticationResult = {
  type: 'mcp/authentication',
  status: 'error',
  hasCredentials: false,
  reason: 'connection_failed',
};

export function McpAuthenticationPanel({
  server,
  disabled,
  onEnable,
  onConnected,
  onStatus,
  httpControls,
}: {
  server: WorkspaceMcpServerMeta;
  disabled: boolean;
  httpControls: boolean;
  onEnable: (server: WorkspaceMcpServerMeta) => Promise<WorkspaceMcpServerMeta>;
  onConnected: (server: WorkspaceMcpServerMeta) => void;
  onStatus: (status: McpAuthenticationResult) => void;
}) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const machineId = useAtomValue(localMachineIdAtom);
  const requesterUserId = useAtomValue(userAtom)?.id;
  const [status, setStatus] = useState<McpAuthenticationResult>();
  const [busy, setBusy] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const generation = useRef(0);
  const ownedAttempt = useRef<string | undefined>(undefined);
  const currentServer = useRef(server);
  currentServer.current = server;
  const callbacks = useRef({ onStatus, onConnected });
  callbacks.current = { onStatus, onConnected };
  const destination = server.connection?.transport === 'http' ? server.connection.url : '';

  useEffect(() => {
    const current = ++generation.current;
    setStatus(undefined);
    setBusy(false);
    setClientId('');
    setClientSecret('');
    if (runtime && machineId && requesterUserId)
      void runtime
        .requestLocalMcpAuthentication(machineId, {
          requesterUserId: requesterUserId ?? '',
          action: 'status',
          server: currentServer.current,
        })
        .then((value) => {
          if (generation.current === current) {
            setStatus(value);
            callbacks.current.onStatus(value);
          }
        })
        .catch(() => {
          if (generation.current === current) setStatus(failed);
        });
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- This is an RPC epoch counter, not a DOM ref.
      generation.current++;
      const attemptId = ownedAttempt.current;
      ownedAttempt.current = undefined;
      if (runtime && machineId && attemptId)
        void runtime
          .requestLocalMcpAuthentication(machineId, {
            requesterUserId: requesterUserId ?? '',
            action: 'cancel',
            server: currentServer.current,
            attemptId,
          })
          .catch(() => {});
    };
  }, [runtime, machineId, requesterUserId, server.id, destination]);

  useEffect(() => {
    if (!runtime || !machineId || !requesterUserId || status?.status !== 'waiting')
      return undefined;
    const current = generation.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await runtime.requestLocalMcpAuthentication(machineId, {
          requesterUserId: requesterUserId ?? '',
          action: 'status',
          server: currentServer.current,
        });
        if (stopped || generation.current !== current) return;
        setStatus(value);
        callbacks.current.onStatus(value);
        if (value.status === 'authorized') {
          ownedAttempt.current = undefined;
          callbacks.current.onConnected(currentServer.current);
        } else if (value.status === 'waiting') timer = setTimeout(() => void poll(), 1000);
      } catch {
        if (!stopped && generation.current === current) timer = setTimeout(() => void poll(), 1000);
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runtime, machineId, requesterUserId, status?.status]);

  const publish = (value: McpAuthenticationResult) => {
    setStatus(value);
    callbacks.current.onStatus(value);
  };
  const authorize = async () => {
    if (!runtime || !machineId || !requesterUserId || disabled) return;
    const current = ++generation.current;
    setBusy(true);
    let target = currentServer.current;
    try {
      target = await onEnable(target);
      currentServer.current = target;
      if (generation.current !== current) return;
      if (clientId.trim() || clientSecret) {
        const configured = await runtime.requestLocalMcpAuthentication(machineId, {
          requesterUserId: requesterUserId ?? '',
          action: 'configure',
          server: target,
          authentication: {
            mode: 'oauth',
            ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
            ...(clientSecret ? { clientSecret } : {}),
          },
        });
        setClientSecret('');
        if (generation.current !== current) return;
        if (configured.status === 'error') {
          publish(configured);
          return;
        }
      }
      if (generation.current !== current) return;
      const value = await runtime.requestLocalMcpAuthentication(machineId, {
        requesterUserId: requesterUserId ?? '',
        action: 'authorize',
        server: target,
      });
      if (generation.current !== current) {
        if (value.attemptId)
          await runtime.requestLocalMcpAuthentication(machineId, {
            requesterUserId: requesterUserId ?? '',
            action: 'cancel',
            server: target,
            attemptId: value.attemptId,
          });
        return;
      }
      ownedAttempt.current = value.attemptId;
      publish(value);
      if (value.authorizationUrl) {
        const url = new URL(value.authorizationUrl);
        if (
          url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        )
          throw new Error('Unsupported authorization destination.');
        if (!(await openExternalUrl(url.toString()))) {
          if (value.attemptId)
            await runtime.requestLocalMcpAuthentication(machineId, {
              requesterUserId: requesterUserId ?? '',
              action: 'cancel',
              server: target,
              attemptId: value.attemptId,
            });
          if (generation.current === current) publish(failed);
        }
      }
    } catch {
      if (generation.current === current) publish(failed);
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };
  const act = async (action: 'cancel' | 'signout') => {
    if (!runtime || !machineId || !requesterUserId) return;
    const current = ++generation.current;
    setBusy(true);
    try {
      const value = await runtime.requestLocalMcpAuthentication(machineId, {
        requesterUserId: requesterUserId ?? '',
        server: currentServer.current,
        action,
        ...(action === 'cancel' && status?.attemptId ? { attemptId: status.attemptId } : {}),
      });
      if (generation.current === current) {
        ownedAttempt.current = undefined;
        publish(value);
      }
    } catch {
      if (generation.current === current) publish(failed);
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };
  const check = async () => {
    if (!runtime || !machineId || !requesterUserId) return;
    const current = generation.current;
    setBusy(true);
    try {
      await runtime
        .requestLocalMcpTools(machineId, currentServer.current, requesterUserId)
        .catch(() => undefined);
      const value = await runtime.requestLocalMcpAuthentication(machineId, {
        requesterUserId: requesterUserId ?? '',
        action: 'status',
        server: currentServer.current,
      });
      if (generation.current === current) publish(value);
    } catch {
      if (generation.current === current) publish(failed);
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };
  return (
    <McpAuthenticationView
      status={status}
      disabled={disabled}
      available={Boolean(runtime && machineId && requesterUserId)}
      busy={busy}
      httpControls={httpControls}
      client={{ id: clientId, secret: clientSecret }}
      onClientChange={(value) => {
        setClientId(value.id);
        setClientSecret(value.secret);
      }}
      onAction={(action) => {
        if (action === 'authorize') void authorize();
        else if (action === 'check') void check();
        else void act(action);
      }}
    />
  );
}

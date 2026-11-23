import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createConnection } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

export async function createCodexExternalFixture(root, { autoApprove = false } = {}) {
  mkdirSync(root, { recursive: true });
  const caFile = `${root}/ca.pem`;
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${root}/ca-key.pem`,
      '-out',
      caFile,
      '-days',
      '1',
      '-subj',
      '/CN=Lody isolated acceptance CA',
    ],
    { stdio: 'ignore' }
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${root}/server-key.pem`,
      '-out',
      `${root}/server.csr`,
      '-subj',
      '/CN=auth.openai.com',
    ],
    { stdio: 'ignore' }
  );
  writeFileSync(
    `${root}/extensions.cnf`,
    'subjectAltName=DNS:auth.openai.com,DNS:chatgpt.com,DNS:api.openai.com\nbasicConstraints=CA:FALSE\n'
  );
  execFileSync(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      `${root}/server.csr`,
      '-CA',
      caFile,
      '-CAkey',
      `${root}/ca-key.pem`,
      '-CAcreateserial',
      '-out',
      `${root}/server.pem`,
      '-days',
      '1',
      '-extfile',
      `${root}/extensions.cnf`,
    ],
    { stdio: 'ignore' }
  );
  const modelCatalog = {
    models: [
      {
        slug: 'gpt-5.4',
        display_name: 'Synthetic GPT-5.4',
        description: 'Isolated acceptance model',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [{ effort: 'medium', description: 'Synthetic' }],
        shell_type: 'unified_exec',
        visibility: 'list',
        supported_in_api: true,
        priority: 0,
        base_instructions: 'Reply to the synthetic acceptance prompt.',
        model_messages: null,
        supports_reasoning_summaries: true,
        support_verbosity: true,
        default_verbosity: 'low',
        apply_patch_tool_type: 'freeform',
        truncation_policy: { mode: 'tokens', limit: 10000 },
        supports_parallel_tool_calls: true,
        context_window: 272000,
        input_modalities: ['text'],
        experimental_supported_tools: [],
        prefer_websockets: true,
        available_in_plans: ['plus'],
      },
    ],
  };
  const events = [];
  const logins = new Map();
  const tokens = new Map();
  const sockets = new Set();
  let responseBarrier;
  const waitForResponseBarrier = async (account, body) => {
    const barrier = responseBarrier;
    const marker =
      barrier?.account === account && barrier.markers.find((item) => body.includes(item));
    if (!marker) return;
    barrier.arrived.add(marker);
    events.push({ barrier: 'arrived', account, marker });
    await barrier.released;
    events.push({ barrier: 'released', account, marker });
  };
  const jwt = (claims) =>
    `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`;
  const handler = async (request, response) => {
    try {
      const url = new URL(request.url, `https://${request.headers.host}`);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bodyText = Buffer.concat(chunks).toString();
      const account = tokens.get((request.headers.authorization ?? '').replace(/^Bearer /, ''));
      events.push({ path: url.pathname, account, method: request.method });
      const json = (value) =>
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (url.pathname === '/api/accounts/deviceauth/usercode') {
        const id = `synthetic-account-${logins.size + 1}`;
        let approve;
        const approved = new Promise((resolve) => {
          approve = resolve;
        });
        const code = `LODY-${String(logins.size + 1).padStart(4, '0')}`;
        logins.set(id, { id, code, approved, approve });
        if (autoApprove) approve();
        json({ device_auth_id: id, user_code: code, interval: '0' });
      } else if (url.pathname === '/api/accounts/deviceauth/token') {
        const input = JSON.parse(bodyText);
        const login = logins.get(input.device_auth_id);
        if (!login) {
          response.writeHead(400).end();
          return;
        }
        await login.approved;
        json({
          authorization_code: login.id,
          code_challenge: 'synthetic-challenge',
          code_verifier: 'synthetic-verifier',
        });
      } else if (url.pathname === '/oauth/token') {
        const input = new URLSearchParams(bodyText);
        const id = input.get('code');
        if (!logins.has(id)) {
          response.writeHead(400).end();
          return;
        }
        const authClaims = {
          chatgpt_account_id: id,
          chatgpt_user_id: `user-${id}`,
          chatgpt_plan_type: 'plus',
        };
        const claims = {
          sub: `user-${id}`,
          email: `${id}@example.invalid`,
          exp: Math.floor(Date.now() / 1000) + 3600,
          'https://api.openai.com/auth': authClaims,
        };
        const access = jwt(claims);
        tokens.set(access, id);
        json({
          id_token: jwt(claims),
          access_token: access,
          refresh_token: `synthetic-refresh-${id}`,
        });
      } else if (url.pathname === '/oauth/revoke') {
        json({});
      } else if (url.pathname.endsWith('/accounts/check')) {
        if (!account) {
          response.writeHead(401).end();
          return;
        }
        json({
          accounts: [
            {
              id: account,
              plan_type: 'plus',
              workspace_backend_origin: 'https://chatgpt.com',
              account_routing_override: 'NO_CONSTRAINT',
            },
          ],
          account_ordering: [account],
          default_account_id: account,
        });
      } else if (url.pathname.endsWith('/models')) {
        json(modelCatalog);
      } else if (url.pathname.endsWith('/wham/usage')) {
        json({
          plan_type: 'plus',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 0,
              reset_after_seconds: 3600,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
              limit_window_seconds: 18000,
            },
          },
        });
      } else if (url.pathname.endsWith('/responses')) {
        if (!account) {
          response.writeHead(401).end();
          return;
        }
        await waitForResponseBarrier(account, bodyText);
        const text = `Verified isolated ChatGPT ${account}.`;
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
        });
        for (const event of [
          {
            type: 'response.created',
            response: { id: `response-${account}`, status: 'in_progress', output: [] },
          },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'message-fixture',
              type: 'message',
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          },
          {
            type: 'response.output_text.delta',
            item_id: 'message-fixture',
            output_index: 0,
            content_index: 0,
            delta: text,
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'message-fixture',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text, annotations: [] }],
            },
          },
          {
            type: 'response.completed',
            response: {
              id: `response-${account}`,
              status: 'completed',
              output: [],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ])
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
      } else {
        response
          .writeHead(404, { 'content-type': 'application/json' })
          .end('{"error":"Not in the synthetic fixture"}');
      }
    } catch {
      response.writeHead(500).end();
    }
  };
  const secure = createHttpsServer(
    { key: readFileSync(`${root}/server-key.pem`), cert: readFileSync(`${root}/server.pem`) },
    (request, response) => {
      void handler(request, response);
    }
  );
  const websocket = new WebSocketServer({ noServer: true });
  secure.on('upgrade', (request, socket, head) => {
    const account = tokens.get((request.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!account || !request.url.startsWith('/backend-api/codex/responses')) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    websocket.handleUpgrade(request, socket, head, (connection) => {
      connection.on('message', (data) => {
        void (async () => {
          events.push({ path: '/backend-api/codex/responses', account, method: 'WEBSOCKET' });
          await waitForResponseBarrier(account, data.toString());
          const text = `Verified isolated ChatGPT ${account}.`;
          const item = {
            id: 'message-fixture',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          };
          for (const event of [
            {
              type: 'response.created',
              response: { id: `response-${account}`, status: 'in_progress', output: [] },
            },
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { ...item, status: 'in_progress', content: [] },
            },
            {
              type: 'response.output_text.delta',
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: text,
            },
            { type: 'response.output_item.done', output_index: 0, item },
            {
              type: 'response.completed',
              response: {
                id: `response-${account}`,
                status: 'completed',
                output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ])
            connection.send(JSON.stringify(event));
        })().catch(() => connection.close(1011));
      });
    });
  });
  secure.listen(0, '127.0.0.1');
  await once(secure, 'listening');
  const proxy = createServer((_request, response) => response.writeHead(403).end());
  proxy.on('connect', (request, client, head) => {
    if (!/^(auth\.openai\.com|chatgpt\.com|api\.openai\.com):443$/.test(request.url)) {
      events.push({ blockedConnect: request.url });
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const target = createConnection({ host: '127.0.0.1', port: secure.address().port }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      client.pipe(target).pipe(client);
    });
    sockets.add(client);
    sockets.add(target);
    client.on('close', () => {
      sockets.delete(client);
      target.destroy();
    });
    target.on('close', () => {
      sockets.delete(target);
      client.destroy();
    });
    client.on('error', () => target.destroy());
    target.on('error', () => client.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  return {
    events,
    holdResponses(account, markers) {
      if (responseBarrier) throw new Error('A synthetic response barrier is already active');
      let release;
      const released = new Promise((resolve) => {
        release = resolve;
      });
      const barrier = { account, markers, arrived: new Set(), released };
      responseBarrier = barrier;
      return {
        get arrived() {
          return [...barrier.arrived];
        },
        release() {
          if (barrier.arrived.size !== markers.length)
            throw new Error('Both synthetic requests must arrive before release');
          responseBarrier = undefined;
          release();
        },
      };
    },
    caFile,
    env: {
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      http_proxy: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      SSL_CERT_FILE: caFile,
      CODEX_CA_CERTIFICATE: caFile,
    },
    approve(code) {
      const login = [...logins.values()].find((item) => item.code === code);
      if (!login) throw new Error(`No synthetic device login ${code}`);
      login.approve();
    },
    async close() {
      for (const client of websocket.clients) client.terminate();
      websocket.close();
      for (const socket of sockets) socket.destroy();
      secure.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => proxy.close(resolve)),
        new Promise((resolve) => secure.close(resolve)),
      ]);
    },
  };
}

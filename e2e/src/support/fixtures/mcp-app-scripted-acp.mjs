import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const eventLogPath = process.argv[2];
const sessions = new Map();
const TOOL_CALL_ID = 'mcp-app-call-1';
const RESOURCE_URI = 'ui://synthetic/board.html';
const MCP_APP = {
  version: 1,
  server: 'synthetic',
  tool: 'show_board',
  resourceUri: RESOURCE_URI,
  appName: 'Synthetic Board',
};

const APP_HTML = `<!doctype html>
<html><body>
<p id="result">Loading</p><p id="mode"></p><p id="storage"></p><button id="add">Add card</button>
<script>
const pending = new Set();
let nextId = 2;
const send = (message) => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
const STORAGE_KEY = 'lody-e2e-storage-probe';
const attempt = (action) => {
  try {
    return action();
  } catch (error) {
    return String(error?.name ?? error) + ': ' + String(error?.message ?? '');
  }
};
const probeStorage = () => {
  const marker = 'lody-mcp-app-probe-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const before = attempt(() => localStorage.getItem(STORAGE_KEY));
  const roundTrip = (store) => attempt(() => {
    store().setItem(STORAGE_KEY, marker);
    return store().getItem(STORAGE_KEY) === marker ? 'ok' : 'read back a different value';
  });
  const probe = {
    origin: self.origin,
    storage: roundTrip(() => localStorage),
    session: roundTrip(() => sessionStorage),
    cookie: attempt(() => {
      document.cookie = STORAGE_KEY + '=' + marker + '; Path=/';
      return document.cookie.split('; ').includes(STORAGE_KEY + '=' + marker) ? 'ok' : 'read back ' + document.cookie;
    }),
    before,
    marker,
  };
  document.getElementById('storage').textContent = JSON.stringify(probe);
};
const show = (result) => {
  document.getElementById('result').textContent =
    (result?.content ?? []).find((item) => item?.type === 'text')?.text ?? '';
};
const reportSize = () => {
  const { scrollWidth: width, scrollHeight: height } = document.documentElement;
  send({ method: 'ui/notifications/size-changed', params: { width, height } });
};
window.addEventListener('message', ({ source, data }) => {
  if (source !== window.parent || data?.jsonrpc !== '2.0') return;
  if (data.id === 1 && data.result) {
    document.getElementById('mode').textContent = data.result.hostContext?.displayMode ?? '';
    probeStorage();
    send({ method: 'ui/notifications/initialized', params: {} });
  } else if (data.method === 'ui/notifications/tool-result') show(data.params);
  else if (pending.delete(data.id)) show(data.result);
  else return;
  reportSize();
});
document.getElementById('add').addEventListener('click', () => {
  pending.add(nextId);
  send({ id: nextId++, method: 'tools/call', params: { name: 'add_card', arguments: {} } });
});
send({ id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26',
  appInfo: { name: 'synthetic-board', version: '1' }, appCapabilities: {} } });
</script>
</body></html>`;

function record(event, details = {}) {
  appendFileSync(
    eventLogPath,
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details })}\n`,
    'utf8'
  );
}

const boardResult = (cards) => ({
  content: [{ type: 'text', text: `Synthetic board has ${cards} cards` }],
  structuredContent: { cards },
});

const update = (client, sessionId, sessionUpdate) =>
  client.notify(acp.methods.client.session.update, { sessionId, update: sessionUpdate });

function parseTarget(params, extra = () => true) {
  if (params?.toolCallId !== TOOL_CALL_ID || !sessions.get(params.sessionId)?.opened) {
    throw new Error('Unknown synthetic MCP App tool call');
  }
  if (!extra(params)) throw new Error('Invalid synthetic MCP App request');
  return params;
}

const agent = acp
  .agent({ name: 'lody-mcp-app-e2e-agent' })
  .onRequest(acp.methods.agent.initialize, async ({ params }) => {
    record('initialize', {
      clientMcpApps: params.clientCapabilities?._meta?.lody?.mcpApps ?? null,
    });
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { _meta: { lody: { mcpApps: { version: 1 } } } },
      agentInfo: { name: 'Lody MCP App E2E Agent', version: '1' },
    };
  })
  .onRequest(acp.methods.agent.session.new, async () => {
    const sessionId = `mcp-app-${randomUUID()}`;
    sessions.set(sessionId, { opened: false, cards: 3 });
    record('session-new', { sessionId });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown MCP App session: ${params.sessionId}`);
    const text = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    const mode = text.includes('You generate titles for coding sessions.')
      ? 'title'
      : text.includes('[LODY-MCPAPP-001]')
        ? 'mcp-app'
        : 'other';
    record('prompt-start', { sessionId: params.sessionId, mode });
    let reply = mode === 'title' ? 'Synthetic board session' : 'Synthetic response complete.';
    if (mode === 'mcp-app') {
      await update(client, params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: TOOL_CALL_ID,
        title: 'mcp.synthetic.show_board',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { server: 'synthetic', tool: 'show_board', arguments: { board: 'release' } },
        _meta: { is_mcp_tool_call: true, lody: { mcpApp: MCP_APP } },
      });
      session.opened = true;
      await update(client, params.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: TOOL_CALL_ID,
        status: 'completed',
        rawOutput: { content: boardResult(3).content },
      });
      reply = 'Synthetic board opened.';
    }
    await update(client, params.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: reply },
    });
    record('prompt-end', { sessionId: params.sessionId, mode, stopReason: 'end_turn' });
    return { stopReason: 'end_turn' };
  })
  .onRequest('_lody/mcp_apps/load', parseTarget, async ({ params }) => {
    record('mcp-app-load', { sessionId: params.sessionId, toolCallId: params.toolCallId });
    return { app: MCP_APP, toolInput: { board: 'release' }, toolResult: boardResult(3) };
  })
  .onRequest(
    '_lody/mcp_apps/resource/read',
    (params) => parseTarget(params, ({ uri }) => uri === RESOURCE_URI),
    async ({ params }) => {
      record('mcp-app-resource-read', { sessionId: params.sessionId, uri: params.uri });
      return {
        contents: [{ uri: params.uri, mimeType: 'text/html;profile=mcp-app', text: APP_HTML }],
      };
    }
  )
  .onRequest(
    '_lody/mcp_apps/tool/call',
    (params) =>
      parseTarget(
        params,
        ({ name, arguments: args }) =>
          name === 'add_card' && (args === undefined || (typeof args === 'object' && args !== null))
      ),
    async ({ params }) => {
      const session = sessions.get(params.sessionId);
      session.cards += 1;
      record('mcp-app-tool-call', {
        sessionId: params.sessionId,
        name: params.name,
        arguments: params.arguments ?? null,
        cards: session.cards,
      });
      return boardResult(session.cards);
    }
  );

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
record('process-start');
agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));

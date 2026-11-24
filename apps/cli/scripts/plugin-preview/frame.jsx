import * as React from 'react';
import { createRoot } from 'react-dom/client';
import * as jsx from 'react/jsx-runtime';
import * as zod from 'zod';
import * as sdk from '@lody/plugin-sdk';
import * as client from '@lody/plugin-sdk/client';
import * as manifestApi from '@lody/plugin-sdk/manifest';
import * as ui from '@lody/ui';
import {
  createTranscriptSurfaces,
  TranscriptTool,
  TranscriptMarkdown,
} from '../../../../packages/components/src/plugins/transcript-surfaces';
import { createPluginAssets } from '../../../../packages/components/src/plugins/assets';
const data = JSON.parse(document.querySelector('#fixture').textContent);
const { manifest, files, platform } = data;
const bytes = (p) => Uint8Array.from(atob(files[p]), (c) => c.charCodeAt(0));
const controller = new AbortController();
const assets = createPluginAssets(manifest.assets ?? [], bytes, controller.signal);
const session = { workspaceId: 'preview', machineId: 'preview', sessionId: 'sample' };
const summary = {
  session,
  title: 'Synthetic test session',
  status: 'waiting',
  machinePresence: 'online',
  isMine: true,
  userId: 'preview',
  createdAt: 0,
  updatedAt: 0,
  archived: false,
};
const config = Object.fromEntries(
  Object.entries(manifest.config ?? {})
    .filter(([, v]) => v.type !== 'secret')
    .map(([k, v]) => [k, v.default])
);
const compact = platform === 'mobile';
const events = new EventTarget();
const caps = {
  platform,
  formFactor: compact ? 'compact' : 'wide',
  containers: {
    sidebarViews: !compact,
    screens: !compact,
    sessionPanels: !compact,
    projectPages: !compact,
  },
};
const unavailable = () => ({ status: 'unavailable', reason: 'machine_offline', refresh: () => {} });
const unsupported = async () => {
  throw Error('Not available in a synthetic preview');
};
const query = (_target, q) =>
  q.id === 'sessions'
    ? { status: 'ready', data: { items: [summary] }, refresh: () => {} }
    : unavailable();
const mutation = () => ({ pending: false, mutate: unsupported });
const bindings = {
  SidebarRow: ({ label, trailing, onClick }) => (
    <button onClick={onClick}>
      {label}
      {trailing}
    </button>
  ),
  SessionRow: ({ session, onClick }) => <button onClick={onClick}>{session.title}</button>,
  useHostCapabilities: () => caps,
  usePluginConfig: () => ({
    values: config,
    set: async (k, v) => {
      config[k] = v;
    },
  }),
  useLodyQuery: query,
  useQuery: unavailable,
  useUnstableLodySnapshot: unavailable,
  useLodyCommand: mutation,
  useMutation: mutation,
  useLody: () => ({
    assets,
    drafts: { append: () => {} },
    read: async (t, q) => query(t, q).data ?? unsupported(),
    execute: unsupported,
  }),
};
const entry = {
  workspaceId: 'preview',
  pluginId: manifest.id,
  dev: { machineId: 'preview' },
  digest: 'fixture',
};
const surfaces = [];
const add = { add: (spec) => surfaces.push(spec) };
const row = [];
const style = (css) => {
  const el = document.createElement('style');
  el.textContent = css;
  document.head.append(el);
};
const registry = {
  ...createTranscriptSurfaces(entry, controller.signal, bindings),
  signal: controller.signal,
  assets,
  config: { get: () => config },
  events: {
    on: (k, h) => {
      const f = (e) => h(e.detail);
      events.addEventListener(k, f);
      return () => events.removeEventListener(k, f);
    },
  },
  styles: { add: (s) => style(s.css) },
  screens: add,
  session: { panels: add },
  project: { pages: add },
  settings: { pages: add },
  composer: { actions: add, attachments: { add: () => {} } },
  sidebar: {
    sessionRow: { decorate: (s) => row.push(s) },
    headerItems: add,
    footerItems: add,
    views: add,
  },
  themes: { add: () => {} },
};
const mods = {
  react: React,
  'react/jsx-runtime': jsx,
  zod,
  '@lody/ui': ui,
  '@lody/plugin-sdk': sdk,
  '@lody/plugin-sdk/client': client,
  '@lody/plugin-sdk/manifest': manifestApi,
};
const imports = {};
globalThis.previewModules = mods;
for (const [name, ns] of Object.entries(mods)) {
  const code = Object.keys(ns)
    .map(
      (key, i) =>
        `const m${i}=globalThis.previewModules[${JSON.stringify(name)}][${JSON.stringify(key)}];export {m${i} as ${JSON.stringify(key)}};`
    )
    .join('\n');
  imports[name] = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
}
const map = document.createElement('script');
map.nonce = document.currentScript.nonce;
map.type = 'importmap';
map.textContent = JSON.stringify({ imports });
document.head.append(map);
function App() {
  const [command, setCommand] = React.useState('node --test');
  const [language, setLanguage] = React.useState('plugin-note');
  const [text, setText] = React.useState('Synthetic message');
  const [tool, setTool] = React.useState('shell');
  const [output, setOutput] = React.useState('Tests passed');
  const [kind, setKind] = React.useState('execute');
  const [server, setServer] = React.useState('');
  const [status, setStatus] = React.useState('completed');
  const call = {
    mcpServer: server,
    toolCallId: 'fixture-tool',
    toolName: tool,
    acpKind: kind,
    command,
    title: command,
    status,
    locations: [],
    rawInput: { command },
    rawOutput: output,
    outputText: output,
  };
  return (
    <client.ClientHostProvider value={bindings}>
      <h2>Session</h2>
      {summary.title}
      {row.map(({ id, trailing: C }) => C && <C key={id} session={summary} />)}
      <h2>Tool call</h2>
      <label>
        Tool name <input value={tool} onChange={(e) => setTool(e.target.value)} />
      </label>
      <label>
        ACP kind <input value={kind} onChange={(e) => setKind(e.target.value)} />
      </label>
      <label>
        MCP server <input value={server} onChange={(e) => setServer(e.target.value)} />
      </label>
      <label>
        Status{' '}
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {['running', 'completed', 'failed', 'cancelled'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label>
        Command <input value={command} onChange={(e) => setCommand(e.target.value)} />
      </label>
      <label>
        Output <input value={output} onChange={(e) => setOutput(e.target.value)} />
      </label>
      <TranscriptTool target={{ session }} call={call} raw={<pre>{output}</pre>} />
      <h2>Message block</h2>
      <label>
        Fence language <input value={language} onChange={(e) => setLanguage(e.target.value)} />
      </label>
      <label>
        Body <textarea value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <TranscriptMarkdown
        target={{ session }}
        text={'```' + language + '\n' + text + '\n```'}
        turnId="preview"
        ordinal={0}
        streaming={false}
        render={(raw) => <pre>{raw}</pre>}
      />
      <button
        onClick={() =>
          events.dispatchEvent(new CustomEvent('ui.message.submitted', { detail: { session } }))
        }
      >
        Emit message submitted
      </button>
      {!compact &&
        surfaces.map(
          ({ id, title, Component: C }) =>
            C && (
              <section key={id}>
                <h2>{title ?? id}</h2>
                <C workspace={{ workspaceId: 'preview' }} session={session} sessions={[summary]} />
              </section>
            )
        )}
    </client.ClientHostProvider>
  );
}
async function start() {
  for (const p of manifest.styles ?? []) style(new TextDecoder().decode(bytes(p)));
  if (manifest.client) {
    const url = URL.createObjectURL(
      new Blob([bytes(manifest.client)], { type: 'text/javascript' })
    );
    const { default: plugin } = await import(/* @vite-ignore */ url);
    if (plugin?.kind !== 'client-plugin') throw Error('Expected client plugin');
    await plugin.register(registry);
  }
  createRoot(document.querySelector('main')).render(<App />);
}
start().catch((e) => (document.querySelector('main').textContent = String(e)));

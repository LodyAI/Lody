import type { SessionRef, ObservedToolCall } from '@lody/plugin-sdk';
import { clientDiagnostics } from './client-diagnostics';
import { Fragment, useEffect, useSyncExternalStore, useState, type ReactNode } from 'react';
import {
  ClientHostProvider,
  type ClientHostBindings,
  type ClientPluginRegistry,
  type MessageBlockRenderProps,
  type MatchedToolRenderProps,
} from '@lody/plugin-sdk/client';
import type { SurfaceFactory } from './workspace-plugin-registry';
import { SurfaceErrorBoundary } from './surface-error-boundary';

type Scope = Parameters<SurfaceFactory>[0];
type Slot = { entry: Scope; id: string; priority: number; bindings: ClientHostBindings } & (
  | { kind: 'block'; spec: Parameters<ClientPluginRegistry['messages']['renderBlock']>[0] }
  | { kind: 'match'; spec: Parameters<ClientPluginRegistry['tools']['matchRender']>[0] }
  | { kind: 'own'; render: (props: MatchedToolRenderProps) => ReactNode }
);
let slots: Slot[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const snapshot = () => slots;
export function useTranscriptSlots() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export function createTranscriptSurfaces(
  entry: Scope,
  signal: AbortSignal,
  bindings: ClientHostBindings
): { tools: ClientPluginRegistry['tools']; messages: Pick<ClientPluginRegistry['messages'], 'renderBlock'> } {
  const owned = new Set<Slot>();
  const add = (slot: Slot) => {
    signal.throwIfAborted();
    owned.add(slot);
    slots = [...slots, slot].sort(
      (a, b) =>
        b.priority - a.priority ||
        (a.entry.pluginId < b.entry.pluginId
          ? -1
          : a.entry.pluginId > b.entry.pluginId
            ? 1
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0)
    );
    notify();
  };
  signal.addEventListener(
    'abort',
    () => {
      slots = slots.filter((s) => !owned.has(s));
      owned.clear();
      notify();
    },
    { once: true }
  );
  return {
    tools: {
      render(tool, C) {
        add({
          entry,
          bindings,
          id: tool.id,
          priority: Infinity,
          kind: 'own',
          render(p) {
            const input = tool.input.safeParse(p.call.rawInput);
            if (!input.success) {
              clientDiagnostics.report(entry, 'invalid_tool_input', tool.id);
              return null;
            }
            const props = { ...p, input: input.data, toolCallId: p.call.toolCallId };
            if (p.call.status === 'running') return <C {...props} status="running" />;
            if (p.call.status !== 'completed') return null;
            const output = tool.output.safeParse(p.call.rawOutput);
            if (!output.success) clientDiagnostics.report(entry, 'invalid_tool_output', tool.id);
            return p.call.status === 'completed' && output.success ? (
              <C {...props} status="completed" output={output.data} />
            ) : null;
          },
        });
      },
      matchRender(spec) {
        add({ entry, bindings, kind: 'match', id: spec.id, priority: spec.priority ?? 0, spec });
      },
    },
    messages: {
      renderBlock(spec) {
        add({ entry, bindings, kind: 'block', id: spec.id, priority: spec.priority ?? 0, spec });
      },
    },
  };
}
export function TranscriptSurface({
  slot,
  raw,
  label,
  children,
}: {
  slot: Slot;
  raw: ReactNode;
  label: string;
  children: ReactNode;
}) {
  const [show, set] = useState(false);
  return (
    <>
      <button type="button" onClick={() => set(!show)}>
        {show ? 'View rendered' : label}
      </button>
      {show ? (
        raw
      ) : (
        <SurfaceErrorBoundary
          fallback={raw}
          onCrash={(stack) => clientDiagnostics.report(slot.entry, 'surface_render_crashed', stack)}
        >
          <ClientHostProvider value={slot.bindings}>{children}</ClientHostProvider>
        </SurfaceErrorBoundary>
      )}
    </>
  );
}
export function fences(text: string) {
  const parts: {
    start: number;
    end: number;
    code: string;
    language: string;
    meta?: string;
    open: boolean;
  }[] = [];
  const lines = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n?/gm;
  let m;
  while ((m = lines.exec(text))) {
    const start = m.index,
      body = lines.lastIndex;
    const close = new RegExp(`^ {0,3}${m[1][0]}{${m[1].length},}[ \\t]*\\r?$`, 'gm');
    close.lastIndex = body;
    const end = close.exec(text);
    const [language, ...meta] = m[2].trim().split(/\s+/);
    parts.push({
      start,
      end: end ? close.lastIndex : text.length,
      language: language ?? '',
      meta: meta.join(' ') || undefined,
      code: text.slice(body, end?.index ?? text.length),
      open: !end,
    });
    if (!end) break;
    lines.lastIndex = close.lastIndex;
  }
  return parts;
}
type Target = { session: SessionRef; project?: MessageBlockRenderProps['project'] };
function BlockContent({
  slot,
  props,
}: {
  slot: Extract<Slot, { kind: 'block' }>;
  props: Omit<MessageBlockRenderProps, 'appendToDraft'>;
}) {
  const nav = slot.bindings.useLody().drafts;
  const C = slot.spec.Component;
  return <C {...props} appendToDraft={(item) => nav.append(props.session, item)} />;
}
export function TranscriptMarkdown({
  target,
  text,
  turnId,
  ordinal,
  streaming,
  render,
}: {
  target?: Target;
  text: string;
  turnId: string;
  ordinal: number;
  streaming: boolean;
  render: (text: string, prose: boolean) => ReactNode;
}) {
  const available = useTranscriptSlots().filter(
    (s) => s.kind === 'block' && s.entry.workspaceId === target?.session.workspaceId
  );
  if (!target || !available.length) return render(text, true);
  let last = 0;
  const nodes: ReactNode[] = [];
  for (const f of fences(text)) {
    const blockId = `${turnId}:block:${ordinal++}`;
    const slot = available.find((s) => s.kind === 'block' && s.spec.languages.includes(f.language));
    if (slot?.kind !== 'block') continue;
    if (f.start > last)
      nodes.push(
        <Fragment key={'before:' + blockId}>{render(text.slice(last, f.start), true)}</Fragment>
      );
    last = f.end;
    nodes.push(
      <TranscriptSurface
        key={JSON.stringify([
          target.session.sessionId,
          blockId,
          slot.entry.pluginId,
          slot.id,
          slot.entry.digest,
        ])}
        slot={slot}
        raw={<pre>{text.slice(f.start, f.end)}</pre>}
        label="View Raw Markdown"
      >
        <BlockContent
          slot={slot}
          props={{
            ...target,
            turnId,
            blockId,
            code: f.code,
            language: f.language,
            meta: f.meta,
            streaming: streaming && f.open,
          }}
        />
      </TranscriptSurface>
    );
  }
  if (!nodes.length) return render(text, true);
  if (last < text.length)
    nodes.push(<Fragment key="tail">{render(text.slice(last), true)}</Fragment>);
  return nodes;
}
function ToolContent({
  slot,
  target,
  call,
  showRaw,
  raw,
}: {
  slot: Slot;
  target: Target;
  call: ObservedToolCall;
  showRaw: () => void;
  raw: ReactNode;
}) {
  const nav = slot.bindings.useLody().drafts;
  const props: MatchedToolRenderProps = {
    ...target,
    call,
    appendToDraft: (item) => nav.append(target.session, item),
    showRawOutput: showRaw,
  };
  if (slot.kind === 'own') return slot.render(props) ?? raw;
  if (slot.kind === 'match') {
    const C = slot.spec.Component;
    return <C {...props} />;
  }
  return raw;
}
export function TranscriptTool({
  target,
  call,
  raw,
}: {
  target?: Target;
  call: ObservedToolCall;
  raw: ReactNode;
}) {
  const slots = useTranscriptSlots();
  const [rawKey, setRaw] = useState('');
  const matches = slots.filter((s) => {
    if (!target) return false;
    if (
      s.entry.workspaceId !== target.session.workspaceId ||
      (s.kind === 'own' && s.entry.dev.machineId !== target.session.machineId)
    )
      return false;
    if (s.kind === 'own') return call.toolName === `plugin__${s.entry.pluginId}__${s.id}`;
    if (s.kind !== 'match') return false;
    const m = s.spec.match;
    try {
      return (
        (!m.toolNames || m.toolNames.includes(call.toolName)) &&
        (!m.mcpServer || m.mcpServer === call.mcpServer) &&
        (!m.acpKinds || m.acpKinds.includes(call.acpKind)) &&
        (!m.commandPattern ||
          (m.commandPattern.length <= 256 &&
            /^\(?[\w ^$.|/-]+\)?$/.test(m.commandPattern) &&
            new RegExp(m.commandPattern).test(call.command?.slice(0, 8192) ?? ''))) &&
        (!m.when || m.when(call))
      );
    } catch {
      return false;
    }
  });
  const replacements = matches.filter(s => s.kind !== 'match' || s.spec.mode !== 'enhance');
  const enhancements = matches.filter(s => s.kind === 'match' && s.spec.mode === 'enhance');
  const slot = replacements[0];
  useEffect(() => {
    if (!slot) return;
    for (const loser of replacements.slice(1)) {
      clientDiagnostics.report(loser.entry, 'matcher_shadowed',
        `${loser.id}: ${slot.entry.pluginId}:${slot.id} priority ${slot.priority}`);
    }
  }, [replacements, slot]);
  if (!target || !matches.length) return raw;
  const key = JSON.stringify([target.session.workspaceId, target.session.sessionId, call.toolCallId]);
  if (rawKey === key) return <><button onClick={() => setRaw('')}>View rendered</button>{raw}</>;
  const content = (item: Slot, fallback: ReactNode) => (
    <SurfaceErrorBoundary
      key={JSON.stringify([key, item.entry.sourceKey, item.entry.pluginId, item.id, item.entry.digest])}
      fallback={fallback}
      onCrash={(stack) => clientDiagnostics.report(item.entry, 'surface_render_crashed', stack)}
    >
      <ClientHostProvider value={item.bindings}>
        <ToolContent slot={item} target={target} call={call} raw={fallback} showRaw={() => setRaw(key)} />
      </ClientHostProvider>
    </SurfaceErrorBoundary>
  );
  return (
    <>
      <button onClick={() => setRaw(key)}>View Raw Output</button>
      {slot ? content(slot, raw) : raw}
      {enhancements.map(item => content(item, null))}
    </>
  );
}

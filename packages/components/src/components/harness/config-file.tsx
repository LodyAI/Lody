/*
 * The harness as a file. Every choice in the UI rewrites a line here, and the
 * line that changed flashes, so the user sees that clicking *is* configuring —
 * and power users see exactly what will land in `~/.lody/harness.toml`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { motion } from 'framer-motion';
import { hx } from './harness.tokens.stylex';

import { CLI, PROVIDERS } from './catalog';
import { CopyIcon, useCopy } from './primitives';
import { parts } from './parts';
import type { HarnessConfig, HarnessState } from './store';
import { fileStyles as s } from './config-file.styles';

type Line = { key: string; text: string; kind?: 'comment' | 'section' | 'blank' };

const str = (v: string) => `"${v}"`;
const list = (v: string[]) => `[${v.map(str).join(', ')}]`;

function toLines(config: HarnessConfig, state: HarnessState, device: string | null): Line[] {
  const providers = PROVIDERS.filter((p) => state.credentials[p.id]).map((p) => p.id);
  const deviceName = state.devices.find((d) => d.id === device)?.name;
  return [
    {
      key: 'c0',
      text: `# ${deviceName ? `effective on ${deviceName}` : 'profile · all devices'}`,
      kind: 'comment',
    },
    { key: 'b0', text: '', kind: 'blank' },
    { key: 's1', text: '[providers]', kind: 'section' },
    { key: 'providers', text: `enabled  = ${list(providers)}` },
    { key: 'fallback', text: `fallback = ${config.fallback && providers.length > 1}` },
    { key: 'b1', text: '', kind: 'blank' },
    { key: 's2', text: '[model]', kind: 'section' },
    { key: 'mainModel', text: `main     = ${str(config.mainModel || 'unset')}` },
    { key: 'subModel', text: `subagent = ${str(config.subModel || 'unset')}` },
    { key: 'effort', text: `effort   = ${str(config.effort)}` },
    { key: 'b2', text: '', kind: 'blank' },
    { key: 's3', text: '[plugins]', kind: 'section' },
    { key: 'plugins', text: `enabled  = ${list(config.plugins)}` },
    { key: 'b3', text: '', kind: 'blank' },
    { key: 's4', text: '[permissions]', kind: 'section' },
    { key: 'autonomy', text: `autonomy = ${str(config.autonomy)}` },
    { key: 'fsScope', text: `files    = ${str(config.fsScope)}` },
    { key: 'network', text: `network  = ${str(config.network)}` },
    { key: 'guarded', text: `ask      = ${list(config.guarded)}` },
  ];
}

export function ConfigFile({
  config,
  state,
  device,
  compact,
}: {
  config: HarnessConfig;
  state: HarnessState;
  device: string | null;
  compact?: boolean;
}) {
  const lines = useMemo(() => toLines(config, state, device), [config, state, device]);
  const previous = useRef<Map<string, string> | null>(null);
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
  const { copied, copy } = useCopy();

  // A line keeps flashing until its animation ends, even across re-renders: the
  // file is a live view of the choices, not a diff to be dismissed.
  useEffect(() => {
    const before = previous.current;
    previous.current = new Map(lines.map((line) => [line.key, line.text]));
    if (!before) return;
    const changed = lines
      .filter((line) => before.get(line.key) !== undefined && before.get(line.key) !== line.text)
      .map((line) => line.key);
    if (!changed.length) return;
    setFlash(new Set(changed));
    const timer = window.setTimeout(() => setFlash(new Set()), 1200);
    return () => window.clearTimeout(timer);
  }, [lines]);

  return (
    <div {...stylex.props(s.file)}>
      <div {...stylex.props(s.bar)}>
        <span {...stylex.props(s.dots)} aria-hidden="true">
          <i {...stylex.props(s.dot)} />
          <i {...stylex.props(s.dot)} />
          <i {...stylex.props(s.dot)} />
        </span>
        <span {...stylex.props(s.name)}>~/.{CLI}/harness.toml</span>
        <button
          type="button"
          {...stylex.props(parts.iconBtn)}
          aria-label="Copy config"
          onClick={() => copy(lines.map((line) => line.text).join('\n'))}
        >
          <CopyIcon copied={copied} />
        </button>
      </div>
      <pre {...stylex.props(s.body)}>
        {lines.map((line, index) => (
          <div key={line.key} {...stylex.props(s.line)}>
            <span {...stylex.props(s.no)}>{index + 1}</span>
            {flash.has(line.key) ? (
              <motion.span
                key={line.text}
                {...stylex.props(s.text)}
                initial={{ backgroundColor: hx.flash }}
                animate={{ backgroundColor: 'rgba(0,0,0,0)' }}
                transition={{ duration: 1.2, ease: 'easeOut' }}
              >
                <Tokens text={line.text} kind={line.kind} />
              </motion.span>
            ) : (
              <span {...stylex.props(s.text, kindStyle(line.kind))}>
                <Tokens text={line.text} kind={line.kind} />
              </span>
            )}
          </div>
        ))}
      </pre>
    </div>
  );
}

function kindStyle(kind: Line['kind']) {
  if (kind === 'comment') return s.textComment;
  if (kind === 'section') return s.textSection;
  return null;
}

/** Minimal TOML colouring: key, equals, strings, booleans. */
function Tokens({ text, kind }: { text: string; kind?: Line['kind'] }) {
  if (kind) return <>{text || ' '}</>;
  const eq = text.indexOf('=');
  const key = text.slice(0, eq);
  const value = text.slice(eq + 1);
  const parts = value.split(/("[^"]*")/g);
  return (
    <>
      <span {...stylex.props(s.tokenKey)}>{key}</span>
      <span {...stylex.props(s.tokenOperator)}>=</span>
      {parts.map((part, i) =>
        part.startsWith('"') ? (
          <span key={i} {...stylex.props(s.tokenString)}>
            {part}
          </span>
        ) : (
          <span key={i} {...stylex.props(/true|false/.test(part) && s.tokenLiteral)}>
            {part}
          </span>
        )
      )}
    </>
  );
}

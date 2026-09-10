import { isShortcutMention } from './shortcut-composer-state';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePromptShortcuts } from '../../providers/prompt-shortcut-provider';
import {
  captureShortcutDraft,
  shortcutDraftKey,
  shortcutDraftRepository,
  type ShortcutDraftRecord,
} from '@/lib/shortcut-composer-draft';
import type { Mention } from '@/ui/mention/index';

/** A recovery checkpoint supplements the existing text/range owners, never replaces their handoff. */
export function useShortcutComposerDraft(input: {
  enabled: boolean;
  suspended?: boolean;
  composerId: string;
  text: string;
  mentions: Mention[];
  restore: (record: ShortcutDraftRecord) => void;
}) {
  const { runtime } = usePromptShortcuts();
  const identity = useMemo(
    () =>
      input.enabled && runtime
        ? { userId: runtime.userId, workspaceId: runtime.workspaceId, composerId: input.composerId }
        : null,
    [input.enabled, input.composerId, runtime]
  );
  const key = identity ? shortcutDraftKey(identity) : null;
  const generation = useRef(0);
  const domain = identity ? JSON.stringify([identity.userId, identity.workspaceId]) : null;
  const previousDomain = useRef(domain);
  const previouslyHadShortcut = useRef(false);
  const current = useRef({ key, input });
  current.current = { key, input };
  const request = useRef({ key, token: {} });
  if (request.current.key !== key) request.current = { key, token: {} };
  const token = request.current.token;
  const [ready, setReady] = useState<object | null>(null);
  const [failure, setError] = useState<{ key: string; error: unknown } | null>(null);
  const checkpoint = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (previousDomain.current !== domain && previouslyHadShortcut.current) {
      generation.current += 1;
      current.current.input.restore({ v: 1, text: '', mentions: [], invocations: [] });
    }
    previousDomain.current = domain;
    previouslyHadShortcut.current = input.mentions.some(isShortcutMention);
  }, [domain, input.mentions]);
  const markEdited = useCallback(() => {
    generation.current += 1;
  }, []);
  useEffect(() => {
    if (!identity || !key || input.suspended) return undefined;
    let cancelled = false;
    const started = generation.current;
    void shortcutDraftRepository
      .read(identity)
      .then((record) => {
        if (cancelled || current.current.key !== key || request.current.token !== token) return;
        checkpoint.current = record ? key : null;
        if (
          record &&
          generation.current === started &&
          (!current.current.input.text || current.current.input.text === record.text)
        ) {
          current.current.input.restore(record);
        }
        setReady(token);
      })
      .catch((error: unknown) => {
        if (!cancelled && current.current.key === key && request.current.token === token) {
          setError({ key, error });
          setReady(token);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [identity, key, token, input.suspended]);
  useEffect(() => {
    if (!identity || !key || ready !== token || input.suspended) return;
    const record = captureShortcutDraft(input.text, input.mentions);
    if (!record && checkpoint.current !== key) return;
    checkpoint.current = record ? key : null;
    void shortcutDraftRepository
      .write(identity, record)
      .then(() => {
        setError((previous) => (previous?.key === key ? null : previous));
      })
      .catch((error: unknown) => {
        if (current.current.key === key) setError({ key, error });
      });
  }, [identity, key, token, ready, input.text, input.mentions, input.suspended]);
  return { identityKey: key, markEdited, error: failure?.key === key ? failure.error : null };
}

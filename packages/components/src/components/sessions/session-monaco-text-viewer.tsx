import 'monaco-editor/min/vs/editor/editor.main.css';

import { useEffect, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { fileViewerWordWrapAtom } from '@/atoms/settings';
import { cn } from '@/lib/utils';
import { configureSessionMonacoWorkers } from '@/lib/session-monaco-workers';
import { ensureSessionMonacoLanguages } from '@/lib/session-monaco-languages';
import {
  resolveSessionMonacoThemeName,
  type SessionMonacoResolvedTheme,
  type SessionMonacoSelectedLines,
} from '@/lib/session-monaco-viewer-state';
import {
  getMonacoThemeNameForVSCodeTheme,
  isVSCodeThemeRegisteredForMonaco,
  registerMonacoThemeFromVSCodeTheme,
} from '@/lib/session-monaco-vscode-theme';
import {
  SessionMonacoEditorController,
  type SessionMonacoSelectionRestore,
} from '@/lib/session-monaco-editor-controller';
import type { LodyResolvedVSCodeTheme } from '@/lib/vscode-theme';
import { useKeyScope } from '@/lib/commands';

configureSessionMonacoWorkers();
ensureSessionMonacoLanguages();

export type SessionMonacoExternalTextUpdate = {
  // Monotonic counter; the viewer fires when this changes, even when
  // the incoming text is byte-identical to the previous snapshot.
  readonly seq: number;
  readonly text: string;
  readonly restoreSelection?: SessionMonacoSelectionRestore;
};

export function SessionMonacoTextViewer({
  text,
  language,
  selectedLines,
  resolvedTheme,
  vscodeTheme,
  readOnly = true,
  onContentChange,
  onSelectionChange,
  onGoToDefinition,
  onFindReferences,
  onScrollChange,
  externalTextUpdate,
  onExternalTextUpdateApplied,
  findRequestSeq,
  modelUri,
  className,
}: {
  readonly text: string;
  readonly language: string;
  readonly selectedLines?: SessionMonacoSelectedLines;
  readonly resolvedTheme: SessionMonacoResolvedTheme;
  readonly vscodeTheme?: LodyResolvedVSCodeTheme | null;
  // External text updates from the provider feed. When `seq`
  // increments the viewer applies the snapshot and reports whether
  // Monaco changed or already matched it.
  readonly externalTextUpdate?: SessionMonacoExternalTextUpdate;
  readonly onExternalTextUpdateApplied?: (result: 'applied' | 'no-op') => void;
  // Monotonic counter; when it increments the viewer opens Monaco's find
  // widget. Mirrors the `externalTextUpdate` seq pattern so the parent can
  // trigger an imperative editor action without holding an editor ref.
  readonly findRequestSeq?: number;
  // When true (default) the viewer keeps Monaco's readOnly + domReadOnly
  // protections so it acts as a pure inspection surface. Code Collab
  // surfaces flip this to false only when the live-collaborative source
  // state + a role with write authority both hold.
  readonly readOnly?: boolean;
  // Fires when the user types into an editable Monaco surface. Stays
  // unwired in read-only mode. The callback receives the current full
  // model text — the consumer is responsible for debouncing, persisting,
  // and conflict handling.
  readonly onContentChange?: (text: string) => void;
  // Fires whenever the local selection changes (caret moves or selection
  // range updates). `anchorOffset` is where the selection started (or
  // the caret offset for empty selections); `headOffset` is the active
  // end. `isEmpty` mirrors `selection.isEmpty()`. Callbacks must
  // throttle/debounce before forwarding to network publishes — the viewer
  // emits raw Monaco events.
  readonly onSelectionChange?: (state: {
    readonly anchorOffset: number;
    readonly headOffset: number;
    readonly isEmpty: boolean;
  }) => void;
  // LSP entry points. When set, the viewer registers Monaco editor
  // actions (Cmd-F12 / F12 for definition, Shift-F12 for references)
  // that fire with the LSP-shape position. Callbacks own the RPC call
  // and any result rendering.
  readonly onGoToDefinition?: (position: {
    readonly line: number;
    readonly character: number;
  }) => void;
  readonly onFindReferences?: (position: {
    readonly line: number;
    readonly character: number;
  }) => void;
  readonly onScrollChange?: (state: { readonly scrollTop: number }) => void;
  // Optional Monaco model URI. When provided the viewer creates the
  // model under this URI, which lets Monaco's globally-registered
  // Code Collab definition/reference providers (see
  // `lib/session-monaco-language-providers`) attach via the
  // `code-collab://<fileId>` scheme. Defaults to Monaco's auto-generated
  // URI so non-collab callers (story/diff viewer) keep working unchanged.
  readonly modelUri?: monaco.Uri;
  readonly className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<SessionMonacoEditorController | null>(null);
  useKeyScope('session-monaco-quick-fix', containerRef, { claims: ['$mod+.'] });

  // Line wrap is a global, persisted viewer preference (defaults on). Read it
  // here so every SessionMonacoTextViewer mount — session file viewer, mobile
  // file browser — shares the same wrap state without prop threading.
  const wordWrap = useAtomValue(fileViewerWordWrapAtom);

  // Lazily register / look up the VSCode-derived Monaco theme name. When
  // no VSCode theme is active we fall back to Monaco's built-in vs/vs-dark.
  const activeMonacoThemeName = useMemo(() => {
    if (!vscodeTheme) return null;
    const expectedName = getMonacoThemeNameForVSCodeTheme(vscodeTheme);
    if (isVSCodeThemeRegisteredForMonaco(expectedName)) {
      return expectedName;
    }
    return registerMonacoThemeFromVSCodeTheme(vscodeTheme, expectedName) ?? null;
  }, [vscodeTheme]);

  // Snapshot of "initial mount" prop values. The controller is built
  // exactly once and reads these to set up the editor / model / theme;
  // subsequent prop changes are forwarded through setters in dependent
  // effects below.
  const initialPropsRef = useRef({
    text,
    language,
    theme: resolveSessionMonacoThemeName(resolvedTheme, activeMonacoThemeName),
    readOnly,
    wordWrap,
    modelUri,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const initial = initialPropsRef.current;
    const controller = new SessionMonacoEditorController({
      container,
      initialText: initial.text,
      initialLanguage: initial.language,
      initialTheme: initial.theme,
      initialReadOnly: initial.readOnly,
      initialWordWrap: initial.wordWrap,
      initialModelUri: initial.modelUri,
      callbacks: {
        onContentChange,
        onSelectionChange,
        onGoToDefinition,
        onFindReferences,
        onScrollChange,
      },
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
    // Controller lifecycle binds to mount. The initial-props ref + callback
    // setter effect below handle subsequent prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Forward the latest callbacks into the controller without rebuilding
  // listeners. Monaco listeners bound in the controller's constructor
  // read `this.callbacks` at fire time, so swapping the bundle is enough.
  useEffect(() => {
    controllerRef.current?.setCallbacks({
      onContentChange,
      onSelectionChange,
      onGoToDefinition,
      onFindReferences,
      onScrollChange,
    });
  }, [onContentChange, onSelectionChange, onGoToDefinition, onFindReferences, onScrollChange]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    controller.applyText(text, readOnly);
    controller.setLanguage(language);
  }, [language, readOnly, text]);

  useEffect(() => {
    controllerRef.current?.setTheme(
      resolveSessionMonacoThemeName(resolvedTheme, activeMonacoThemeName)
    );
  }, [resolvedTheme, activeMonacoThemeName]);

  useEffect(() => {
    controllerRef.current?.setReadOnly(readOnly);
  }, [readOnly]);

  useEffect(() => {
    controllerRef.current?.setWordWrap(wordWrap);
  }, [wordWrap]);

  useEffect(() => {
    controllerRef.current?.applySelectedLines(selectedLines);
  }, [selectedLines, text]);

  // Apply external provider text updates. Fires on every `seq` change
  // so byte-identical snapshots can still acknowledge the current
  // editor state.
  const lastAppliedSeqRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!externalTextUpdate) return;
    if (lastAppliedSeqRef.current === externalTextUpdate.seq) return;
    const controller = controllerRef.current;
    if (!controller) return;
    lastAppliedSeqRef.current = externalTextUpdate.seq;
    const result = controller.applyExternalTextUpdate(externalTextUpdate.text, {
      ...(externalTextUpdate.restoreSelection === undefined
        ? {}
        : { restoreSelection: externalTextUpdate.restoreSelection }),
    });
    onExternalTextUpdateApplied?.(result);
  }, [externalTextUpdate, onExternalTextUpdateApplied]);

  // Open Monaco's find widget when `findRequestSeq` increments. Seeded with
  // the initial value so the first effect run (and any remount on file switch)
  // is a no-op and never auto-opens find.
  const lastFindSeqRef = useRef<number | undefined>(findRequestSeq);
  useEffect(() => {
    if (findRequestSeq === undefined) return;
    if (lastFindSeqRef.current === findRequestSeq) return;
    lastFindSeqRef.current = findRequestSeq;
    controllerRef.current?.openFindWidget();
  }, [findRequestSeq]);

  return (
    <div className={cn('h-full min-h-[240px] w-full overflow-hidden', className)}>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

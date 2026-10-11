import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import {
  normalizeSessionMonacoSelectedLines,
  type SessionMonacoSelectedLines,
} from './session-monaco-viewer-state';
import { ensureCodeCollabMonacoLanguageProviders } from './session-monaco-language-providers';

export type SessionMonacoSelectionRestore = {
  readonly anchorOffset: number;
  readonly headOffset: number;
};

// Imperative wrapper around a Monaco editor + model pair for the Code
// Collab session viewer. Concentrates the parts of the lifecycle that
// React's effect model handles awkwardly:
//   - One-time editor/model creation that has to outlive subsequent
//     prop changes.
//   - Subscription cleanup that must run on unmount, not on every dep
//     change.
//   - Shared-model disposal: if a peer viewer already created the
//     `code-collab://<fileId>/<path>` model, we reuse it and must *not* dispose
//     it during teardown.
//
// The React component (`SessionMonacoTextViewer`) constructs one of
// these in a single effect, forwards prop changes through typed
// setters, and disposes on unmount. Keeping the imperative state out
// of React's render path means most prop changes turn into one method
// call instead of a separate ref + effect pair.
export type SessionMonacoEditorCallbacks = {
  readonly onContentChange?: (text: string) => void;
  readonly onSelectionChange?: (state: {
    readonly anchorOffset: number;
    readonly headOffset: number;
    readonly isEmpty: boolean;
  }) => void;
  readonly onGoToDefinition?: (position: {
    readonly line: number;
    readonly character: number;
  }) => void;
  readonly onFindReferences?: (position: {
    readonly line: number;
    readonly character: number;
  }) => void;
  readonly onScrollChange?: (state: { readonly scrollTop: number }) => void;
};

export type SessionMonacoEditorControllerOptions = {
  readonly container: HTMLDivElement;
  readonly initialText: string;
  readonly initialLanguage: string;
  readonly initialTheme: string;
  readonly initialReadOnly: boolean;
  readonly initialWordWrap: boolean;
  readonly initialModelUri?: monaco.Uri;
  readonly callbacks: SessionMonacoEditorCallbacks;
};

export class SessionMonacoEditorController {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly model: monaco.editor.ITextModel;
  private readonly selectedLineDecorations: monaco.editor.IEditorDecorationsCollection;
  private readonly ownsModel: boolean;
  private readonly disposables: monaco.IDisposable[] = [];
  private callbacks: SessionMonacoEditorCallbacks;
  private disposed = false;

  constructor(options: SessionMonacoEditorControllerOptions) {
    this.callbacks = options.callbacks;

    // Register global Code Collab Monaco language providers (no-op
    // after the first call) so models opened under the `code-collab://`
    // scheme see Monaco's built-in Cmd-click / F12 nav.
    ensureCodeCollabMonacoLanguageProviders();

    // `createModel` rejects duplicate URIs. If a peer mount already
    // built a model for our URI, reuse it — and remember not to
    // dispose it during teardown.
    const existingModel = options.initialModelUri
      ? monaco.editor.getModel(options.initialModelUri)
      : null;
    this.ownsModel = !existingModel;
    this.model =
      existingModel ??
      monaco.editor.createModel(
        options.initialText,
        options.initialLanguage,
        options.initialModelUri
      );

    this.editor = monaco.editor.create(options.container, {
      model: this.model,
      theme: options.initialTheme,
      readOnly: options.initialReadOnly,
      domReadOnly: options.initialReadOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      fixedOverflowWidgets: true,
      folding: true,
      fontFamily: 'var(--font-mono)',
      fontLigatures: true,
      fontSize: 12,
      lineDecorationsWidth: 8,
      lineNumbersMinChars: 4,
      overviewRulerLanes: 0,
      renderLineHighlight: 'none',
      renderWhitespace: 'selection',
      // Monaco's built-in occurrence/selection highlights are noisy in the
      // collab viewer: a caret or selection on ":" paints every ":" and looks
      // like collaboration state.
      // Disable Monaco's heuristic "highlight individual characters" overlays.
      // These paint boxes/backgrounds on top of syntax coloring and read like
      // lint errors in the collab file viewer:
      //   - unicodeHighlight boxes ambiguous/non-ASCII chars, e.g. every
      //     full-width CJK punctuation mark (，：。) in non-English files.
      //   - renderControlCharacters boxes control chars.
      //   - matchBrackets / highlightActiveBracketPair box the bracket pair
      //     next to the caret.
      // (occurrencesHighlight, selectionHighlight, renderLineHighlight above
      // are the rest of this family and are likewise off.)
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      unicodeHighlight: {
        ambiguousCharacters: false,
        invisibleCharacters: false,
        nonBasicASCII: false,
      },
      renderControlCharacters: false,
      matchBrackets: 'never',
      guides: { highlightActiveBracketPair: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      wordWrap: options.initialWordWrap ? 'on' : 'off',
      ariaLabel: options.initialReadOnly ? 'Code file preview' : 'Code file editor',
    });

    this.selectedLineDecorations = this.editor.createDecorationsCollection();

    // `onDidChangeContent` fires for both user input and programmatic
    // `model.setValue` (used to apply remote snapshots). The `isFlush`
    // flag distinguishes the two: true => setValue, which we drop so
    // remote sync doesn't echo back into the save path.
    this.disposables.push(
      this.model.onDidChangeContent((event) => {
        if (event.isFlush) return;
        if (event.changes.length === 0) return;
        this.callbacks.onContentChange?.(this.model.getValue());
      })
    );

    // `onDidChangeCursorSelection` fires for caret moves (selection
    // becomes empty) and active selections in a single signal. We
    // emit raw offsets — the consumer throttles before publishing.
    this.disposables.push(
      this.editor.onDidChangeCursorSelection((event) => {
        const selection = event.selection;
        // `getOffsetAt` can throw if the selection references a position
        // outside the current model (model truncation racing the event
        // delivery). Treat that as a no-op — letting it bubble into
        // Monaco's event loop breaks later events.
        let anchorOffset: number;
        let headOffset: number;
        try {
          anchorOffset = this.model.getOffsetAt(selection.getSelectionStart());
          headOffset = this.model.getOffsetAt(selection.getPosition());
        } catch {
          return;
        }
        this.callbacks.onSelectionChange?.({
          anchorOffset,
          headOffset,
          isEmpty: selection.isEmpty(),
        });
      })
    );

    this.disposables.push(
      this.editor.onDidScrollChange((event) => {
        this.callbacks.onScrollChange?.({ scrollTop: event.scrollTop });
      })
    );

    // LSP entry-point editor actions. Cmd-F12 / F12 fires definition;
    // Shift-F12 fires references. Both pass an LSP-shape `{line, character}`
    // (0-indexed) so the consumer can hand off to provider RPC directly.
    // No `!editorReadonly` precondition: read roles are allowed to
    // request LSP RPC by spec, so read-only viewers also surface the
    // actions in the context menu.
    this.disposables.push(
      this.editor.addAction({
        id: 'lody.codeCollab.goToDefinition',
        label: 'Go to Definition (Code Collab)',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F12, monaco.KeyCode.F12],
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.1,
        run: (ed) => {
          const position = ed.getPosition();
          if (!position) return;
          this.callbacks.onGoToDefinition?.({
            line: position.lineNumber - 1,
            character: position.column - 1,
          });
        },
      })
    );
    this.disposables.push(
      this.editor.addAction({
        id: 'lody.codeCollab.findReferences',
        label: 'Find References (Code Collab)',
        keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.2,
        run: (ed) => {
          const position = ed.getPosition();
          if (!position) return;
          this.callbacks.onFindReferences?.({
            line: position.lineNumber - 1,
            character: position.column - 1,
          });
        },
      })
    );
  }

  // Swap the callback bundle. Listeners read `this.callbacks` at fire
  // time, so updates here take effect immediately without re-subscribing.
  setCallbacks(callbacks: SessionMonacoEditorCallbacks): void {
    this.callbacks = callbacks;
  }

  // In editable mode the local model is the source of truth: user
  // edits live there ahead of any snapshot the parent re-renders with.
  // Force-setting from a stale snapshot would clobber local edits and
  // jump the caret. Read-only viewers always trust the incoming text.
  applyText(text: string, readOnly: boolean): void {
    if (readOnly && this.model.getValue() !== text) {
      this.model.setValue(text);
    }
  }

  // External Code Collab snapshots arrive from explicit provider refresh,
  // save, or conflict-resolution flows. Monaco applies them directly
  // because they already represent the provider's latest full text.
  applyExternalTextUpdate(
    text: string,
    options: { readonly restoreSelection?: SessionMonacoSelectionRestore } = {}
  ): 'applied' | 'no-op' {
    const current = this.model.getValue();
    if (current === text) return 'no-op';
    const fallbackSelection = this.readCurrentSelectionOffsets();
    this.model.setValue(text);
    this.restoreSelectionOffsets(options.restoreSelection ?? fallbackSelection);
    return 'applied';
  }

  private readCurrentSelectionOffsets(): SessionMonacoSelectionRestore | undefined {
    const selection = this.editor.getSelection();
    if (!selection) return undefined;
    try {
      return {
        anchorOffset: this.model.getOffsetAt(selection.getSelectionStart()),
        headOffset: this.model.getOffsetAt(selection.getPosition()),
      };
    } catch {
      return undefined;
    }
  }

  private restoreSelectionOffsets(selection: SessionMonacoSelectionRestore | undefined): void {
    if (!selection) return;
    const maxOffset = this.model.getValueLength();
    const anchorPosition = this.model.getPositionAt(
      clampModelOffset(selection.anchorOffset, maxOffset)
    );
    const headPosition = this.model.getPositionAt(
      clampModelOffset(selection.headOffset, maxOffset)
    );
    const nextSelection = new monaco.Selection(
      anchorPosition.lineNumber,
      anchorPosition.column,
      headPosition.lineNumber,
      headPosition.column
    );
    this.editor.setSelection(nextSelection);
    this.editor.revealPositionInCenterIfOutsideViewport(headPosition);
  }

  getModelValue(): string {
    return this.model.getValue();
  }

  // Opens Monaco's built-in find widget (the same action as Cmd/Ctrl-F).
  // Used by the file viewer's top-bar search button so the control is
  // discoverable without relying on the keyboard shortcut.
  openFindWidget(): void {
    if (this.disposed) return;
    this.editor.focus();
    void this.editor.getAction('actions.find')?.run();
  }

  setLanguage(language: string): void {
    // Reapply even when the id is unchanged: an optional contribution may
    // have registered after the model was created with that language id.
    monaco.editor.setModelLanguage(this.model, language);
  }

  setTheme(themeName: string): void {
    monaco.editor.setTheme(themeName);
  }

  setReadOnly(readOnly: boolean): void {
    this.editor.updateOptions({ readOnly, domReadOnly: readOnly });
  }

  setWordWrap(wordWrap: boolean): void {
    this.editor.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' });
  }

  applySelectedLines(selectedLines: SessionMonacoSelectedLines | undefined): void {
    const range = normalizeSessionMonacoSelectedLines(selectedLines, this.model.getLineCount());
    if (!range) {
      this.selectedLineDecorations.set([]);
      return;
    }
    this.selectedLineDecorations.set([
      {
        range: new monaco.Range(
          range.startLineNumber,
          1,
          range.endLineNumber,
          this.model.getLineMaxColumn(range.endLineNumber)
        ),
        options: {
          isWholeLine: true,
          className: 'lody-session-monaco-selected-line',
          marginClassName: 'lody-session-monaco-selected-line-gutter',
        },
      },
    ]);
    this.editor.revealLineInCenter(range.startLineNumber);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.selectedLineDecorations.clear();
    this.editor.dispose();
    // Only dispose the model if we created it. A peer viewer mount may
    // still be holding the shared `code-collab://<fileId>/<path>` model.
    if (this.ownsModel) {
      this.model.dispose();
    }
  }
}

function clampModelOffset(offset: number, maxOffset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(Math.trunc(offset), maxOffset));
}

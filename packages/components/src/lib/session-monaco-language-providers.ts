import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { isRecord } from '@lody/shared';
import { parseCodeCollabLspLocations, type CodeCollabLspLocation } from './code-collab-lsp-result';
import { hasSessionFileLspProvider } from './session-file-provider';
import {
  CODE_COLLAB_MONACO_URI_SCHEME,
  findCodeCollabMonacoModelProvider,
  readFileIdFromCodeCollabMonacoUri,
} from './code-collab-monaco-model-provider';

export {
  buildCodeCollabMonacoUri,
  readFileIdFromCodeCollabMonacoUri,
  registerCodeCollabMonacoModelProvider,
} from './code-collab-monaco-model-provider';

// Helper for parsing the host response: walks `locations` only when
// status is `'ready'`. Everything else (`'unsupported'` / malformed)
// yields an empty list — the Monaco providers degrade silently in
// those cases (the inline `SessionFileLspPanel` is where richer errors
// surface).
function readReadyLocations(raw: unknown): readonly CodeCollabLspLocation[] {
  if (!isRecord(raw)) return [];
  if (raw.status !== 'ready') return [];
  return parseCodeCollabLspLocations(raw.locations);
}

// Converts an LSP-shape range (0-indexed line/character) to a Monaco
// `IRange` (1-indexed line/column with exclusive end column).
function toMonacoRange(range: CodeCollabLspLocation['range']): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

// v1 limitation: cross-file definitions / references are dropped here so
// Monaco's Cmd-click stays inside the open editor. Multi-file navigation
// requires either pre-registering Monaco models for every referenced
// fileId or installing an `IEditorOpenContext` opener that routes to the
// application's tab system — both meaningful design pieces we leave for
// when a concrete use case asks for them.
function filterSameFileLocations(
  locations: readonly CodeCollabLspLocation[],
  currentFileId: string
): readonly CodeCollabLspLocation[] {
  return locations.filter((location) => location.fileId === currentFileId);
}

let registered = false;

export function ensureCodeCollabMonacoLanguageProviders(): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerDefinitionProvider(
    { scheme: CODE_COLLAB_MONACO_URI_SCHEME },
    {
      async provideDefinition(model, position) {
        const modelUri = model.uri.toString();
        const provider = findCodeCollabMonacoModelProvider(modelUri);
        const fileId = readFileIdFromCodeCollabMonacoUri(modelUri);
        if (!hasSessionFileLspProvider(provider) || !fileId) {
          return null;
        }
        try {
          const raw = await provider.requestLspDefinition(fileId, {
            line: position.lineNumber - 1,
            character: position.column - 1,
          });
          const locations = filterSameFileLocations(readReadyLocations(raw), fileId);
          return locations.map((location) => ({
            uri: model.uri,
            range: toMonacoRange(location.range),
          }));
        } catch {
          // LSP failures fall back to "no definition" rather than
          // surfacing a Monaco-level error. The inline LSP panel
          // (`SessionFileLspPanel`) already shows actionable error
          // messages when the user invokes via the editor action; this
          // path is the Cmd-click hover affordance, which is best left
          // silent on the host being offline.
          return null;
        }
      },
    }
  );

  monaco.languages.registerReferenceProvider(
    { scheme: CODE_COLLAB_MONACO_URI_SCHEME },
    {
      async provideReferences(model, position) {
        const modelUri = model.uri.toString();
        const provider = findCodeCollabMonacoModelProvider(modelUri);
        const fileId = readFileIdFromCodeCollabMonacoUri(modelUri);
        if (!hasSessionFileLspProvider(provider) || !fileId) {
          return null;
        }
        try {
          const raw = await provider.requestLspReferences(
            fileId,
            { line: position.lineNumber - 1, character: position.column - 1 },
            { includeDeclaration: true }
          );
          const locations = filterSameFileLocations(readReadyLocations(raw), fileId);
          return locations.map((location) => ({
            uri: model.uri,
            range: toMonacoRange(location.range),
          }));
        } catch {
          return null;
        }
      },
    }
  );
}

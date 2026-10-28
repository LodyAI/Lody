import { atom } from 'jotai';

/**
 * A request to open the multi-repository project editor, from wherever the
 * user asked: Settings › Projects, or a project row's menu in the sidebar.
 * One host (`ProjectEditorHost`) owns the dialog and clears the request.
 *
 * - `create`: a new project. `seedSourceKey` is the source key of the project
 *   it starts from (`local:<machine>:<id>` or `github:<owner/repo>`), which
 *   becomes its first member; `seedName` names it.
 * - `edit`: an existing multi-repository project.
 * - `delete`: confirm and delete one; its conversations keep their snapshot.
 */
export type ProjectEditorRequest =
  | { kind: 'create'; seedSourceKey?: string; seedName?: string }
  | { kind: 'edit'; projectId: string }
  | { kind: 'delete'; projectId: string };

export const projectEditorRequestAtom = atom<ProjectEditorRequest | null>(null);

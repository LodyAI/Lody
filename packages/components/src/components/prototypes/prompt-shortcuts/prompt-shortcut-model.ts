/**
 * Prompt Shortcuts — PROTOTYPE model.
 *
 * Pure, dependency-free re-statement of the parts of `docs/prompt-shortcuts.md`
 * the UI has to be able to demonstrate: placeholder parsing, requirement
 * derivation by intersection, conflict detection, eligibility, and the
 * segment-based compile that produces the sent Prompt.
 *
 * This is NOT the production model. It exists so the Storybook prototype can be
 * driven by real logic instead of hand-authored screenshots — pills really do
 * change when a mention is deleted, and the send gate really is computed. The
 * shipping version belongs in `@lody/shared` (`prompt-shortcut.ts`) per §12.
 */

export type PrototypeProjectId = string;
export type PrototypeMachineId = string;
export type PrototypeAgentId = string;

export type PrototypeProject = { id: PrototypeProjectId; label: string };
export type PrototypeMachine = { id: PrototypeMachineId; label: string; online: boolean };
export type PrototypeAgent = { id: PrototypeAgentId; label: string };

/** §3.3 first-phase mention kinds. Session and nested Shortcut are out of scope. */
export type PrototypeMentionKind = 'file' | 'skill' | 'agent_role' | 'issue' | 'pr';

/**
 * A stable mention target, keyed in the catalog by the exact token text that
 * appears in a block. The real model stores an id + `labelSnapshot` (§4.1); a
 * prototype can key on the token because the fixtures are closed.
 */
export type PrototypeMentionTarget = {
  token: string;
  kind: PrototypeMentionKind;
  /** Human label used in tooltips and the "required by" attribution. */
  label: string;
  projectId?: PrototypeProjectId;
  machineId?: PrototypeMachineId;
  /** Allowed agents; absent means the mention constrains no provider. */
  agentIds?: readonly PrototypeAgentId[];
  /** Live dependency health, i.e. availability rather than requirement (§2.2). */
  health?: 'ok' | 'deleted' | 'permission_lost';
};

export type PrototypeVariable = {
  name: string;
  label?: string;
  description?: string;
  required: boolean;
  multiline: boolean;
  defaultValue?: string;
};

export type PrototypeShortcut = {
  id: string;
  name: string;
  slug: string;
  description?: string;
  visibility: 'private' | 'workspace';
  ownerLabel: string;
  /**
   * The whole template, as ONE string.
   *
   * There is no block list. Blocks were joined with a blank line into a single
   * user message anyway (§7), so they were a second way to type a paragraph
   * break — three buttons of UI for what Enter already does. A block would only
   * earn its keep if it could be toggled, reused, or sent as its own turn, and
   * §2 rules all three out.
   */
  prompt: string;
  /**
   * Where the author says it applies. Default is all-`null` — the workspace.
   *
   * Set by the author, never inferred from the template. Inserting a `@file`
   * from another project does NOT quietly repoint this; it produces a visible
   * out-of-scope warning instead (`findOutOfScopeReferences`).
   */
  scope: PrototypeScope;
  /** Author-side metadata for tokens found in `prompt`; extras are "unused". */
  variables: PrototypeVariable[];
  revision: number;
};

/* ------------------------------------------------------------------ */
/* Placeholders                                                        */
/* ------------------------------------------------------------------ */

/** §5.1 — `[A-Za-z][A-Za-z0-9_-]{0,39}`, case sensitive. */
const PLACEHOLDER_NAME = '[A-Za-z][A-Za-z0-9_-]{0,39}';
const PLACEHOLDER_SCAN = new RegExp(`(\\\\?)!\\{(${PLACEHOLDER_NAME})\\}`, 'g');

export type PrototypeSegment =
  | { kind: 'text'; text: string }
  | { kind: 'placeholder'; name: string; raw: string }
  | { kind: 'mention'; token: string; target: PrototypeMentionTarget };

/**
 * Splits one block into ordered segments. Mentions win over placeholders only
 * because they cannot overlap in the fixtures; the production compiler resolves
 * both from stored ranges rather than by scanning (§7).
 */
export function segmentBlock(
  text: string,
  catalog: ReadonlyMap<string, PrototypeMentionTarget>
): PrototypeSegment[] {
  const mentionHits: Array<{ start: number; end: number; target: PrototypeMentionTarget }> = [];
  for (const target of catalog.values()) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(target.token, from);
      if (at < 0) break;
      // A token only counts as a mention when it stands alone: `$review` must
      // not match inside `$review-strict`. A trailing `.` is excluded from the
      // boundary set on purpose — `@docs/review-checklist.md.` at the end of a
      // sentence is the token plus punctuation, not a longer token.
      const after = text.charAt(at + target.token.length);
      if (!after || !/[A-Za-z0-9_\-/]/.test(after)) {
        mentionHits.push({ start: at, end: at + target.token.length, target });
      }
      from = at + target.token.length;
    }
  }
  mentionHits.sort((left, right) => left.start - right.start || right.end - left.end);

  const claimed: Array<{ start: number; end: number; target: PrototypeMentionTarget }> = [];
  for (const hit of mentionHits) {
    const last = claimed[claimed.length - 1];
    if (last && hit.start < last.end) continue;
    claimed.push(hit);
  }

  const segments: PrototypeSegment[] = [];
  let cursor = 0;
  const pushPlain = (plain: string) => {
    if (!plain) return;
    PLACEHOLDER_SCAN.lastIndex = 0;
    let last = 0;
    for (;;) {
      const match = PLACEHOLDER_SCAN.exec(plain);
      if (!match) break;
      const [raw, escape, name] = match;
      if (match.index > last) segments.push({ kind: 'text', text: plain.slice(last, match.index) });
      if (escape) {
        // §5.1: `\!{name}` is literal text; the backslash is dropped on compile.
        segments.push({ kind: 'text', text: raw.slice(1) });
      } else {
        segments.push({ kind: 'placeholder', name: name as string, raw });
      }
      last = match.index + raw.length;
    }
    if (last < plain.length) segments.push({ kind: 'text', text: plain.slice(last) });
  };

  for (const hit of claimed) {
    pushPlain(text.slice(cursor, hit.start));
    segments.push({ kind: 'mention', token: hit.target.token, target: hit.target });
    cursor = hit.end;
  }
  pushPlain(text.slice(cursor));
  return segments;
}

/** Placeholder names in document order, deduplicated. One value per name. */
export function collectPlaceholderNames(
  text: string,
  catalog: ReadonlyMap<string, PrototypeMentionTarget>
): string[] {
  const seen: string[] = [];
  for (const segment of segmentBlock(text, catalog)) {
    if (segment.kind === 'placeholder' && !seen.includes(segment.name)) seen.push(segment.name);
  }
  return seen;
}

/** Mention targets referenced by the template, in document order, deduplicated. */
export function collectMentionTargets(
  text: string,
  catalog: ReadonlyMap<string, PrototypeMentionTarget>
): PrototypeMentionTarget[] {
  const seen: PrototypeMentionTarget[] = [];
  for (const segment of segmentBlock(text, catalog)) {
    if (segment.kind !== 'mention') continue;
    if (!seen.some((entry) => entry.token === segment.target.token)) seen.push(segment.target);
  }
  return seen;
}

/* ------------------------------------------------------------------ */
/* Scope (author-set) and reference checks                             */
/* ------------------------------------------------------------------ */

/**
 * Where the author says this Shortcut applies.
 *
 * `null` on every axis is the default and means "anywhere in the workspace".
 * This is SET, not derived: the author picks it, and nothing the template
 * references changes it behind their back.
 *
 * The cost of that choice is real and the UI has to carry it — see
 * `findOutOfScopeReferences`. A scope the author widened past what a `@file`
 * can actually resolve to is a Shortcut that lists fine and fails at send.
 */
export type PrototypeScope = {
  projectId: PrototypeProjectId | null;
  machineId: PrototypeMachineId | null;
  agentId: PrototypeAgentId | null;
};

export const EMPTY_SCOPE: PrototypeScope = { projectId: null, machineId: null, agentId: null };

export const isWorkspaceWideScope = (scope: PrototypeScope): boolean =>
  scope.projectId === null && scope.machineId === null && scope.agentId === null;

/** A reference whose own project/machine/agent the author's scope does not cover. */
export type PrototypeOutOfScopeReference = {
  target: PrototypeMentionTarget;
  /** Which axis fails, and what the reference actually needs. */
  dimension: 'project' | 'machine' | 'agent';
  needs: string;
};

/**
 * References the declared scope cannot satisfy.
 *
 * A wildcard axis (`null`) never fails: "anywhere" includes wherever the
 * reference lives. Only an axis the author pinned to something ELSE does, and
 * only for a reference that names that axis at all.
 */
export function findOutOfScopeReferences(
  text: string,
  catalog: ReadonlyMap<string, PrototypeMentionTarget>,
  scope: PrototypeScope
): PrototypeOutOfScopeReference[] {
  const found: PrototypeOutOfScopeReference[] = [];
  for (const target of collectMentionTargets(text, catalog)) {
    if (scope.projectId && target.projectId && target.projectId !== scope.projectId) {
      found.push({ target, dimension: 'project', needs: target.projectId });
      continue;
    }
    if (scope.machineId && target.machineId && target.machineId !== scope.machineId) {
      found.push({ target, dimension: 'machine', needs: target.machineId });
      continue;
    }
    if (scope.agentId && target.agentIds && !target.agentIds.includes(scope.agentId)) {
      found.push({ target, dimension: 'agent', needs: target.agentIds.join(' or ') });
    }
  }
  return found;
}

/** References that no longer resolve at all — availability, not scope (§2.2). */
export function findBrokenReferences(
  text: string,
  catalog: ReadonlyMap<string, PrototypeMentionTarget>
): PrototypeMentionTarget[] {
  return collectMentionTargets(text, catalog).filter(
    (target) => target.health && target.health !== 'ok'
  );
}

/* ------------------------------------------------------------------ */
/* Eligibility (§10)                                                   */
/* ------------------------------------------------------------------ */

export type PrototypeWorkContext = {
  projectId: PrototypeProjectId | null;
  machineId: PrototypeMachineId | null;
  agentId: PrototypeAgentId | null;
  onlineMachineIds: readonly PrototypeMachineId[];
  /** True while the surrounding context is still resolving (`unknown`). */
  loading?: boolean;
};

export type PrototypeEligibilityReason =
  | 'project_mismatch'
  | 'machine_mismatch'
  | 'machine_offline'
  | 'provider_mismatch'
  | 'dependency_missing'
  | 'permission_denied'
  | 'reference_out_of_scope';

export type PrototypeEligibility =
  | { kind: 'available' }
  | { kind: 'unknown'; reason: 'context_loading' }
  | { kind: 'unavailable'; reason: PrototypeEligibilityReason; detail?: string };

/**
 * The one resolver. Settings, the `/` menu, and the send gate all call this —
 * three copies of the filter is exactly how they drift (§10).
 *
 * Scope is what the author set; the reference checks come after it, because a
 * scope the author widened does not make a deleted file exist again.
 */
export function resolveEligibility(
  shortcut: Pick<PrototypeShortcut, 'scope' | 'prompt'>,
  catalog: ReadonlyMap<string, PrototypeMentionTarget>,
  context: PrototypeWorkContext,
  labels: {
    project: (id: PrototypeProjectId) => string;
    machine: (id: PrototypeMachineId) => string;
    agent: (id: PrototypeAgentId) => string;
  }
): PrototypeEligibility {
  const broken = findBrokenReferences(shortcut.prompt, catalog);
  const first = broken[0];
  if (first) {
    return {
      kind: 'unavailable',
      reason: first.health === 'permission_lost' ? 'permission_denied' : 'dependency_missing',
      detail: first.label,
    };
  }

  // An author-set scope can promise more than the template can deliver. That is
  // the trade this design makes, so it has to be visible rather than silent.
  const outOfScope = findOutOfScopeReferences(shortcut.prompt, catalog, shortcut.scope)[0];
  if (outOfScope) {
    return {
      kind: 'unavailable',
      reason: 'reference_out_of_scope',
      detail: outOfScope.target.label,
    };
  }

  if (context.loading) return { kind: 'unknown', reason: 'context_loading' };

  const { scope } = shortcut;
  if (scope.projectId && scope.projectId !== context.projectId) {
    return {
      kind: 'unavailable',
      reason: 'project_mismatch',
      detail: labels.project(scope.projectId),
    };
  }
  if (scope.machineId) {
    if (scope.machineId !== context.machineId) {
      return {
        kind: 'unavailable',
        reason: 'machine_mismatch',
        detail: labels.machine(scope.machineId),
      };
    }
    // No fallback to another machine that happens to run the same provider.
    if (!context.onlineMachineIds.includes(scope.machineId)) {
      return {
        kind: 'unavailable',
        reason: 'machine_offline',
        detail: labels.machine(scope.machineId),
      };
    }
  }
  if (scope.agentId && scope.agentId !== context.agentId) {
    return {
      kind: 'unavailable',
      reason: 'provider_mismatch',
      detail: labels.agent(scope.agentId),
    };
  }

  return { kind: 'available' };
}

/* ------------------------------------------------------------------ */
/* Variables + compile (§5, §7)                                        */
/* ------------------------------------------------------------------ */

export type PrototypeVariableValues = Readonly<Record<string, string>>;

/**
 * The variable rows an invocation shows: every placeholder in the template, in
 * document order, merged with whatever author metadata exists for it.
 */
export function resolveVariableRows(
  shortcut: PrototypeShortcut,
  catalog: ReadonlyMap<string, PrototypeMentionTarget>
): PrototypeVariable[] {
  return collectPlaceholderNames(shortcut.prompt, catalog).map((name) => {
    const defined = shortcut.variables.find((entry) => entry.name === name);
    return defined ?? { name, required: true, multiline: false };
  });
}

/** Variable definitions no token refers to any more (§5.2). */
export function resolveUnusedVariables(
  shortcut: PrototypeShortcut,
  catalog: ReadonlyMap<string, PrototypeMentionTarget>
): PrototypeVariable[] {
  const used = collectPlaceholderNames(shortcut.prompt, catalog);
  return shortcut.variables.filter((entry) => !used.includes(entry.name));
}

export function resolveEffectiveValue(
  variable: PrototypeVariable,
  values: PrototypeVariableValues
): string {
  const typed = values[variable.name];
  if (typed !== undefined && typed.length > 0) return typed;
  return variable.defaultValue ?? '';
}

export function findMissingVariables(
  rows: readonly PrototypeVariable[],
  values: PrototypeVariableValues
): PrototypeVariable[] {
  return rows.filter((row) => row.required && resolveEffectiveValue(row, values).length === 0);
}

/**
 * §7 — one pass over the segments, never a string replace followed by offset
 * repair. Returns the final Prompt plus the mention spans it still carries, so
 * the transcript can paint the same chips.
 */
export function compileShortcut(
  shortcut: PrototypeShortcut,
  catalog: ReadonlyMap<string, PrototypeMentionTarget>,
  values: PrototypeVariableValues
): { text: string; mentions: Array<{ start: number; end: number; token: string }> } {
  const rows = resolveVariableRows(shortcut, catalog);
  const parts: string[] = [];
  const mentions: Array<{ start: number; end: number; token: string }> = [];
  let offset = 0;

  for (const segment of segmentBlock(shortcut.prompt, catalog)) {
    if (segment.kind === 'mention') {
      mentions.push({ start: offset, end: offset + segment.token.length, token: segment.token });
      parts.push(segment.token);
      offset += segment.token.length;
      continue;
    }
    if (segment.kind === 'placeholder') {
      const row = rows.find((entry) => entry.name === segment.name);
      // Literal substitution, exactly once — no second parse of the value.
      const value = row ? resolveEffectiveValue(row, values) : (values[segment.name] ?? '');
      // An unfilled required token stays visible so the send gate can see it.
      const written = value.length > 0 ? value : segment.raw;
      parts.push(written);
      offset += written.length;
      continue;
    }
    parts.push(segment.text);
    offset += segment.text.length;
  }

  return { text: parts.join(''), mentions };
}

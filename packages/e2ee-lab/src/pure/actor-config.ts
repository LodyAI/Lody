import { Schema } from 'effect';

export const LabActorName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
export const LabActorConfiguration = Schema.Struct({
  id: LabActorName,
  role: Schema.Literals(['owner', 'admin', 'member', 'guest']),
  kind: Schema.optional(Schema.Literals(['personal', 'machine', 'recovery'])),
  /** Extra devices belong to this configured personal actor's member. */
  memberOf: Schema.optional(LabActorName),
  behavior: Schema.optional(
    Schema.Literals(['honest', 'revoked-device', 'insider', 'noncompliant-manager'])
  ),
});
export type LabActorConfiguration = typeof LabActorConfiguration.Type;
export const defaultLabActors: readonly LabActorConfiguration[] = [
  { id: 'owner', role: 'owner' },
  { id: 'peer', role: 'owner', memberOf: 'owner' },
];
/** Bounded owned JSON configuration; ids never become arbitrary filesystem paths. */
export function captureLabActors(
  input: unknown = defaultLabActors
): readonly LabActorConfiguration[] {
  const rows = Schema.decodeUnknownSync(
    Schema.Array(LabActorConfiguration).check(Schema.isMinLength(1), Schema.isMaxLength(32))
  )(input);
  const ids = new Set(rows.map((row) => row.id));
  const primaries = rows.filter((row) => row.role === 'owner' && row.memberOf === undefined);
  if (ids.size !== rows.length || primaries.length !== 1) throw new Error('actor-configuration');
  const owner = primaries[0]!;
  if (
    (owner.kind !== undefined && owner.kind !== 'personal') ||
    owner.behavior === 'revoked-device'
  )
    throw new Error('actor-configuration');
  for (const row of rows) {
    const parent = row.memberOf && rows.find((candidate) => candidate.id === row.memberOf);
    if (
      (row.memberOf !== undefined &&
        (!parent ||
          parent.memberOf !== undefined ||
          parent.id === row.id ||
          parent.role !== row.role ||
          (parent.kind !== undefined && parent.kind !== 'personal'))) ||
      (row.role === 'owner' && row.id !== owner.id && row.memberOf !== owner.id) ||
      (row.behavior === 'noncompliant-manager' && !['owner', 'admin'].includes(row.role)) ||
      (row.kind === 'recovery' && row.memberOf === undefined) ||
      (row.memberOf === undefined && row.kind !== undefined && row.kind !== 'personal')
    )
      throw new Error('actor-configuration');
  }
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

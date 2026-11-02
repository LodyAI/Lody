/** Synthetic exit audit only. Callers supply observed bytes; missing observations
 * are a coverage gap, never a confidentiality pass. No plaintext/body is reported. */
export const canaryFields = [
  'message',
  'title',
  'fileName',
  'mcpEnvironment',
  'machineConfig',
] as const;
export type CanaryField = (typeof canaryFields)[number];
export type CanaryMarkers = Record<CanaryField, string>;
export type CanarySource = {
  readonly kind: 'streams' | 'http';
  readonly id: string;
  readonly body: Uint8Array;
};

export function scanE2eeCanaries(markers: CanaryMarkers, sources: readonly CanarySource[]) {
  for (const field of canaryFields)
    if (!/^CANARY-[A-Za-z0-9-]{24,}$/.test(markers[field]))
      throw new Error('canary_invalid_marker');
  const findings: {
    source: string;
    kind: CanarySource['kind'];
    field: CanaryField;
    encoding: string;
    offset: number;
  }[] = [];
  let bytes = 0;
  const observed = new Set<CanarySource['kind']>();
  for (const source of sources) {
    if (
      !source.id ||
      (source.kind !== 'streams' && source.kind !== 'http') ||
      !(source.body instanceof Uint8Array)
    )
      throw new Error('canary_invalid_source');
    const body = Buffer.from(source.body.buffer, source.body.byteOffset, source.body.byteLength);
    if (body.length) observed.add(source.kind);
    bytes += body.length;
    for (const field of canaryFields) {
      const original = Buffer.from(markers[field], 'utf8');
      for (const [encoding, needle] of [
        ['utf8', original],
        ['hex', Buffer.from(original.toString('hex'))],
        ['base64', Buffer.from(original.toString('base64'))],
      ] as const) {
        const offset = body.indexOf(needle);
        if (offset !== -1)
          findings.push({ source: source.id, kind: source.kind, field, encoding, offset });
      }
    }
  }
  const missing = (['streams', 'http'] as const).filter((kind) => !observed.has(kind));
  return {
    ok: findings.length === 0 && missing.length === 0,
    sources: sources.length,
    bytes,
    findings,
    missing,
  };
}

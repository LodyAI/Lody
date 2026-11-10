import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import {
  buildSessionTurnInputConfig,
  canonicalIntentJson,
  decodeE2eeIntentRecord,
  E2EE_INTENT_KIND,
  encodeE2eeIntentRecord,
  isMemberSignableInput,
  scheduleDeclarationMessageId,
  sessionDocSchema,
  turnExecutionContent,
  turnExecutionDigest,
} from '../src';

const config = buildSessionTurnInputConfig({
  inputBlocks: [{ type: 'text', text: 'Synthetic signed input' }],
  cliType: 'builtin',
  agentType: 'codex',
});

describe('encrypted execution intent', () => {
  it('pins the canonical content and digest every signer and verifier share', () => {
    expect(turnExecutionContent({ inputConfig: config })).toBe(
      '{"input":{"agentType":"codex","cliType":"builtin","inputBlocks":[{"text":"Synthetic signed input","type":"text"}],"prompt":"Synthetic signed input"},"v":1}'
    );
    expect(turnExecutionDigest({ inputConfig: config })).toBe(
      'f07f303a79e603e7ad3a24f68fcf46c5e192c8c1848a2370374741431518d4e3'
    );
    expect(
      turnExecutionDigest({
        inputConfig: config,
        derivedFrom: { sessionId: 'origin-session', userTurnId: 'origin-turn' },
      })
    ).toBe('1a64182ae66f7b8b65f153c58ba0f68b4cce6a7cbebeeeed96a53faec37bc7e5');
  });

  it('covers what runs, but not the resume a promotion supplies or key order', () => {
    const digest = turnExecutionDigest({ inputConfig: config });
    expect(turnExecutionDigest({ inputConfig: { ...config, resume: 'promoted' } })).toBe(digest);
    expect(
      turnExecutionDigest({ inputConfig: JSON.parse(canonicalIntentJson(config)) as unknown })
    ).toBe(digest);
    for (const changed of [
      { ...config, prompt: 'Other input', inputBlocks: [{ type: 'text', text: 'Other input' }] },
      { ...config, modelId: 'other-model' },
      { ...config, modeId: 'bypassPermissions' },
      { ...config, agentType: 'claude' },
    ])
      expect(turnExecutionDigest({ inputConfig: changed })).not.toBe(digest);
    expect(
      turnExecutionDigest({
        inputConfig: config,
        scheduleRun: { scheduleId: 's', turnId: 't', title: 'x' },
      })
    ).not.toBe(digest);
    expect(turnExecutionDigest({ inputConfig: undefined })).toBeUndefined();
    expect(turnExecutionDigest({ inputConfig: 'text' })).toBeUndefined();
    // An input that leaves its agent to the Session still signs exactly what it carries.
    const partial = turnExecutionDigest({ inputConfig: { prompt: 'partial', resume: 'any' } });
    expect(partial).toBe(turnExecutionDigest({ inputConfig: { prompt: 'partial' } }));
    expect(partial).not.toBe(turnExecutionDigest({ inputConfig: { prompt: 'other' } }));
  });

  it('encodes a strict 98-byte record and survives a real document write', () => {
    const record = encodeE2eeIntentRecord({
      kind: E2EE_INTENT_KIND.memberInput,
      signer: new Uint8Array(32).fill(7),
      signature: new Uint8Array(64).fill(9),
    });
    expect(record).toHaveLength(131);
    expect(record.slice(0, 8)).toBe('AQEHBwcH');
    expect(decodeE2eeIntentRecord(record)).toEqual({
      kind: 1,
      signer: new Uint8Array(32).fill(7),
      signature: new Uint8Array(64).fill(9),
    });
    for (const bad of [
      record.slice(1),
      `C${record.slice(1)}`,
      `${record.slice(0, 130)}B`,
      'hex',
      null,
    ])
      expect(decodeE2eeIntentRecord(bad)).toBeUndefined();
    expect(() =>
      encodeE2eeIntentRecord({ kind: 1, signer: new Uint8Array(31), signature: new Uint8Array(64) })
    ).toThrow('e2ee_intent_record_invalid');

    const doc = new LoroDoc();
    const mirror = new Mirror({ doc, schema: sessionDocSchema, ignoreUnknownProperties: true });
    try {
      mirror.setState((draft) => {
        draft.mq = [
          {
            task: 'Synthetic signed input',
            userId: 'display-account',
            userTurnId: 'queued-turn',
            timestamp: new Date(0).toISOString(),
            acpSessionConfig: config,
            e2eeIntent: record,
          } as never,
        ];
      });
      doc.commit();
      const copy = new LoroDoc();
      copy.import(doc.export({ mode: 'snapshot' }));
      const stored = (copy.toJSON() as { mq: { e2eeIntent: unknown }[] }).mq[0]!.e2eeIntent;
      expect(decodeE2eeIntentRecord(stored)).toEqual(decodeE2eeIntentRecord(record));
    } finally {
      mirror.dispose();
    }
  });

  it('lets a member sign every composer input, including attachment- or reference-only ones', () => {
    const composer = (inputBlocks: unknown[]) =>
      buildSessionTurnInputConfig({
        inputBlocks: inputBlocks as never,
        cliType: 'builtin',
        agentType: 'codex',
      });
    const image = {
      type: 'image',
      imageId: 'synthetic-image',
      mimeType: 'image/png',
      sizeBytes: 9,
    };
    const file = {
      type: 'file',
      transport: 'local',
      fileId: '/synthetic/notes.txt',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: 7,
      sha256: 'a'.repeat(64),
      textPreview: false,
      uploadedAt: 1,
      machineId: 'synthetic-machine',
    };
    const reference = {
      type: 'comment_reference',
      source: 'lody',
      path: 'src/synthetic.ts',
      lineNumber: 3,
      side: 'additions',
      commentBody: 'Synthetic comment',
      authorName: 'Synthetic',
    };
    for (const blocks of [[{ type: 'text', text: 'hi' }], [image], [file], [reference]])
      expect(isMemberSignableInput(composer(blocks)), JSON.stringify(blocks)).toBe(true);
    // An input that names no agent is machine-authored; one with nothing to run is no input.
    expect(isMemberSignableInput({ prompt: 'synthetic' })).toBe(false);
    expect(isMemberSignableInput(composer([]))).toBe(false);
  });

  it('names schedule declarations by definition or manual run', () => {
    expect(scheduleDeclarationMessageId()).toBe('definition');
    expect(scheduleDeclarationMessageId('ab'.repeat(32))).toBe(`manual:${'ab'.repeat(32)}`);
  });
});

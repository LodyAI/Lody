import { describe, expect, it } from 'vitest';
import { LoroDoc, LoroMap, LoroText } from 'loro-crdt';
import {
  MEMORY_LIMITS,
  MemoryCreateInputSchema,
  MemoryUpdateInputSchema,
  MemoryDescriptionSchema,
  MemoryReadInputSchema,
  resolveMemoryPath,
  buildMemorySearchQuery,
  type MemoryIdentity,
  type MemoryResult,
} from '../src/index.ts';
import { initializeMemoryDoc, inspectMemoryIdentity, openMemoryDocument } from '../src/loro.ts';

const identity: MemoryIdentity = {
  memoryId: 'memory-a',
  roleId: 'role-a',
  ownership: 'personal',
  ownerId: 'user-a',
};
const context = (changeId: string) => ({
  changeId,
  recordedAt: 100,
  source: { actor: 'agent' as const, turn: { sessionId: 'session', turnId: 'turn' } },
});
function value<T>(result: MemoryResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function fresh(owner = identity) {
  const doc = new LoroDoc();
  value(initializeMemoryDoc(doc, owner, context('init')));
  return doc;
}
function open(doc: LoroDoc, owner = identity) {
  return value(openMemoryDocument(doc, owner));
}
function entry(doc: LoroDoc, path: string) {
  const root = doc.getMap('documents');
  try {
    const child = root.get(path);
    if (!(child instanceof LoroMap)) throw new Error('Fixture entry missing');
    return child;
  } finally {
    root.free();
  }
}
function writeRaw(doc: LoroDoc, path: string, content: string) {
  const child = entry(doc, path);
  const body = child.get('body');
  if (!(body instanceof LoroText)) throw new Error('Fixture body missing');
  try {
    body.update(content);
  } finally {
    body.free();
    child.free();
  }
  doc.commit();
}
function sync(a: LoroDoc, b: LoroDoc) {
  a.import(b.export({ mode: 'update' }));
  b.import(a.export({ mode: 'update' }));
  expect(a.toJSON()).toEqual(b.toJSON());
}

describe('memory inputs', () => {
  it('normalizes wiki syntax without admitting filesystem paths or arbitrary queries', () => {
    expect(resolveMemoryPath('[[projects/示例]]')).toEqual({ ok: true, value: 'projects/示例.md' });
    for (const input of [
      '.',
      '..',
      '../secret',
      '/etc/passwd',
      'C:\\secret',
      'https://x',
      'a//b',
      'a%2fb',
      '[[a|b]]',
    ]) {
      expect(resolveMemoryPath(input).ok).toBe(false);
    }
    expect(buildMemorySearchQuery('\n').ok).toBe(false);
    expect(buildMemorySearchQuery(' ').ok).toBe(false);
  });
  it('rejects scope selectors and bounds input by code points and bytes', () => {
    for (const key of ['userId', 'roleId', 'memoryId', 'documentId', 'source']) {
      expect(
        MemoryCreateInputSchema.safeParse({ path: 'a.md', body: '', [key]: 'other' }).success
      ).toBe(false);
    }
    expect(MemoryDescriptionSchema.safeParse('😀'.repeat(300)).success).toBe(true);
    expect(MemoryDescriptionSchema.safeParse('😀'.repeat(301)).success).toBe(false);
    expect(
      MemoryCreateInputSchema.safeParse({ path: 'a.md', body: '字'.repeat(22000) }).success
    ).toBe(false);
    expect(MemoryUpdateInputSchema.safeParse({ path: 'a.md' }).success).toBe(false);
    expect(
      MemoryUpdateInputSchema.parse({ path: 'a.md', description: null }).description
    ).toBeNull();
    for (const offset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(MemoryReadInputSchema.safeParse({ path: 'a.md', offset }).success).toBe(false);
    }
  });
});

describe('path-addressed memory', () => {
  it('stores paths as literal map keys and recovers content and sources from snapshots', () => {
    const doc = fresh();
    const copy = new LoroDoc();
    try {
      const memory = open(doc);
      expect(value(memory.startup()).entry?.document.path).toBe('MEMORY.md');
      expect(
        value(
          memory.create(
            { path: 'projects/a.md', body: '事实', description: '项目' },
            context('create')
          )
        )
      ).toEqual({ path: 'projects/a.md', changeId: 'create' });
      expect(doc.toJSON().documents).toMatchObject({
        'projects/a.md': { body: '事实', description: '项目', createdAt: 100 },
      });
      const child = entry(doc, 'projects/a.md');
      expect(child.get('path')).toBeUndefined();
      child.free();
      copy.import(doc.export({ mode: 'snapshot' }));
      const restored = open(copy);
      expect(value(restored.resolve('[[projects/a]]')).path).toBe('projects/a.md');
      expect(value(restored.read({ path: 'projects/a.md' })).body).toBe('事实');
      expect(value(restored.provenance('projects/a.md', {})).items).toEqual([
        { kind: 'create', ...context('create') },
      ]);
    } finally {
      copy.free();
      doc.free();
    }
  });

  it('checks identity at open, rejects unknown formats, and never resets existing history', () => {
    const doc = fresh();
    try {
      const before = doc.opCount();
      expect(inspectMemoryIdentity(doc, identity)).toEqual({ ok: true, value: identity });
      expect(doc.opCount()).toBe(before);
      for (const key of ['ownerId', 'roleId', 'memoryId'] as const) {
        expect(openMemoryDocument(doc, { ...identity, [key]: 'other' })).toEqual({
          ok: false,
          error: { code: 'scope_mismatch' },
        });
      }
      expect(initializeMemoryDoc(doc, identity, context('again')).ok).toBe(false);
      const meta = doc.getMap('meta');
      meta.set('formatVersion', 99);
      meta.free();
      expect(openMemoryDocument(doc, identity)).toEqual({
        ok: false,
        error: { code: 'unsupported_format' },
      });
    } finally {
      doc.free();
    }
  });

  it('isolates roles and users even for the same path and forged tool fields', () => {
    const a = fresh();
    const ownerB = { ...identity, memoryId: 'memory-b', roleId: 'role-b', ownerId: 'user-b' };
    const b = fresh(ownerB);
    try {
      const left = open(a),
        right = open(b, ownerB);
      value(left.create({ path: 'secret.md', body: 'private-a' }, context('secret')));
      expect(value(right.search({ query: 'private-a' })).items).toEqual([]);
      expect(right.read({ path: 'secret.md' })).toEqual({
        ok: false,
        error: { code: 'not_found' },
      });
      expect(right.read({ path: 'secret.md', memoryId: identity.memoryId } as never)).toEqual({
        ok: false,
        error: { code: 'invalid_input' },
      });
      expect(value(right.list({})).items.map((x) => x.path)).toEqual(['MEMORY.md']);
    } finally {
      a.free();
      b.free();
    }
  });

  it('merges concurrent creation of the same path into one shared body and provenance map', () => {
    const a = fresh(),
      b = new LoroDoc();
    try {
      b.import(a.export({ mode: 'snapshot' }));
      value(
        open(a).create(
          { path: 'projects/shared.md', body: 'LEFT\n', description: 'left' },
          context('left')
        )
      );
      value(
        open(b).create(
          { path: 'projects/shared.md', body: 'RIGHT\n', description: 'right' },
          context('right')
        )
      );
      const ea = entry(a, 'projects/shared.md'),
        eb = entry(b, 'projects/shared.md');
      expect(ea.id).toBe(eb.id);
      ea.free();
      eb.free();
      sync(a, b);
      const memory = open(a);
      const body = value(memory.read({ path: 'projects/shared.md' })).body;
      expect(body).toContain('LEFT\n');
      expect(body).toContain('RIGHT\n');
      expect(value(memory.list({})).items.map((x) => x.path)).toEqual([
        'MEMORY.md',
        'projects/shared.md',
      ]);
      expect(
        value(memory.provenance('projects/shared.md', {})).items.map((x) => x.changeId)
      ).toEqual(['left', 'right']);
      a.import(b.export({ mode: 'update' }));
      expect(value(memory.read({ path: 'projects/shared.md' })).body).toBe(body);
    } finally {
      a.free();
      b.free();
    }
  });

  it('preserves independent additions and concurrent edits to an existing text', () => {
    const a = fresh(),
      b = new LoroDoc();
    try {
      const left = open(a);
      value(left.create({ path: 'base.md', body: 'first\nlast\n' }, context('base')));
      b.import(a.export({ mode: 'snapshot' }));
      const right = open(b);
      value(left.update({ path: 'base.md', body: 'left\nfirst\nlast\n' }, context('left-edit')));
      value(right.update({ path: 'base.md', body: 'first\nlast\nright\n' }, context('right-edit')));
      value(left.create({ path: 'a.md', body: 'a' }, context('a')));
      value(right.create({ path: 'b.md', body: 'b' }, context('b')));
      sync(a, b);
      expect(value(left.read({ path: 'base.md' })).body).toBe('left\nfirst\nlast\nright\n');
      expect(value(left.list({})).items.map((x) => x.path)).toEqual([
        'MEMORY.md',
        'a.md',
        'b.md',
        'base.md',
      ]);
    } finally {
      a.free();
      b.free();
    }
  });

  it('writes an existing path directly without creating another document', () => {
    const doc = fresh();
    try {
      const memory = open(doc);
      value(
        memory.create({ path: 'a.md', body: 'old', description: 'old summary' }, context('first'))
      );
      const child = entry(doc, 'a.md'),
        id = child.id;
      child.free();
      value(memory.create({ path: 'a.md', body: 'new' }, context('second')));
      const current = entry(doc, 'a.md');
      expect(current.id).toBe(id);
      current.free();
      expect(value(memory.read({ path: 'a.md' })).body).toBe('new');
      expect(value(memory.resolve('a.md')).description).toBeUndefined();
      expect(value(memory.provenance('a.md', {})).items).toHaveLength(2);
    } finally {
      doc.free();
    }
  });

  it('moves visible content and provenance to a new path and clears descriptions explicitly', () => {
    const doc = fresh();
    try {
      const memory = open(doc);
      value(
        memory.create(
          { path: 'old.md', body: 'content', description: 'description' },
          context('create')
        )
      );
      const old = entry(doc, 'old.md'),
        id = old.id;
      old.set('futureField', { retain: true });
      old.free();
      value(
        memory.update(
          { path: 'old.md', newPath: 'projects/new.md', description: null },
          context('move')
        )
      );
      expect(memory.read({ path: 'old.md' })).toEqual({ ok: false, error: { code: 'not_found' } });
      const moved = entry(doc, 'projects/new.md');
      expect(moved.id).not.toBe(id);
      expect(moved.get('futureField')).toEqual({ retain: true });
      moved.free();
      expect(value(memory.read({ path: 'projects/new.md' })).body).toBe('content');
      expect(value(memory.resolve('[[projects/new]]')).description).toBeUndefined();
      expect(value(memory.provenance('projects/new.md', {})).items.map((x) => x.kind)).toEqual([
        'create',
        'move',
      ]);
    } finally {
      doc.free();
    }
  });

  it('does not overwrite a visible move destination or move the fixed entry', () => {
    const doc = fresh();
    try {
      const memory = open(doc);
      value(memory.create({ path: 'a.md', body: 'a' }, context('a')));
      value(memory.create({ path: 'b.md', body: 'b' }, context('b')));
      const before = doc.toJSON();
      expect(
        memory.update({ path: 'a.md', newPath: 'b.md', body: 'overwrite' }, context('move'))
      ).toEqual({ ok: false, error: { code: 'path_exists' } });
      expect(memory.update({ path: 'MEMORY.md', newPath: 'c.md' }, context('entry')).ok).toBe(
        false
      );
      expect(memory.update({ path: 'a.md', newPath: 'MEMORY.md' }, context('entry2')).ok).toBe(
        false
      );
      expect(memory.forget({ path: 'MEMORY.md' }, context('forget')).ok).toBe(false);
      expect(doc.toJSON()).toEqual(before);
    } finally {
      doc.free();
    }
  });

  it('merges concurrent moves to the same destination as one path', () => {
    const a = fresh(),
      b = new LoroDoc();
    try {
      const left = open(a);
      value(left.create({ path: 'a.md', body: 'A\n' }, context('a')));
      value(left.create({ path: 'b.md', body: 'B\n' }, context('b')));
      b.import(a.export({ mode: 'snapshot' }));
      value(left.update({ path: 'a.md', newPath: 'shared.md' }, context('move-a')));
      value(open(b).update({ path: 'b.md', newPath: 'shared.md' }, context('move-b')));
      sync(a, b);
      expect(value(left.list({})).items.map((x) => x.path)).toEqual(['MEMORY.md', 'shared.md']);
      const body = value(left.read({ path: 'shared.md' })).body;
      expect(body).toContain('A\n');
      expect(body).toContain('B\n');
      expect(value(left.provenance('shared.md', {})).items.map((x) => x.changeId)).toEqual([
        'a',
        'b',
        'move-a',
        'move-b',
      ]);
    } finally {
      a.free();
      b.free();
    }
  });

  it('keeps deletion hidden after offline edits and duplicate delivery, then allows explicit recreation', () => {
    const a = fresh(),
      b = new LoroDoc(),
      copy = new LoroDoc();
    try {
      const left = open(a);
      value(left.create({ path: 'a.md', body: 'old', description: 'old' }, context('create')));
      const old = entry(a, 'a.md'),
        id = old.id;
      old.free();
      b.import(a.export({ mode: 'snapshot' }));
      value(left.forget({ path: 'a.md' }, context('delete')));
      value(open(b).update({ path: 'a.md', body: 'offline' }, context('offline')));
      sync(a, b);
      a.import(b.export({ mode: 'update' }));
      expect(left.update({ path: 'a.md', body: 'implicit revive' }, context('bad'))).toEqual({
        ok: false,
        error: { code: 'not_found' },
      });
      expect(value(left.search({ query: 'offline' })).items).toEqual([]);
      copy.import(a.export({ mode: 'snapshot' }));
      const restored = open(copy);
      expect(restored.read({ path: 'a.md' }).ok).toBe(false);
      value(restored.create({ path: 'a.md', body: 'explicit new content' }, context('recreate')));
      const recreated = entry(copy, 'a.md');
      expect(recreated.id).toBe(id);
      recreated.free();
      expect(value(restored.read({ path: 'a.md' })).body).toBe('explicit new content');
      expect(value(restored.resolve('a.md')).description).toBeUndefined();
      expect(value(restored.provenance('a.md', {})).items.map((x) => x.kind)).toContain('forget');
    } finally {
      a.free();
      b.free();
      copy.free();
    }
  });

  it('searches literal path keys, descriptions and bodies with ranked live pages', () => {
    const doc = fresh();
    try {
      const memory = open(doc);
      value(memory.create({ path: 'projects/主题.md', body: 'other' }, context('path')));
      value(
        memory.create(
          { path: 'description.md', body: 'other', description: '主题' },
          context('description')
        )
      );
      value(
        memory.create(
          { path: 'body.md', body: '正文主题', description: 'outdated' },
          context('body')
        )
      );
      const first = value(memory.search({ query: '主题', limit: 1 }));
      expect(first.items[0]?.document.path).toBe('projects/主题.md');
      expect(
        value(memory.search({ query: '主题', offset: first.nextOffset })).items.map(
          (x) => x.document.path
        )
      ).toEqual(['description.md', 'body.md']);
      const literal = '") || @.body contains "';
      value(memory.create({ path: 'quote"key.md', body: literal }, context('literal')));
      expect(value(memory.search({ query: literal })).items.map((x) => x.document.path)).toEqual([
        'quote"key.md',
      ]);
      expect(
        value(memory.search({ query: 'quote"key' })).items.map((x) => x.document.path)
      ).toEqual(['quote"key.md']);
      expect(value(memory.search({ query: '主题', offset: 100 })).items).toEqual([]);
    } finally {
      doc.free();
    }
  });

  it('reads Unicode pages from live state without version gates', () => {
    const doc = fresh();
    try {
      const memory = open(doc);
      value(memory.create({ path: 'a.md', body: '偏好😀简洁回答' }, context('create')));
      const first = value(memory.read({ path: 'a.md', limit: 3 }));
      expect(first.body).toBe('偏好😀');
      expect(value(memory.read({ path: 'a.md', offset: first.nextOffset })).body).toBe('简洁回答');
      value(memory.update({ path: 'a.md', body: '' }, context('shrink')));
      expect(value(memory.read({ path: 'a.md', offset: first.nextOffset })).body).toBe('');
    } finally {
      doc.free();
    }
  });

  it('pages metadata without reading off-page documents and surfaces broken internal state', () => {
    const doc = fresh();
    try {
      const memory = open(doc);
      value(memory.create({ path: 'z.md', body: '' }, context('z')));
      const bad = entry(doc, 'z.md');
      const description = bad.setContainer('description', new LoroText());
      description.free();
      bad.free();
      const page = value(memory.list({ limit: 1 }));
      expect(page.items.map((x) => x.path)).toEqual(['MEMORY.md']);
      expect(() => memory.list({ offset: page.nextOffset })).toThrow('Invalid memory document');
    } finally {
      doc.free();
    }
  });

  it('bounds startup after concurrent expansion and permits gradual reduction', () => {
    const doc = fresh();
    try {
      const memory = open(doc);
      writeRaw(doc, 'MEMORY.md', '😀'.repeat(5000));
      const startup = value(memory.startup());
      expect(Buffer.byteLength(startup.entry?.body ?? '')).toBe(8192);
      expect(startup.entry?.nextOffset).toBe(2048);
      value(memory.update({ path: 'MEMORY.md', description: 'summary' }, context('describe')));
      value(memory.update({ path: 'MEMORY.md', body: 'x'.repeat(9000) }, context('reduce')));
      expect(memory.update({ path: 'MEMORY.md', body: 'x'.repeat(9500) }, context('grow'))).toEqual(
        { ok: false, error: { code: 'limit_exceeded' } }
      );
      value(memory.update({ path: 'MEMORY.md', body: '' }, context('clear')));
      expect(value(memory.startup()).entry?.body).toBe('');
    } finally {
      doc.free();
    }
  });

  it('enforces aggregate and document quotas without partial mutation and frees capacity on deletion', () => {
    const doc = fresh();
    try {
      const memory = open(doc);
      for (let i = 0; i < 128; i++)
        value(
          memory.create({ path: `large-${i}.md`, body: 'x'.repeat(65536) }, context(`large-${i}`))
        );
      const count = doc.opCount();
      expect(memory.create({ path: 'overflow.md', body: 'x' }, context('overflow'))).toEqual({
        ok: false,
        error: { code: 'limit_exceeded' },
      });
      expect(doc.opCount()).toBe(count);
      for (let i = 128; i < MEMORY_LIMITS.documents - 1; i++)
        value(memory.create({ path: `empty-${i}.md`, body: '' }, context(`empty-${i}`)));
      expect(memory.create({ path: 'extra.md', body: '' }, context('extra'))).toEqual({
        ok: false,
        error: { code: 'limit_exceeded' },
      });
      value(
        memory.update({ path: 'large-0.md', newPath: 'moved.md' }, context('move-at-capacity'))
      );
      value(memory.forget({ path: 'large-1.md' }, context('free')));
      value(memory.create({ path: 'extra.md', body: 'space freed' }, context('extra')));
      expect(value(memory.read({ path: 'extra.md' })).body).toBe('space freed');
    } finally {
      doc.free();
    }
  }, 20000);
});

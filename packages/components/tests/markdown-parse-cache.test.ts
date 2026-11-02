import { describe, expect, it } from 'vitest';
import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { createMarkdownParseCache } from '../src/lib/markdown-parse-cache';

const generous = { entries: 2, sourceCharacters: 100, nodes: 100, entryCharacters: 100 };

function fixture(limits = generous) {
  const unavailable = new Set<string>();
  const boundary: Plugin = function () {
    const parse = this.parser!;
    this.parser = (source, file) => {
      if (unavailable.has(source)) throw new Error('Parser unavailable');
      return parse(source, file);
    };
  };
  const cached = createMarkdownParseCache(limits);
  const read = (source: string) =>
    unified().use(remarkParse).use(boundary).use(cached).parse(source);
  return { unavailable, read };
}

describe('Markdown parse cache', () => {
  it('returns fresh input trees after both the initial consumer and later consumers mutate them', () => {
    const { read, unavailable } = fixture();
    const expected = unified().use(remarkParse).parse('**original**');
    const initial = read('**original**');
    Object.assign(initial, { children: [] });
    unavailable.add('**original**');
    const restored = read('**original**');
    expect(restored).toEqual(expected);
    Object.assign(restored, { children: [] });
    expect(read('**original**')).toEqual(expected);
  });

  it.each([
    ['entries', generous],
    ['source characters', { ...generous, entries: 20, sourceCharacters: 10 }],
    ['AST nodes', { ...generous, entries: 20, nodes: 6 }],
  ] as const)('evicts least recently used input within its %s budget', (_name, limits) => {
    const { read, unavailable } = fixture(limits);
    read('alpha');
    read('beta');
    unavailable.add('alpha');
    expect(read('alpha')).toEqual(unified().use(remarkParse).parse('alpha'));
    read('gamma');
    unavailable.add('beta');
    expect(() => read('beta')).toThrow('Parser unavailable');
    expect(read('alpha')).toEqual(unified().use(remarkParse).parse('alpha'));
  });

  it.each([
    { ...generous, entryCharacters: 10 },
    { ...generous, nodes: 3 },
  ])('does not retain oversized input or evict a useful small entry for it', (limits) => {
    const { read, unavailable } = fixture(limits);
    read('small');
    const large = '# First heading\n\n# Second heading';
    expect(read(large)).toEqual(unified().use(remarkParse).parse(large));
    unavailable.add(large);
    unavailable.add('small');
    expect(() => read(large)).toThrow('Parser unavailable');
    expect(read('small')).toEqual(unified().use(remarkParse).parse('small'));
  });

  it('retries input after a parser failure', () => {
    const { read, unavailable } = fixture();
    unavailable.add('recover');
    expect(() => read('recover')).toThrow('Parser unavailable');
    unavailable.clear();
    expect(read('recover')).toEqual(unified().use(remarkParse).parse('recover'));
  });

  it('keeps separate parser configurations independent', () => {
    const gfm = unified().use(remarkParse).use(remarkGfm).use(createMarkdownParseCache());
    const plain = unified().use(remarkParse).use(createMarkdownParseCache());
    const source = '~~deleted~~';
    expect(gfm.parse(source)).not.toEqual(plain.parse(source));
    expect(gfm.parse(source)).toEqual(unified().use(remarkParse).use(remarkGfm).parse(source));
  });
});

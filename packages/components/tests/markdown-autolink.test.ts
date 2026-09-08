import { describe, it, expect } from 'vitest';

const AUTOLINK_PATTERN = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/giu;

const NON_ASCII_URL_BOUNDARY = /(?!\p{ASCII})[\p{P}\p{Z}]/u;

const countChar = (value: string, char: string) =>
  Array.from(value).reduce((count, current) => count + (current === char ? 1 : 0), 0);

const splitAutolinkTrailing = (value: string) => {
  const boundary = value.search(NON_ASCII_URL_BOUNDARY);
  let url = boundary >= 0 ? value.slice(0, boundary) : value;
  let trailing = boundary >= 0 ? value.slice(boundary) : '';

  while (url.length > 0) {
    const last = url.at(-1);
    if (!last) break;

    if (last === ')' && countChar(url, ')') <= countChar(url, '(')) break;
    if (last === ']' && countChar(url, ']') <= countChar(url, '[')) break;
    if (last === '}' && countChar(url, '}') <= countChar(url, '{')) break;

    if (!/[\]})"'.,:;!?]/u.test(last)) break;

    trailing = `${last}${trailing}`;
    url = url.slice(0, -1);
  }

  return { url, trailing };
};

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  url?: string;
  title?: string | null;
};

const linkifyTextValue = (value: string): MdastNode[] => {
  const result: MdastNode[] = [];
  AUTOLINK_PATTERN.lastIndex = 0;

  let cursor = 0;
  let match = AUTOLINK_PATTERN.exec(value);
  if (!match) {
    return [{ type: 'text', value }];
  }

  while (match) {
    const rawUrl = match[0];
    const matchStart = match.index;
    const matchEnd = matchStart + rawUrl.length;

    if (matchStart > cursor) {
      result.push({ type: 'text', value: value.slice(cursor, matchStart) });
    }

    const { url, trailing } = splitAutolinkTrailing(rawUrl);
    if (url.length === 0) {
      result.push({ type: 'text', value: rawUrl });
    } else {
      const href = url.startsWith('www.') ? `https://${url}` : url;
      result.push({
        type: 'link',
        url: href,
        title: null,
        children: [{ type: 'text', value: url }],
      });

      if (trailing.length > 0) {
        result.push({ type: 'text', value: trailing });
      }
    }

    cursor = matchEnd;
    match = AUTOLINK_PATTERN.exec(value);
  }

  if (cursor < value.length) {
    result.push({ type: 'text', value: value.slice(cursor) });
  }

  return result;
};

const linkifyInlineCode = (value: string): MdastNode[] => {
  AUTOLINK_PATTERN.lastIndex = 0;
  if (!AUTOLINK_PATTERN.test(value)) {
    return [{ type: 'inlineCode', value }];
  }

  const linkified = linkifyTextValue(value);
  return linkified.map((n) => {
    if (n.type === 'link') {
      return {
        ...n,
        children: [{ type: 'inlineCode', value: (n.children?.[0] as MdastNode)?.value }],
      };
    }
    return { type: 'inlineCode', value: n.value };
  });
};

describe('AUTOLINK_PATTERN', () => {
  it('should match GitHub PR URLs', () => {
    const text = 'https://github.com/loro-dev/lody/pull/602';
    AUTOLINK_PATTERN.lastIndex = 0;
    const matches = text.match(AUTOLINK_PATTERN);
    expect(matches).toEqual(['https://github.com/loro-dev/lody/pull/602']);
  });

  it('should match GitHub issue URLs', () => {
    const text = 'https://github.com/loro-dev/lody/issues/123';
    AUTOLINK_PATTERN.lastIndex = 0;
    const matches = text.match(AUTOLINK_PATTERN);
    expect(matches).toEqual(['https://github.com/loro-dev/lody/issues/123']);
  });

  it('should match GitHub repo URLs', () => {
    const text = 'https://github.com/loro-dev/lody';
    AUTOLINK_PATTERN.lastIndex = 0;
    const matches = text.match(AUTOLINK_PATTERN);
    expect(matches).toEqual(['https://github.com/loro-dev/lody']);
  });

  it('should match multiple GitHub URLs in one line', () => {
    const text =
      'Check https://github.com/loro-dev/lody/pull/602 and https://github.com/loro-dev/lody/pull/603';
    AUTOLINK_PATTERN.lastIndex = 0;
    const matches = text.match(AUTOLINK_PATTERN);
    expect(matches).toEqual([
      'https://github.com/loro-dev/lody/pull/602',
      'https://github.com/loro-dev/lody/pull/603',
    ]);
  });

  it('should match URLs embedded in text', () => {
    const text = 'A PR link: https://github.com/loro-dev/lody/pull/602';
    AUTOLINK_PATTERN.lastIndex = 0;
    const matches = text.match(AUTOLINK_PATTERN);
    expect(matches).toEqual(['https://github.com/loro-dev/lody/pull/602']);
  });
});

describe('splitAutolinkTrailing', () => {
  it('should strip trailing period from GitHub URL', () => {
    const result = splitAutolinkTrailing('https://github.com/loro-dev/lody/pull/602.');
    expect(result).toEqual({
      url: 'https://github.com/loro-dev/lody/pull/602',
      trailing: '.',
    });
  });

  it('should strip trailing comma from GitHub URL', () => {
    const result = splitAutolinkTrailing('https://github.com/loro-dev/lody/pull/602,');
    expect(result).toEqual({
      url: 'https://github.com/loro-dev/lody/pull/602',
      trailing: ',',
    });
  });

  it('should strip multiple trailing punctuation marks', () => {
    const result = splitAutolinkTrailing('https://github.com/loro-dev/lody/pull/602!?');
    expect(result).toEqual({
      url: 'https://github.com/loro-dev/lody/pull/602',
      trailing: '!?',
    });
  });

  it('should preserve balanced parentheses in URL', () => {
    const result = splitAutolinkTrailing('https://en.wikipedia.org/wiki/Test_(disambiguation)');
    expect(result).toEqual({
      url: 'https://en.wikipedia.org/wiki/Test_(disambiguation)',
      trailing: '',
    });
  });

  it('should strip unbalanced trailing parenthesis', () => {
    const result = splitAutolinkTrailing('https://github.com/loro-dev/lody)');
    expect(result).toEqual({
      url: 'https://github.com/loro-dev/lody',
      trailing: ')',
    });
  });

  it('should handle GitHub URL without trailing punctuation', () => {
    const result = splitAutolinkTrailing('https://github.com/loro-dev/lody/pull/602');
    expect(result).toEqual({
      url: 'https://github.com/loro-dev/lody/pull/602',
      trailing: '',
    });
  });

  it('should strip Chinese punctuation', () => {
    const result = splitAutolinkTrailing('https://github.com/loro-dev/lody/pull/602。');
    expect(result).toEqual({
      url: 'https://github.com/loro-dev/lody/pull/602',
      trailing: '。',
    });
  });

  it('should end the URL at Chinese punctuation followed by more prose', () => {
    const result = splitAutolinkTrailing('https://github.com/loro-dev/lody/pull/602，分支');
    expect(result).toEqual({
      url: 'https://github.com/loro-dev/lody/pull/602',
      trailing: '，分支',
    });
  });

  it('should keep non-ASCII letters inside the URL path', () => {
    const result = splitAutolinkTrailing('https://zh.example.com/wiki/中文');
    expect(result).toEqual({
      url: 'https://zh.example.com/wiki/中文',
      trailing: '',
    });
  });
});

describe('linkifyTextValue', () => {
  it('should return text node for non-URL text', () => {
    const result = linkifyTextValue('hello world');
    expect(result).toEqual([{ type: 'text', value: 'hello world' }]);
  });

  it('should convert GitHub URL to link node', () => {
    const result = linkifyTextValue('https://github.com/loro-dev/lody/pull/602');
    expect(result).toEqual([
      {
        type: 'link',
        url: 'https://github.com/loro-dev/lody/pull/602',
        title: null,
        children: [{ type: 'text', value: 'https://github.com/loro-dev/lody/pull/602' }],
      },
    ]);
  });

  it('should handle URL with surrounding text', () => {
    const result = linkifyTextValue('Check https://github.com/loro-dev/lody/pull/602 now');
    expect(result).toEqual([
      { type: 'text', value: 'Check ' },
      {
        type: 'link',
        url: 'https://github.com/loro-dev/lody/pull/602',
        title: null,
        children: [{ type: 'text', value: 'https://github.com/loro-dev/lody/pull/602' }],
      },
      { type: 'text', value: ' now' },
    ]);
  });
});

describe('linkifyInlineCode', () => {
  it('should return inlineCode node for non-URL code', () => {
    const result = linkifyInlineCode('const x = 1');
    expect(result).toEqual([{ type: 'inlineCode', value: 'const x = 1' }]);
  });

  it('should convert GitHub URL in inline code to link with inlineCode child', () => {
    const result = linkifyInlineCode('https://github.com/loro-dev/lody/pull/602');
    expect(result).toEqual([
      {
        type: 'link',
        url: 'https://github.com/loro-dev/lody/pull/602',
        title: null,
        children: [{ type: 'inlineCode', value: 'https://github.com/loro-dev/lody/pull/602' }],
      },
    ]);
  });

  it('should handle inline code URL with trailing punctuation', () => {
    const result = linkifyInlineCode('https://github.com/loro-dev/lody/pull/602.');
    expect(result).toEqual([
      {
        type: 'link',
        url: 'https://github.com/loro-dev/lody/pull/602',
        title: null,
        children: [{ type: 'inlineCode', value: 'https://github.com/loro-dev/lody/pull/602' }],
      },
      { type: 'inlineCode', value: '.' },
    ]);
  });
});

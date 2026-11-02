import * as old from './baseline';
import * as next from '../../src/lib/markdown-highlighter';
import { StreamTokenizer, type ThemedToken } from '@pierre/highlights';
import type { BundledLanguage } from 'shiki';
import diffViewerSource from '../../src/ui/diff-viewer/diff-viewer.tsx?raw';
const median = (samples: number[]) =>
  [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)];
export async function run() {
  const init = { shiki: [] as number[], highlights: [] as number[] };
  let a!: old.MarkdownHighlighter;
  let b!: next.MarkdownHighlighter;
  for (let i = 0; i < 7; i++) {
    let t = performance.now();
    a = await old.createMarkdownHighlighter();
    init.shiki.push(performance.now() - t);
    t = performance.now();
    b = await next.createMarkdownHighlighter();
    init.highlights.push(performance.now() - t);
    if (i < 6) {
      a.dispose();
    }
  }
  if (b.backend !== 'highlights') throw new Error('Benchmark requires WASM Highlights');
  const fixtures = {
    typescript:
      '// Unicode: 世界\nexport async function fetchItem(id: number): Promise<string> {\n  const value = await Promise.resolve(`item-${id}`);\n  return value.replace(/item/g, "result");\n}\n',
    python:
      '# Unicode: 世界\ndef fetch_item(value: int) -> str:\n    items = [str(i * 2) for i in range(value)]\n    return "result:" + ",".join(items)\n',
    rust: '// Unicode: 世界\nfn fetch_item(value: usize) -> String {\n    let items: Vec<_> = (0..value).map(|i| i * 2).collect();\n    format!("result: {:?}", items)\n}\n',
    json: '{"name":"世界","enabled":true,"values":[1,2,3],"nested":{"count":42}}\n',
  };
  const rows = [];
  const cases = Object.entries(fixtures).flatMap(([lang, unit]) =>
    [2048, 20480, 204800].map((target) => ({
      lang,
      code: unit.repeat(Math.ceil(target / unit.length)),
      fixture: 'synthetic',
    }))
  );
  cases.push({ lang: 'tsx', code: diffViewerSource, fixture: 'Lody DiffViewer' });
  for (const { lang, code, fixture } of cases) {
    const times = [[], []] as number[][];
    let counts = [];
    const fns = [
      () => old.tokenizeMarkdownCode(a, code, lang as BundledLanguage),
      () => next.tokenizeMarkdownCode(b, code, lang as BundledLanguage),
    ];
    for (let k = 0; k < 2; k++) {
      const r = fns[k]();
      if (r.tokens.map((l) => l.map((t) => t.content).join('')).join('\n') !== code)
        throw Error('source mismatch ' + lang);
      counts[k] = r.tokens.reduce((n, l) => n + l.length, 0);
    }
    for (let i = 0; i < 13; i++)
      for (const k of i % 2 ? [1, 0] : [0, 1]) {
        const t = performance.now();
        const batch = code.length < 4096 ? 10 : 1;
        for (let j = 0; j < batch; j++) fns[k]();
        if (i >= 3) times[k].push((performance.now() - t) / batch);
      }
    rows.push({
      lang,
      fixture,
      samplesMs: times,
      chars: code.length,
      shikiMs: median(times[0]),
      highlightsMs: median(times[1]),
      tokens: counts,
    });
  }
  const code = fixtures.typescript.repeat(120);
  const chunks = code.match(/[\s\S]{1,256}/g)!;
  const streaming = [[], [], []] as number[][];
  for (let i = 0; i < 8; i++)
    for (const k of i % 2 ? [2, 1, 0] : [0, 1, 2]) {
      let prefix = '';
      const t = performance.now();
      if (k === 2) {
        const s = new StreamTokenizer({
          lang: 'typescript',
          themes: { light: b.theme, dark: b.theme },
        });
        const lines: ThemedToken[][] = [];
        try {
          for (const chunk of chunks) lines.push(...s.pushCode(chunk));
          lines.push(...s.end());
          if (lines.map((l) => l.map((token) => token.content).join('')).join('\n') !== code)
            throw Error('stream source mismatch');
        } finally {
          s.dispose();
        }
      } else
        for (const chunk of chunks) {
          prefix += chunk;
          if (k === 0) old.tokenizeMarkdownCode(a, prefix, 'typescript');
          else next.tokenizeMarkdownCode(b, prefix, 'typescript');
        }
      if (i >= 2) streaming[k].push(performance.now() - t);
    }
  a.dispose();
  return {
    userAgent: navigator.userAgent,
    init,
    initMedian: {
      shiki: median(init.shiki.slice(1)),
      highlights: median(init.highlights.slice(1)),
    },
    rows,
    stream: {
      samplesMs: streaming,
      chars: code.length,
      chunks: chunks.length,
      shikiMs: median(streaming[0]),
      highlightsMs: median(streaming[1]),
      incrementalMs: median(streaming[2]),
    },
  };
}

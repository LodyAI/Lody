import { describe, expect, it } from 'vitest';
import {
  callValue,
  compileSurface,
  compileSurfacePartial,
  createSurface,
  evaluate,
  evalValue,
  surfaceScope,
} from '../src/index.js';
import type { UiElement, UiText } from '../src/index.js';
import { Parser } from 'acorn';

const expr = (src: string) =>
  Parser.parseExpressionAt(src, 0, {
    ecmaVersion: 'latest',
  }) as never as import('../src/index.js').AstNode;

const run = (src: string, scope: Record<string, unknown> = {}, globals?: Record<string, unknown>) =>
  evaluate(expr(src), scope, { globals });

describe('evaluate', () => {
  it('evaluates arithmetic, ternaries and templates', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('enabled ? "On" : "Off"', { enabled: false })).toBe('Off');
    expect(run('`进度：${value}%`', { value: 42 })).toBe('进度：42%');
  });

  it('evaluates arrow functions, calls and array methods', () => {
    const fn = run('(next) => next + 1');
    expect(typeof fn).toBe('object');
    expect(run('[1,2,3].map(x => x * 2)')).toEqual([2, 4, 6]);
    expect(run('items.filter(i => i.ok).length', { items: [{ ok: true }, { ok: false }] })).toBe(1);
    expect(run('(a, ...rest) => rest', {})).toBeTruthy();
  });

  it('supports closures over scope and local statements in block bodies', () => {
    const handler = run('(v) => { const d = v * 2; setValue(d); }', {
      setValue: (v: number) => {
        captured = v;
      },
    });
    let captured = -1;
    void handler;
    run('handler(21)', { handler, setValue: (v: number) => (captured = v) });
    expect(captured).toBe(42);
  });

  it('denies ambient and reflection access', () => {
    expect(() => run('window.fetch("x")')).toThrow();
    expect(() => run('({}).constructor.constructor')).toThrow();
    expect(() => run('[].__proto__')).toThrow();
    expect(() => run('process.env')).toThrow();
    expect(() => run('(async () => 1)()')).toThrow();
  });

  it('enforces a step budget on runaway programs', () => {
    expect(() => run('(() => { while (true) {} })()')).toThrow(/budget/);
  });
});

describe('compileSurface', () => {
  it('splits {@state} directives from the view', () => {
    const program = compileSurface(
      '{@state const [v, setV] = useState(65)}\n<card><text>{v}%</text></card>'
    );
    expect(program.diagnostics).toEqual([]);
    expect(program.declarations).toHaveLength(1);
    expect(program.declarations[0].name).toBe('v');
    expect(program.declarations[0].setter).toBe('setV');
    expect(program.view.kind).toBe('element');
  });

  it('reports malformed markup instead of throwing', () => {
    const program = compileSurface('<card><oops');
    expect(program.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('compileSurfacePartial', () => {
  const kids = (node: UiElement) => node.children;

  it('compiles a complete source identically to compileSurface', () => {
    const source = '{@state const [v, setV] = useState(65)}\n<card><text>{v}%</text></card>';
    const partial = compileSurfacePartial(source);
    expect(partial.pending).toBe('');
    expect(partial.declarations).toHaveLength(1);
    expect((kids(partial.view as UiElement)[0] as UiElement).tag).toBe('card');
  });

  it('mounts an element once its open tag closes and streams children in', () => {
    const partial = compileSurfacePartial('<card><text>hello</text>');
    expect(partial.pending).toBe('');
    const card = kids(partial.view as UiElement)[0] as UiElement;
    expect(card.tag).toBe('card');
    expect((card.children[0] as UiElement).tag).toBe('text');
  });

  it('holds a truncated open tag as pending instead of mounting it', () => {
    const partial = compileSurfacePartial('<card>done</card><slider value={v');
    const card = kids(partial.view as UiElement)[0] as UiElement;
    expect(card.tag).toBe('card');
    expect(kids(partial.view as UiElement)).toHaveLength(1);
    expect(partial.pending).toContain('<slider');
  });

  it('holds an unterminated attribute string and an unclosed {@state} as pending', () => {
    const attr = compileSurfacePartial('<text label="abc');
    expect(attr.pending).toContain('<text');
    const directive = compileSurfacePartial('<text>ok</text>{@state const [v, setV] = useState(');
    expect(directive.pending).toContain('{@state');
    expect(directive.diagnostics).toEqual([]);
    expect((kids(directive.view as UiElement)[0] as UiElement).tag).toBe('text');
  });

  it('holds a half-written {expr} hole but commits the closed ones', () => {
    const partial = compileSurfacePartial('<text>{value * 2}</text>{valu');
    expect(partial.pending).toBe('{valu');
    const text = kids(partial.view as UiElement)[0] as UiElement;
    const parts = (text.children[0] as UiText).parts;
    expect(parts[0]).toMatchObject({ kind: 'expr' });
  });

  it('holds a half-written close tag as pending, never as text', () => {
    for (const tail of ['</', '</b', '</bad']) {
      const partial = compileSurfacePartial(`<badge>live${tail}`);
      expect(partial.pending).toBe(tail);
      const badge = kids(partial.view as UiElement)[0] as UiElement;
      expect((badge.children[0] as UiText).parts).toEqual(['live']);
    }
  });

  it('auto-closes inner elements when an outer close tag arrives', () => {
    const partial = compileSurfacePartial('<card><text>hi</card>');
    const card = kids(partial.view as UiElement)[0] as UiElement;
    expect((card.children[0] as UiElement).tag).toBe('text');
  });

  it('parses expression props and event arrows inside braces', () => {
    const partial = compileSurfacePartial('<slider value={v} onChange={(n) => setV(n + 1)} />');
    const slider = kids(partial.view as UiElement)[0] as UiElement;
    expect(slider.tag).toBe('slider');
    expect(slider.props.map((p) => p.name)).toEqual(['value', 'onChange']);
    expect(slider.props[1].value).toMatchObject({ kind: 'expr' });
  });

  it('keeps state already declared usable across partial recompiles', () => {
    const early = compileSurfacePartial('{@state const [v, setV] = useState(1)}\n<te');
    expect(early.declarations).toHaveLength(1);
    const later = compileSurfacePartial('{@state const [v, setV] = useState(1)}\n<text>{v}</text>');
    const surface = createSurface('s', later);
    expect(surfaceScope(surface).v).toBe(1);
  });
});

describe('createSurface', () => {
  const source =
    '{@state const [value, setValue] = useState(65)}\n' +
    '{@state const [enabled, setEnabled] = useState(true)}\n' +
    '<card><slider value={value} disabled={!enabled} /><button onClick={() => setValue(65)}>reset</button></card>';

  it('installs state and setters, evaluates props live', () => {
    const surface = createSurface('test', compileSurface(source));
    const scope = surfaceScope(surface);
    expect(scope.value).toBe(65);
    const card = (surface.program.view as import('../src/index.js').UiElement)
      .children[0] as import('../src/index.js').UiElement;
    const slider = card.children[0] as import('../src/index.js').UiElement;
    const disabled = slider.props.find((p) => p.name === 'disabled')!.value;
    expect(evalValue(disabled, scope)).toBe(false);
    (scope.setEnabled as (v: boolean) => void)(false);
    expect(evalValue(disabled, surfaceScope(surface))).toBe(true);
  });

  it('notifies subscribers and supports updater arrows', () => {
    const surface = createSurface('test', compileSurface(source));
    let notified = 0;
    surface.state.subscribe(() => (notified += 1));
    const setValue = surfaceScope(surface).setValue as (v: unknown) => void;
    setValue(10);
    setValue((c: number) => c + 5);
    expect(surface.state.get('value')).toBe(15);
    expect(notified).toBe(2);
  });

  it('reaches host capabilities under lody, and absent members abort', () => {
    const capSource = '<card><button onClick={() => lody.sendPrompt("go")}>send</button></card>';
    const surface = createSurface('test', compileSurface(capSource));
    const sent: string[] = [];
    const scope = surfaceScope(surface, {
      lody: { sendPrompt: (text: string) => sent.push(text) },
    });
    const card = (surface.program.view as UiElement).children[0] as UiElement;
    const button = card.children[0] as UiElement;
    const onClick = button.props.find((p) => p.name === 'onClick')!.value;
    const fn = evalValue(onClick, scope);
    callValue(fn, undefined, []);
    expect(sent).toEqual(['go']);

    const emptyScope = surfaceScope(surface, { lody: {} });
    expect(() => callValue(evalValue(onClick, emptyScope), undefined, [])).toThrow();
  });
});

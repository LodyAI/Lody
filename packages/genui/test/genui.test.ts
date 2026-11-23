import { describe, expect, it } from 'vitest';
import { compileSurface, createSurface, evaluate, evalValue, surfaceScope } from '../src/index.js';
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
    // Call the arrow through a member-less call expression instead.
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
});

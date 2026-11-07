import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSource } from './design-system-audit.mjs';

await test('recognizes aliased StyleX state declarations and keeps non-StyleX objects out', () => {
  const result = auditSource(
    `
    import * as sx from '@stylexjs/stylex';
    const ordinary = { opacity: .6, color: '#fff' };
    const styles = sx.create({ row: {
      opacity: { default: 1, ':disabled': .6 },
      ':is([aria-disabled="true"])': { opacity: .5 },
      color: { default: 'var(--ink)', ':hover': 'color-mix(in oklab, var(--ink) 70%, transparent)' },
      boxShadow: '0 1px 3px #0003',
    } });
  `,
    'packages/components/src/components/shared/example.tsx'
  );
  assert.equal(result.parseErrors, 0);
  assert.deepEqual(
    result.findings.filter((f) => f.kind === 'opacity').map((f) => [f.value, f.role]),
    [
      ['1', 'unclassified'],
      ['.6', 'disabled'],
      ['.5', 'disabled'],
    ]
  );
  assert.equal(result.findings.filter((f) => f.kind === 'color-mix').length, 1);
  assert.equal(result.findings.filter((f) => f.kind === 'shadow').length, 1);
  assert.equal(result.findings.filter((f) => f.kind === 'literal-color').length, 1);
  assert.ok(result.findings.every((f) => f.namespace.startsWith('styles.row')));
});

await test('animation, artwork and drag alpha stay inventory candidates rather than violations', () => {
  const result = auditSource(
    `
    import { create as css, keyframes as motion } from '@stylexjs/stylex';
    const pulse = motion({ '50%': { opacity: .5 } });
    const styles = css({ dragging: { opacity: .6 }, icon: { opacity: .7 } });
  `,
    'packages/components/src/components/icons/drawing.tsx'
  );
  assert.deepEqual(
    result.findings.map((f) => f.role),
    ['animation', 'drag-feedback', 'artwork-candidate']
  );
  assert.ok(result.findings.every((f) => !('violation' in f)));
  assert.equal(result.findings[0].review, 'intentional-state-candidate');
});

await test('reports dynamic styles and spreads as unresolved without inventing values', () => {
  const result = auditSource(
    `
    import stylex from '@stylexjs/stylex';
    const styles = stylex.create({ row: { ...shared, opacity: enabled ? 1 : pendingOpacity } });
    const other = stylex.create(unknownStyles);
  `,
    'packages/components/src/stories/Example.stories.tsx'
  );
  assert.equal(result.unresolved, 2);
  assert.equal(result.findings[0].value, 'enabled ? 1 : pendingOpacity');
  assert.equal(result.findings[0].scope.kind, 'story');
});

await test('finds disabled ownership in variable groups and reports invalid syntax', () => {
  const result = auditSource(
    `
    import * as stylex from '@stylexjs/stylex';
    export const control = stylex.defineVars({ disabledOpacity: .45, shadow: 'none' });
  `,
    'packages/components/src/style/control.stylex.ts'
  );
  assert.equal(result.findings[0].scope.owner, 'style-definition');
  assert.equal(result.findings[0].role, 'disabled-candidate');
  assert.equal(result.findings[1].kind, 'shadow');
  assert.ok(auditSource('const broken = {').parseErrors > 0);
});

await test('distinguishes literal alpha color functions from semantic variable readers', () => {
  const result = auditSource(`
    import * as stylex from '@stylexjs/stylex';
    const styles = stylex.create({ ink: {
      color: 'hsl(var(--ink))',
      backgroundColor: 'rgba(20, 30, 40, .2)',
      borderColor: 'hsla(30, 90%, 40%, .7)',
    } });
  `);
  assert.deepEqual(
    result.findings.map((f) => f.property),
    ['backgroundColor', 'borderColor']
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseSplashOnTheme } from './startup-theme-core.ts';

function createRoot() {
  const classes = new Set();
  return {
    classList: { contains: (name) => classes.has(name), add: (name) => classes.add(name) },
  };
}

void test('releases the splash when the theme class lands, and only then', () => {
  const root = createRoot();
  let hidden = 0;
  let stopped = 0;
  let notify = () => {};

  releaseSplashOnTheme(
    root,
    (onMutation) => {
      notify = onMutation;
      return () => {
        stopped += 1;
      };
    },
    () => {
      hidden += 1;
    }
  );

  // A class change that is not the theme (e.g. `native-mobile-shell`) must not
  // drop the splash onto an unthemed page.
  root.classList.add('native-mobile-shell');
  notify();
  assert.equal(hidden, 0);

  root.classList.add('dark');
  notify();
  assert.equal(hidden, 1);
  assert.equal(stopped, 1);
});

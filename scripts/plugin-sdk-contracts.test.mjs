import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(repoRoot, 'scripts/fixtures/plugin-sdk');
const fromCli = createRequire(path.join(repoRoot, 'apps/cli/package.json'));
const requireShared = createRequire(path.join(repoRoot, 'packages/shared/package.json'));
const { build } = fromCli('esbuild');
const sdkRoot = path.join(repoRoot, 'packages/plugin-sdk');
async function loadExample(relativePath) {
  const result = await build({
    entryPoints: [path.join(fixtureDir, 'examples', relativePath)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    nodePaths: [path.join(repoRoot, 'apps/cli/node_modules'), path.join(sdkRoot, 'node_modules')],
  });
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`
    )
  ).default;
}

function verifyTsconfig(configFileName) {
  const configPath = path.join(fixtureDir, configFileName);
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(configFile.error, undefined, `Failed to read ${configFileName}`);

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, fixtureDir);
  assert.deepEqual(parsed.errors, [], `Unexpected ${configFileName} parse errors`);
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);

  if (diagnostics.length > 0) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => repoRoot,
      getNewLine: () => '\n',
    });
    assert.fail(`Plugin SDK typecheck failed (${configFileName}):\n${formatted}`);
  }
}

test('plugin SDK browser-pure client contracts and dogfood UI examples typecheck cleanly', () => {
  verifyTsconfig('tsconfig.json');
});

test('plugin SDK Node machine contracts and workspace examples typecheck without DOM globals', () => {
  verifyTsconfig('tsconfig.machine.json');
});

test('sound-effects client plugin composes events, assets.url, signal, and standard Web Audio without bespoke SDK slots', async () => {
  const listeners = new Map();
  const played = [];
  const createdClips = [];
  const prevAudio = globalThis.Audio;
  globalThis.Audio = class MockAudio {
    constructor(src) {
      this.src = src;
      this.volume = 1;
      this.paused = false;
      createdClips.push(this);
    }
    addEventListener() {}
    pause() {
      this.paused = true;
    }
    async play() {
      played.push({ src: this.src, volume: this.volume });
    }
  };

  try {
    const plugin = await loadExample('sound-effects/client.tsx');
    const abortController = new AbortController();
    const currentConfig = { pack: 'soft-wood', volume: 0.5, playOnSend: true };
    const cleanup = plugin.register({
      signal: abortController.signal,
      events: {
        on(type, fn) {
          listeners.set(type, fn);
          return () => listeners.delete(type);
        },
      },
      config: {
        get: () => currentConfig,
      },
      assets: {
        url: (relPath) => `lody-plugin://sound-effects/${relPath.replace(/^\.\//, '')}`,
      },
    });

    await listeners.get('ui.message.submitted')({});
    await listeners.get('session.turn.completed')({ stopReason: 'cancelled' });
    await listeners.get('session.turn.completed')({ stopReason: 'end_turn' });
    await listeners.get('session.waiting_input')({});

    assert.deepEqual(played, [
      {
        src: 'lody-plugin://sound-effects/assets/soft-wood-send.mp3',
        volume: 0.5,
      },
      {
        src: 'lody-plugin://sound-effects/assets/soft-wood-complete.mp3',
        volume: 0.5,
      },
      {
        src: 'lody-plugin://sound-effects/assets/soft-wood-question.mp3',
        volume: 0.5,
      },
    ]);

    abortController.abort();
    assert.ok(createdClips.every((clip) => clip.paused));

    cleanup();
    assert.equal(listeners.size, 0);
  } finally {
    globalThis.Audio = prevAudio;
  }
});

test('Sorbet preserves parent and signed origin and stores verifier status for a completed architect turn', async () => {
  function mountWorkflowInstance() {
    let startHook = null;
    const eventHandlers = new Map();
    const queries = new Map();

    function loadTs(relPath) {
      const fullPath = path.join(fixtureDir, relPath);
      const compiled = ts.transpileModule(readFileSync(fullPath, 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2023,
          esModuleInterop: true,
        },
      }).outputText;
      const mod = { exports: {} };
      new Function('require', 'module', 'exports', compiled)(
        (id) => {
          if (id.startsWith('node:')) return require(id);
          if (id === 'zod') return requireShared('zod');
          if (id === '@lody/plugin-sdk') {
            return {
              defineQuery: (scope, qid, sc) => ({ scope, id: qid, ...sc }),
            };
          }
          if (id === '@lody/plugin-sdk/machine') {
            return {
              defineMachinePlugin: (register) => ({ register }),
            };
          }
          if (id === './shared') {
            return loadTs('examples/sorbet-workflow/shared.ts');
          }
          throw new Error(`Unexpected import: ${id}`);
        },
        mod,
        mod.exports
      );
      return mod.exports;
    }

    loadTs('examples/sorbet-workflow/machine.ts').default.register({
      onStart(fn) {
        startHook = fn;
      },
      query(desc, fn) {
        queries.set(desc.id, fn);
      },
      mutation() {},
      tool() {},
      attachmentSource() {},
      events: {
        on(type, fn, options) {
          assert.equal(options?.resumeFromCursor, true);
          eventHandlers.set(type, fn);
        },
      },
    });
    return { startHook, eventHandlers, queries };
  }

  const session = { workspaceId: 'w', machineId: 'm', projectId: 'p', sessionId: 's' },
    project = { workspaceId: 'w', machineId: 'm', projectId: 'p' };
  const values = new Map(),
    calls = [];
  const ctx = {
    config: {},
    storage: values,
    lody: {
      sessions: {
        create: async (t, r) => {
          calls.push({ t, r });
          return { ...session, sessionId: 'v' };
        },
      },
    },
    invalidate() {},
  };
  const plugin = mountWorkflowInstance();
  const complete = plugin.eventHandlers.get('session.turn.completed');
  const event = { session, project, stopReason: 'end_turn', turnId: 't', userTurnId: 'u' };
  await complete(ctx, event);
  assert.equal(calls.length, 0);
  const architect = { ...event, agentRoleId: 'plugin:sorbet-workflow:sorbet-architect' };
  await complete(ctx, architect);
  await complete(ctx, architect);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].r, calls[1].r);
  assert.equal(calls[0].r.requestId, 'verify-s-t');
  assert.equal(calls[0].r.businessKey, 'verify/s/t');
  assert.equal(calls[0].r.roleId, 'plugin:sorbet-workflow:sorbet-verifier');
  assert.deepEqual(calls[0].r.skillIds, ['sorbet-verifier']);
  assert.deepEqual(calls[0].r.originTurn, { session, userTurnId: 'u' });
  assert.deepEqual(calls[0].r.parentSession, session);
  assert.deepEqual(calls[0].t, project);
  assert.deepEqual(await plugin.queries.get('workflow.status')({ ...ctx, target: session }), {
    lastVerifiedTurnId: 't',
    verifierSessionId: 'v',
  });
});
test('sorbet-workflow messages.renderBlock preserves interactive component state across incremental streaming updates under stable blockId', () => {
  const openedDrafts = [];
  // Minimal stateful hook harness keyed by stable blockId to verify Stateful Incremental Updates
  const hookStateByBlock = new Map();
  let currentBlockKey = null;

  const mockReact = {
    useState(initial) {
      if (!hookStateByBlock.has(currentBlockKey)) {
        hookStateByBlock.set(currentBlockKey, initial);
      }
      const setState = (updater) => {
        const prev = hookStateByBlock.get(currentBlockKey);
        const next = typeof updater === 'function' ? updater(prev) : updater;
        hookStateByBlock.set(currentBlockKey, next);
      };
      return [hookStateByBlock.get(currentBlockKey), setState];
    },
  };

  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
  };

  const source = readFileSync(path.join(fixtureDir, 'examples/sorbet-workflow/client.tsx'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(
    (id) => {
      if (id === 'react') return mockReact;
      if (id === 'react/jsx-runtime') return jsxRuntime;
      if (id === '@lody/ui') {
        return {
          Badge: 'Badge',
          Button: 'Button',
        };
      }
      if (id === '@lody/plugin-sdk/client') {
        return {
          defineClientPlugin: (register) => ({ register }),
          useLody: () => ({
            drafts: {
              open(target, draft) {
                openedDrafts.push({ target, draft });
              },
            },
          }),
        };
      }
      throw new Error(`Unexpected import: ${id}`);
    },
    mod,
    mod.exports
  );

  let registeredBlockSpec = null;
  mod.exports.default.register({
    tools: { matchRender() {} },
    messages: {
      renderBlock(spec) {
        registeredBlockSpec = spec;
      },
    },
    screens: { add() {} },
  });
  assert.ok(registeredBlockSpec);

  const session = {
    workspaceId: 'ws_1',
    machineId: 'm_1',
    sessionId: 'sess_1',
  };
  const project = {
    workspaceId: 'ws_1',
    machineId: 'm_1',
    projectId: 'proj_1',
  };
  const turnId = 'turn_99';
  const blockId = 'turn_99:block:0';

  function renderWithStableMount(props) {
    currentBlockKey = `${props.session.sessionId}:${props.blockId}:${registeredBlockSpec.id}`;
    return registeredBlockSpec.Component(props);
  }

  function findButtons(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (node.type === 'Button') out.push(node);
    const children = node.props?.children;
    if (Array.isArray(children)) {
      for (const c of children) findButtons(c, out);
    } else if (children) {
      findButtons(children, out);
    }
    return out;
  }

  // Chunk 1 (streaming: true): user selects "1. Audit schema" while Agent is still streaming!
  const tree1 = renderWithStableMount({
    turnId,
    blockId,
    language: 'sorbet-plan',
    code: '1. Audit schema',
    streaming: true,
    session,
    project,
    appendToDraft() {},
  });
  const step1Btn = findButtons(tree1)[0];
  step1Btn.props.onClick();

  // Chunk 2 (streaming: true -> false): Agent streams step 2 and closes fence; step 1 stays selected!
  const tree2 = renderWithStableMount({
    turnId,
    blockId,
    language: 'sorbet-plan',
    code: '1. Audit schema\n2. Ship migration',
    streaming: false,
    session,
    project,
    appendToDraft() {},
  });
  const buttonsAfterComplete = findButtons(tree2);
  assert.equal(buttonsAfterComplete.length, 3); // 2 step buttons + 1 Launch button
  buttonsAfterComplete[2].props.onClick();

  assert.equal(openedDrafts.length, 1);
  assert.match(
    openedDrafts[0].draft.prompt,
    /Execute approved plan \(turn_99:block:0\) from sess_1:\n1\. Audit schema$/
  );
});
test('issue-context pins through scoped host storage and its public descriptors', async () => {
  const plugin = await loadExample('issue-context/machine.ts');
  const queries = new Map(),
    mutations = new Map(),
    values = new Map();
  plugin.register({
    attachmentSource() {},
    query: (d, run) => queries.set(d.id, { d, run }),
    mutation: (d, run) => mutations.set(d.id, { d, run }),
  });
  const context = {
    target: { projectId: 'one' },
    signal: new AbortController().signal,
    config: { TRACKER_API_KEY: 'fixture' },
    invalidate() {},
    storage: {
      get: (key) => values.get(key),
      set: (key, value) => values.set(key, value),
      delete: (key) => values.delete(key),
    },
  };
  const pin = mutations.get('issues.togglePin'),
    list = queries.get('issues.list');
  const toggle = async (pinned) =>
    pin.d.output.parse(await pin.run(context, pin.d.input.parse({ issueId: 'iss_101', pinned })));
  const read = async (target) =>
    list.d.output.parse(await list.run({ ...context, target }, list.d.input.parse({})))[0].pinned;
  await toggle(true);
  assert.equal(await read(context.target), true);
  assert.equal(await read({ projectId: 'two' }), false);
  await toggle(false);
  assert.equal(await read(context.target), false);
});

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(repoRoot, 'scripts/fixtures/plugin-sdk');
const require = createRequire(import.meta.url);
const requireShared = createRequire(path.join(repoRoot, 'packages/shared/package.json'));

function verifyTsconfig(configFileName, minFiles) {
  const configPath = path.join(fixtureDir, configFileName);
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(configFile.error, undefined, `Failed to read ${configFileName}`);

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, fixtureDir);
  assert.deepEqual(parsed.errors, [], `Unexpected ${configFileName} parse errors`);
  assert.ok(
    parsed.fileNames.length >= minFiles,
    `Expected at least ${minFiles} files in ${configFileName}, got ${parsed.fileNames.length}`
  );

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
  verifyTsconfig('tsconfig.json', 11);
});

test('plugin SDK Node machine contracts and durable dataDir examples typecheck without DOM globals', () => {
  verifyTsconfig('tsconfig.machine.json', 9);
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
    const source = readFileSync(path.join(fixtureDir, 'examples/sound-effects/client.tsx'), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2023,
      },
    }).outputText;
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', compiled)(
      (id) => {
        if (id === '@lody/plugin-sdk/client') {
          return { defineClientPlugin: (register) => ({ register }) };
        }
        throw new Error(`Unexpected import: ${id}`);
      },
      mod,
      mod.exports
    );

    const abortController = new AbortController();
    const currentConfig = { pack: 'soft-wood', volume: 0.5, playOnSend: true };
    const cleanup = mod.exports.default.register({
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

test('sorbet-workflow reconciles both mid-call crashes and missed turn.completed events across daemon restart while preserving ProjectRef, parentSession, and E2EE originTurn', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-sorbet-workflow-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const mockLodyQueries = {
    sessions: { kind: 'lody-query', scope: 'machine', id: 'sessions' },
    sessionTurns: { kind: 'lody-query', scope: 'session', id: 'sessionTurns' },
  };

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
              lodyQueries: mockLodyQueries,
              defineQuery: (scope, qid, sc) => ({ scope, id: qid, ...sc }),
            };
          }
          if (id === '@lody/plugin-sdk/machine') {
            return {
              lodyQueries: mockLodyQueries,
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
        on(type, fn) {
          eventHandlers.set(type, fn);
        },
      },
    });
    return { startHook, eventHandlers, queries };
  }

  const machineRef = { workspaceId: 'ws_1', machineId: 'm_1' };
  const projectRef = {
    workspaceId: 'ws_1',
    machineId: 'm_1',
    projectId: 'proj_sorbet',
  };
  const sessionArch1 = {
    workspaceId: 'ws_1',
    machineId: 'm_1',
    sessionId: 'sess_arch_1',
    projectId: 'proj_sorbet',
  };
  const sessionArch2 = {
    workspaceId: 'ws_1',
    machineId: 'm_1',
    sessionId: 'sess_arch_2',
    projectId: 'proj_sorbet',
  };

  // Simulated durable Lody session + turn history on the daemon
  const storedSessions = [
    {
      session: sessionArch1,
      project: projectRef,
      agentRoleId: 'plugin:sorbet-workflow:sorbet-architect',
      updatedAt: 1_000,
    },
    {
      session: sessionArch2,
      project: projectRef,
      agentRoleId: 'plugin:sorbet-workflow:sorbet-architect',
      updatedAt: 2_000,
    },
  ];
  const storedTurnsBySession = new Map([
    [
      'sess_arch_1',
      [
        {
          turnId: 'turn_42',
          role: 'assistant',
          userTurnId: 'user_turn_7',
          previewText: 'Plan A',
          createdAt: 1_000,
          finished: true,
          stopReason: 'end_turn',
        },
      ],
    ],
    [
      'sess_arch_2',
      [
        // Completed while daemon was down -> session.turn.completed event was NEVER delivered!
        {
          turnId: 'turn_43',
          role: 'assistant',
          userTurnId: 'user_turn_9',
          previewText: 'Plan B',
          createdAt: 2_000,
          finished: true,
          stopReason: 'end_turn',
        },
        // Cancelled turn must NOT spawn a verifier
        {
          turnId: 'turn_44_cancelled',
          role: 'assistant',
          userTurnId: 'user_turn_10',
          previewText: 'Aborted',
          createdAt: 2_100,
          finished: true,
          stopReason: 'cancelled',
        },
      ],
    ],
  ]);

  const receipts = new Map();
  const createCalls = [];
  let crashDuringFirstCreate = true;

  const hostLody = {
    async read(target, query, input = {}) {
      if (query.id === 'sessions') {
        let items = storedSessions;
        if (input.sessionIds) {
          const allow = new Set(input.sessionIds);
          items = items.filter((it) => allow.has(it.session.sessionId));
        }
        if (input.agentRoleId) {
          items = items.filter((it) => it.agentRoleId === input.agentRoleId);
        }
        if (typeof input.updatedAfter === 'number') {
          items = items.filter((it) => it.updatedAt >= input.updatedAfter);
        }
        return { items };
      }
      if (query.id === 'sessionTurns') {
        return { items: storedTurnsBySession.get(target.sessionId) ?? [] };
      }
      throw new Error(`Unexpected query: ${query.id}`);
    },
    unstable: {
      async readSnapshot() {
        return Object.freeze({
          schemaVersion: 1,
          revision: 'r1',
          doc: Object.freeze({
            agentRoleId: 'plugin:sorbet-workflow:sorbet-architect',
          }),
        });
      },
    },
    sessions: {
      async create(target, req) {
        createCalls.push({ target, req });
        if (!receipts.has(req.requestId)) {
          receipts.set(req.requestId, {
            target,
            payloadJson: JSON.stringify(req),
            ref: {
              workspaceId: 'ws_1',
              machineId: 'm_1',
              projectId: target.projectId,
              sessionId: `verifier_for_${req.requestId}`,
            },
          });
        } else {
          const prior = receipts.get(req.requestId);
          assert.deepEqual(
            target,
            prior.target,
            'Replay must target the exact original ProjectRef/MachineRef'
          );
          assert.equal(
            JSON.stringify(req),
            prior.payloadJson,
            'Replay must preserve identical normalized payload (including parentSession & originTurn)'
          );
        }
        if (crashDuringFirstCreate) {
          crashDuringFirstCreate = false;
          throw Object.assign(new Error('daemon_interrupted'), {
            code: 'outcome_unknown',
          });
        }
        return receipts.get(req.requestId).ref;
      },
    },
  };

  // Generation 1:
  // - sess_arch_1 turn_42 fires live event, writes journal intent, then crashes mid-create (outcome_unknown)
  // - sess_arch_2 turn_43 finishes right as daemon exits BEFORE any event reaches the plugin!
  const gen1 = mountWorkflowInstance();
  await assert.rejects(
    gen1.eventHandlers.get('session.turn.completed')(
      {
        machine: machineRef,
        dataDir,
        config: { autoVerify: true },
        invalidate() {},
        lody: hostLody,
      },
      {
        workspace: { workspaceId: 'ws_1' },
        machine: machineRef,
        session: sessionArch1,
        project: projectRef,
        turnId: 'turn_42',
        userTurnId: 'user_turn_7',
        stopReason: 'end_turn',
      }
    ),
    { code: 'outcome_unknown' }
  );

  // Generation 2 (Daemon Restart):
  // machine.onStart must recover turn_42 (with ProjectRef + parentSession + originTurn) AND discover missed turn_43!
  const gen2 = mountWorkflowInstance();
  await gen2.startHook({
    workspace: { workspaceId: 'ws_1' },
    machine: machineRef,
    dataDir,
    config: { autoVerify: true },
    invalidate() {},
    lody: hostLody,
  });

  assert.equal(receipts.size, 2);
  // Verify both recovered verifiers preserved exact ProjectRef, parentSession, verifier role, and E2EE originTurn
  const turn42Replay = createCalls[1];
  assert.deepEqual(turn42Replay.target, projectRef);
  assert.deepEqual(turn42Replay.req.parentSession, sessionArch1);
  assert.deepEqual(turn42Replay.req.originTurn, {
    session: sessionArch1,
    userTurnId: 'user_turn_7',
  });
  assert.equal(turn42Replay.req.roleId, 'plugin:sorbet-workflow:sorbet-verifier');

  const turn43MissedRecovery = createCalls[2];
  assert.deepEqual(turn43MissedRecovery.target, projectRef);
  assert.deepEqual(turn43MissedRecovery.req.parentSession, sessionArch2);
  assert.deepEqual(turn43MissedRecovery.req.originTurn, {
    session: sessionArch2,
    userTurnId: 'user_turn_9',
  });

  assert.deepEqual(
    await gen2.queries.get('workflow.status')({
      dataDir,
      target: sessionArch1,
    }),
    {
      lastVerifiedTurnId: 'turn_42',
      verifierSessionId: 'verifier_for_verify-sess_arch_1-turn_42',
    }
  );
  assert.deepEqual(
    await gen2.queries.get('workflow.status')({
      dataDir,
      target: sessionArch2,
    }),
    {
      lastVerifiedTurnId: 'turn_43',
      verifierSessionId: 'verifier_for_verify-sess_arch_2-turn_43',
    }
  );

  // Generation 3 (Subsequent Restart with no new turns): zero duplicate session creations
  const countBeforeGen3 = createCalls.length;
  const gen3 = mountWorkflowInstance();
  await gen3.startHook({
    workspace: { workspaceId: 'ws_1' },
    machine: machineRef,
    dataDir,
    config: { autoVerify: true },
    invalidate() {},
    lody: hostLody,
  });
  assert.equal(createCalls.length, countBeforeGen3);
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

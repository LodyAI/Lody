import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtureDir = path.join(repoRoot, "scripts/fixtures/plugin-sdk");
const require = createRequire(import.meta.url);
const requireShared = createRequire(
  path.join(repoRoot, "packages/shared/package.json"),
);

function verifyTsconfig(configFileName, minFiles) {
  const configPath = path.join(fixtureDir, configFileName);
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(configFile.error, undefined, `Failed to read ${configFileName}`);

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    fixtureDir,
  );
  assert.deepEqual(
    parsed.errors,
    [],
    `Unexpected ${configFileName} parse errors`,
  );
  assert.ok(
    parsed.fileNames.length >= minFiles,
    `Expected at least ${minFiles} files in ${configFileName}, got ${parsed.fileNames.length}`,
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
      getNewLine: () => "\n",
    });
    assert.fail(
      `Plugin SDK typecheck failed (${configFileName}):\n${formatted}`,
    );
  }
}

test("plugin SDK browser-pure client contracts and dogfood UI examples typecheck cleanly", () => {
  verifyTsconfig("tsconfig.json", 11);
});

test("plugin SDK Node machine contracts and durable dataDir examples typecheck without DOM globals", () => {
  verifyTsconfig("tsconfig.machine.json", 9);
});

// The runtime SDK is still a proposal. Supply its registration functions while
// executing the actual fixture modules, their Zod schemas, handlers and file I/O.
function loadIssueMachine(io = fs) {
  const mutations = new Map();
  const modules = new Map();
  const sdk = {
    defineQuery: (scope, id, schemas) => ({ scope, id, ...schemas }),
    defineMutation: (scope, id, schemas) => ({ scope, id, ...schemas }),
    defineAttachmentSource: (id, spec) => ({ id, ...spec }),
  };
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    const source = readFileSync(file, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2023,
        esModuleInterop: true,
      },
    }).outputText;
    const fixtureRequire = (id) => {
      if (id === "node:fs/promises") return io;
      if (id.startsWith("node:")) return require(id);
      if (id === "zod") return requireShared("zod");
      if (id === "@lody/plugin-sdk") return sdk;
      if (id === "@lody/plugin-sdk/machine") {
        return { defineMachinePlugin: (register) => ({ register }) };
      }
      if (id.startsWith("./"))
        return load(path.resolve(path.dirname(file), `${id}.ts`));
      throw new Error(`Unexpected fixture dependency: ${id}`);
    };
    new Function("require", "module", "exports", compiled)(
      fixtureRequire,
      module,
      module.exports,
    );
    return module.exports;
  }
  load(
    path.join(fixtureDir, "examples/issue-context/machine.ts"),
  ).default.register({
    onStart() {},
    query() {},
    attachmentSource() {},
    tool() {},
    events: { on() {} },
    mutation(descriptor, handler) {
      mutations.set(descriptor.id, handler);
    },
  });
  return mutations.get("issues.togglePin");
}

async function issueStateFixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lody-plugin-issue-state-"),
  );
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return {
    dataDir,
    file: path.join(dataDir, "issue-context-state.json"),
    context: { dataDir, target: { projectId: "p" }, invalidate() {} },
  };
}

test("issue plugin initializes missing state and preserves all concurrent project pin changes", async (t) => {
  const { dataDir, file, context } = await issueStateFixture(t);
  // Immediate completions deterministically expose uncoordinated read/modify/write:
  // without the per-file queue, concurrent handlers all read before any writes.
  const mutate = loadIssueMachine({
    ...fs,
    async readFile(...args) {
      return readFileSync(...args);
    },
    async mkdir(...args) {
      return mkdirSync(...args);
    },
    async writeFile(...args) {
      return writeFileSync(...args);
    },
    async rename(...args) {
      return renameSync(...args);
    },
  });
  const legacyTemp = `${file}.tmp`;
  await fs.writeFile(legacyTemp, "unrelated temporary file");
  const results = await Promise.all([
    mutate(context, { issueId: "A", pinned: true }),
    mutate(context, { issueId: "B", pinned: true }),
    mutate(
      { ...context, target: { projectId: "q" } },
      { issueId: "C", pinned: true },
    ),
  ]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {
    pinnedByProject: { p: ["A", "B"], q: ["C"] },
    linkedBySession: {},
  });
  assert.equal(
    await fs.readFile(legacyTemp, "utf8"),
    "unrelated temporary file",
  );
  assert.deepEqual(
    (await fs.readdir(dataDir)).sort(),
    [path.basename(file), path.basename(legacyTemp)].sort(),
  );
});

test("issue plugin preserves stored state on read or parse failures", async (t) => {
  for (const code of ["EACCES", "EIO"]) {
    await t.test(code, async (t) => {
      const { file, context } = await issueStateFixture(t);
      const original = JSON.stringify({
        pinnedByProject: { p: ["A"] },
        linkedBySession: { s: "ISSUE-A" },
      });
      await fs.writeFile(file, original);
      const failure = Object.assign(new Error(`Injected ${code}`), { code });
      let fail = true;
      const mutate = loadIssueMachine({
        ...fs,
        async readFile(...args) {
          if (fail) {
            fail = false;
            throw failure;
          }
          return fs.readFile(...args);
        },
      });
      await assert.rejects(
        mutate(context, { issueId: "B", pinned: true }),
        (error) => error === failure,
      );
      assert.equal(await fs.readFile(file, "utf8"), original);
      // Failure must release the queue and keep the original state available.
      await mutate(context, { issueId: "B", pinned: true });
      assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {
        pinnedByProject: { p: ["A", "B"] },
        linkedBySession: { s: "ISSUE-A" },
      });
    });
  }
  for (const original of [
    "invalid JSON",
    '{"pinnedByProject":{"p":42},"linkedBySession":{}}',
  ]) {
    await t.test(original, async (t) => {
      const { file, context } = await issueStateFixture(t);
      await fs.writeFile(file, original);
      await assert.rejects(
        loadIssueMachine()(context, { issueId: "B", pinned: true }),
      );
      assert.equal(await fs.readFile(file, "utf8"), original);
    });
  }
});

test("issue plugin preserves committed data and remains usable after failed temporary writes or replacement", async (t) => {
  for (const operation of ["writeFile", "rename"]) {
    await t.test(operation, async (t) => {
      const { dataDir, file, context } = await issueStateFixture(t);
      const original = JSON.stringify({
        pinnedByProject: { p: ["A"] },
        linkedBySession: { s: "ISSUE-A" },
      });
      await fs.writeFile(file, original);
      const failure = Object.assign(
        new Error(`Injected ${operation} failure`),
        { code: "EIO" },
      );
      let fail = true;
      const mutate = loadIssueMachine({
        ...fs,
        async [operation](...args) {
          if (fail) {
            fail = false;
            if (operation === "writeFile") await fs.writeFile(...args);
            throw failure;
          }
          return fs[operation](...args);
        },
      });
      await assert.rejects(
        mutate(context, { issueId: "B", pinned: true }),
        (error) => error === failure,
      );
      assert.equal(await fs.readFile(file, "utf8"), original);
      assert.deepEqual(await fs.readdir(dataDir), [path.basename(file)]);
      await mutate(context, { issueId: "B", pinned: true });
      assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {
        pinnedByProject: { p: ["A", "B"] },
        linkedBySession: { s: "ISSUE-A" },
      });
    });
  }
});

test("sound-effects client plugin subscribes to host events, plays configured cues, and cleans up subscriptions", async () => {
  const listeners = new Map();
  const played = [];
  const source = readFileSync(
    path.join(fixtureDir, "examples/sound-effects/client.tsx"),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
    },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (id) => {
      if (id === "@lody/plugin-sdk/client") {
        return { defineClientPlugin: (register) => ({ register }) };
      }
      throw new Error(`Unexpected import: ${id}`);
    },
    mod,
    mod.exports,
  );

  let currentConfig = { pack: "soft-wood", volume: 0.5, playOnSend: true };
  const cleanup = mod.exports.default.register({
    events: {
      on(type, fn) {
        listeners.set(type, fn);
        return () => listeners.delete(type);
      },
    },
    config: {
      get: () => currentConfig,
    },
    audio: {
      async play(asset, opts) {
        played.push({ asset, ...opts });
      },
    },
  });

  await listeners.get("ui.message.submitted")({});
  await listeners.get("session.turn.completed")({ stopReason: "cancelled" });
  await listeners.get("session.turn.completed")({ stopReason: "end_turn" });
  await listeners.get("session.waiting_input")({});

  assert.deepEqual(played, [
    { asset: "./assets/soft-wood-send.mp3", volume: 0.5 },
    { asset: "./assets/soft-wood-complete.mp3", volume: 0.5 },
    { asset: "./assets/soft-wood-question.mp3", volume: 0.5 },
  ]);

  cleanup();
  assert.equal(listeners.size, 0);
});

test("sorbet-workflow persists task progress to ctx.dataDir and recovers unfinished verifier sessions across daemon restart via machine.onStart", async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lody-sorbet-workflow-"),
  );
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  function mountWorkflowInstance() {
    let startHook = null;
    const eventHandlers = new Map();
    const queries = new Map();

    function loadTs(relPath) {
      const fullPath = path.join(fixtureDir, relPath);
      const compiled = ts.transpileModule(readFileSync(fullPath, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2023,
          esModuleInterop: true,
        },
      }).outputText;
      const mod = { exports: {} };
      new Function("require", "module", "exports", compiled)(
        (id) => {
          if (id.startsWith("node:")) return require(id);
          if (id === "zod") return requireShared("zod");
          if (id === "@lody/plugin-sdk") {
            return {
              defineQuery: (scope, qid, s) => ({ scope, id: qid, ...s }),
            };
          }
          if (id === "@lody/plugin-sdk/machine") {
            return { defineMachinePlugin: (register) => ({ register }) };
          }
          if (id === "./shared") {
            return loadTs("examples/sorbet-workflow/shared.ts");
          }
          throw new Error(`Unexpected import: ${id}`);
        },
        mod,
        mod.exports,
      );
      return mod.exports;
    }

    loadTs("examples/sorbet-workflow/machine.ts").default.register({
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

  const sessionRef = {
    workspaceId: "ws_1",
    machineId: "m_1",
    sessionId: "sess_arch_1",
  };
  const machineRef = { workspaceId: "ws_1", machineId: "m_1" };
  const receipts = new Map();
  let crashDuringFirstCreate = true;

  const hostSessions = {
    async create(_target, req) {
      // Simulate daemon/transport crash AFTER receipt or BEFOREplugin receives response
      if (!receipts.has(req.requestId)) {
        receipts.set(req.requestId, {
          ...sessionRef,
          sessionId: "sess_verifier_1",
        });
      }
      if (crashDuringFirstCreate) {
        crashDuringFirstCreate = false;
        throw Object.assign(new Error("daemon_interrupted"), {
          code: "outcome_unknown",
        });
      }
      return receipts.get(req.requestId);
    },
  };

  // Generation 1: turn completes, plugin writes intent to ctx.dataDir, then crashes mid-create
  const gen1 = mountWorkflowInstance();
  await assert.rejects(
    gen1.eventHandlers.get("session.turn.completed")(
      {
        dataDir,
        config: { autoVerify: true },
        invalidate() {},
        lody: {
          async readSnapshot() {
            return Object.freeze({
              schemaVersion: 1,
              revision: "r1",
              doc: Object.freeze({
                agentRoleId: "plugin:sorbet-workflow:sorbet-architect",
              }),
            });
          },
          sessions: hostSessions,
        },
      },
      {
        workspace: { workspaceId: "ws_1" },
        machine: machineRef,
        session: sessionRef,
        turnId: "turn_42",
        stopReason: "end_turn",
      },
    ),
    { code: "outcome_unknown" },
  );

  // Generation 2 (Daemon Restart): new subprocess boots, runs machine.onStart, and recovers idempotently
  const gen2 = mountWorkflowInstance();
  await gen2.startHook({
    workspace: { workspaceId: "ws_1" },
    machine: machineRef,
    dataDir,
    config: { autoVerify: true },
    invalidate() {},
    lody: { sessions: hostSessions },
  });

  assert.equal(receipts.size, 1);
  assert.deepEqual(
    await gen2.queries.get("workflow.status")({
      dataDir,
      target: sessionRef,
    }),
    {
      lastVerifiedTurnId: "turn_42",
      verifierSessionId: "sess_verifier_1",
    },
  );
});

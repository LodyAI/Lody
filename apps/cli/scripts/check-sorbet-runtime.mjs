import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';

const cliRoot = resolve(import.meta.dirname, '..');
const outputDirectoryFlag = process.argv.indexOf('--output-dir');
const outputDirectory = outputDirectoryFlag === -1 ? 'dist' : process.argv[outputDirectoryFlag + 1];
assert(outputDirectory, '--output-dir requires a path');
const outputRoot = resolve(cliRoot, outputDirectory);
const entry = join(outputRoot, 'sorbet/dist/stdio-cli.js');
const worker = join(outputRoot, 'sorbet/dist/filesystem-worker.js');
const providerControl = join(outputRoot, 'sorbet/dist/provider-control.js');
const packageBoundary = join(outputRoot, 'sorbet/package.json');
const vendorRoot = join(outputRoot, 'vendor');

assert(existsSync(entry), 'missing bundled Sorbet ACP entry');
assert(existsSync(worker), 'missing bundled Sorbet filesystem worker');
assert(existsSync(providerControl), 'missing bundled Sorbet Provider Center control entry');
assert(existsSync(packageBoundary), 'missing bundled Sorbet ESM package boundary');
for (const relativePath of [
  'seccomp/x64/apply-seccomp',
  'seccomp/arm64/apply-seccomp',
  'srt-win/x64/srt-win.exe',
  'srt-win/arm64/srt-win.exe',
]) {
  assert(existsSync(join(vendorRoot, relativePath)), `missing sandbox helper ${relativePath}`);
}

const version = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8' });
assert(version.status === 0, `bundled Sorbet --version failed: ${version.stderr}`);
assert(version.stdout.trim() === '0.0.0', 'bundled Sorbet reported an unexpected version');

const runSandboxLifecycle =
  process.platform === 'darwin' || process.env.LODY_SORBET_SANDBOX_SMOKE === '1';
if (runSandboxLifecycle) {
  await checkProviderCenterControl();
  await checkAcpLifecycle();
  await checkScriptedSessionLifecycle();
  console.log('Bundled Sorbet ACP lifecycle smoke passed.');
} else {
  await checkProviderCenterControl();
  console.log(
    'Bundled Sorbet package smoke passed; set LODY_SORBET_SANDBOX_SMOKE=1 on a prepared host to exercise ACP lifecycle.'
  );
}

async function checkProviderCenterControl() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'lody-sorbet-provider-center-smoke-'));
  const dataDirectory = join(dataRoot, 'agents', 'sorbet');
  try {
    const invoke = (request) => {
      const result = spawnSync(process.execPath, [providerControl], {
        cwd: dataRoot,
        env: {
          ...process.env,
          HOME: dataRoot,
          LODY_DATA_DIR: dataRoot,
          SORBET_DATA_DIR: dataDirectory,
        },
        input: JSON.stringify(request),
        encoding: 'utf8',
      });
      assert(result.status === 0, `bundled Sorbet Provider Center failed: ${result.stderr}`);
      return { encoded: result.stdout, value: JSON.parse(result.stdout) };
    };
    const response = invoke({ action: 'snapshot' }).value;
    assert(response.snapshot?.version === 1, 'Provider Center returned an unexpected version');
    assert(
      response.snapshot?.claudeOAuthEnabled === false,
      'Claude OAuth must default to disabled'
    );
    assert(
      response.snapshot?.providers?.some((provider) => provider.id === 'openai-codex'),
      'Provider Center is missing Codex OAuth'
    );
    assert(
      response.snapshot?.providers?.some(
        (provider) => provider.id === 'anthropic' && provider.enabled === false
      ),
      'Provider Center did not keep Claude OAuth disabled'
    );
    const created = invoke({
      action: 'create-custom',
      provider: {
        name: 'Package smoke Provider',
        protocol: 'openai-responses',
        baseUrl: 'https://example.invalid/v1',
        models: [{ id: 'package-smoke-model' }],
      },
    }).value;
    const providerId = created.affectedProviderId;
    assert(typeof providerId === 'string' && providerId.length > 0, 'custom Provider id missing');
    const secret = 'package-smoke-api-key';
    const credential = invoke({ action: 'set-api-key', providerId, apiKey: secret });
    assert(!credential.encoded.includes(secret), 'Provider Center echoed an API key');
    const selected = invoke({ action: 'set-default', providerId }).value;
    assert(selected.snapshot?.defaultProviderId === providerId, 'custom Provider was not selected');
    assert(
      selected.snapshot?.defaultModelSelector?.endsWith('/package-smoke-model'),
      'custom Provider model was not selected'
    );
    invoke({ action: 'logout', providerId });
    const deleted = invoke({ action: 'delete-custom', providerId }).value;
    assert(
      !deleted.snapshot?.providers?.some((provider) => provider.id === providerId),
      'custom Provider was not deleted'
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function checkAcpLifecycle() {
  const home = await mkdtemp(join(tmpdir(), 'lody-sorbet-package-smoke-'));
  const dataDirectory = join(home, 'sorbet-data');
  let codexOAuthLoginPromptObserved = false;
  let codexOAuthCredentialPromptObserved = false;
  const child = spawn(process.execPath, [entry], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      SORBET_DATA_DIR: dataDirectory,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8_192);
  });

  try {
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        unstable_createElicitation: async (params) => {
          if (params.mode === 'form') {
            const value = params.requestedSchema.properties.value;
            if (Array.isArray(value.oneOf)) {
              codexOAuthLoginPromptObserved = true;
              return { action: 'accept', content: { value: 'browser' } };
            }
            if (value._meta?.lody?.elicitation?.secret === true) {
              codexOAuthCredentialPromptObserved = true;
            }
            return { action: 'cancel' };
          }
          return { action: 'accept' };
        },
        unstable_completeElicitation: async () => {},
      }),
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
    );
    const initialized = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        auth: {
          terminal: false,
          _meta: { lody: { credentialForm: { version: 1 } } },
        },
        elicitation: { form: {}, url: {} },
      },
      clientInfo: { name: 'lody-package-smoke', title: 'Lody package smoke', version: '1' },
    });
    assert(initialized.agentInfo?.name === 'sorbet-acp', 'unexpected ACP implementation');
    assert(initialized.agentCapabilities?.providers != null, 'missing Provider capability');

    const authMethodIds = new Set((initialized.authMethods ?? []).map((method) => method.id));
    assert(authMethodIds.has('sorbet:openai-codex:oauth'), 'missing Codex OAuth method');
    assert(authMethodIds.has('sorbet:anthropic:oauth'), 'missing Anthropic OAuth method');

    const providerResponse = await connection.unstable_listProviders({});
    const providerIds = new Set(providerResponse.providers.map((provider) => provider.providerId));
    assert(providerIds.has('openai-codex'), 'missing openai-codex Provider');
    assert(providerIds.has('anthropic'), 'missing anthropic Provider');

    let authenticationError;
    try {
      await connection.authenticate({ methodId: 'sorbet:openai-codex:oauth' });
    } catch (error) {
      authenticationError = error;
    }
    assert(
      codexOAuthLoginPromptObserved,
      `bundled Codex OAuth implementation did not reach its login prompt: ${
        authenticationError instanceof Error
          ? authenticationError.message
          : String(authenticationError)
      }`
    );
    assert(
      codexOAuthCredentialPromptObserved,
      `bundled Codex OAuth implementation did not expose its credential-safe manual-code prompt: ${
        authenticationError instanceof Error
          ? authenticationError.message
          : String(authenticationError)
      }`
    );

    let sessionError;
    try {
      await connection.newSession({ cwd: home, mcpServers: [] });
    } catch (error) {
      sessionError = error;
    }
    assert(
      typeof sessionError === 'object' && sessionError !== null && sessionError.code === -32_000,
      'empty credential store did not return ACP auth_required'
    );
    assert(
      sessionError instanceof Error && /authentication required/iu.test(sessionError.message),
      'empty credential store returned an unexpected error'
    );

    await writeFile(
      join(dataDirectory, 'credentials.json'),
      `${JSON.stringify({ openai: { type: 'api_key', key: 'package-smoke-only' } })}\n`,
      { mode: 0o600 }
    );
    const session = await connection.newSession({ cwd: home, mcpServers: [] });
    const configOptionIds = new Set((session.configOptions ?? []).map((option) => option.id));
    assert(configOptionIds.has('model'), 'session is missing dynamic model configuration');
    assert(
      configOptionIds.has('permission_mode'),
      'session is missing dynamic permission configuration'
    );
    await checkCrossProcessFork(entry, home, dataDirectory, session.sessionId);
    await connection.closeSession({ sessionId: session.sessionId });
  } catch (error) {
    throw new Error(`Bundled Sorbet ACP smoke failed. stderr: ${stderr}`, { cause: error });
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
    await rm(home, { recursive: true, force: true });
  }
}

async function checkCrossProcessFork(entry, cwd, dataDirectory, sourceSessionId) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, HOME: cwd, SORBET_DATA_DIR: dataDirectory },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8_192);
  });
  try {
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        unstable_createElicitation: async () => ({ action: 'cancel' }),
        unstable_completeElicitation: async () => {},
      }),
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
    );
    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'lody-package-fork-smoke', version: '1' },
    });
    const fork = await connection.unstable_forkSession({
      sessionId: sourceSessionId,
      cwd,
      mcpServers: [],
    });
    assert(fork.sessionId !== sourceSessionId, 'cross-process fork reused its source identity');
    await connection.closeSession({ sessionId: fork.sessionId });
  } catch (error) {
    throw new Error(`Bundled Sorbet cross-process fork failed. stderr: ${stderr}`, {
      cause: error,
    });
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
  }
}

async function checkScriptedSessionLifecycle() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'lody-sorbet-scripted-smoke-')));
  const dataDirectory = join(home, 'agents', 'sorbet');
  const firstFixture = join(home, 'first.txt');
  const secondFixture = join(home, 'second.txt');
  await Promise.all([
    writeFile(firstFixture, 'first packaged read\n'),
    writeFile(secondFixture, 'second packaged read\n'),
  ]);
  const scripted = await startScriptedResponsesServer({ firstFixture, secondFixture });
  const invokeProviderControl = (request) => {
    const result = spawnSync(process.execPath, [providerControl], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        LODY_DATA_DIR: home,
        SORBET_DATA_DIR: dataDirectory,
      },
      input: JSON.stringify(request),
      encoding: 'utf8',
    });
    assert(result.status === 0, `scripted Provider Center operation failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };

  let firstWorker;
  let recoveryWorker;
  let forkWorker;
  try {
    const created = invokeProviderControl({
      action: 'create-custom',
      provider: {
        name: 'Scripted package Provider',
        protocol: 'openai-responses',
        baseUrl: `${scripted.baseUrl}/v1`,
        models: [
          {
            id: 'scripted-model',
            reasoning: true,
            thinkingLevelMap: { off: 'none', high: 'high' },
          },
        ],
      },
    });
    const providerId = created.affectedProviderId;
    assert(typeof providerId === 'string', 'scripted custom Provider id missing');
    invokeProviderControl({ action: 'set-api-key', providerId, apiKey: 'scripted-only-key' });
    invokeProviderControl({ action: 'set-default', providerId });

    firstWorker = await startAcpWorker({
      name: 'lody-package-scripted-source',
      cwd: home,
      dataDirectory,
    });
    const initialized = await firstWorker.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'lody-package-scripted-source', version: '1' },
    });
    const lodyCapabilities = initialized.agentCapabilities?.['_meta']?.lody;
    assert(lodyCapabilities?.forkAtTurn?.version === 1, 'missing Lody fork-at-turn capability');
    assert(lodyCapabilities?.goal?.version === 1, 'missing Lody Goal capability');
    assert(lodyCapabilities?.compaction?.version === 1, 'missing Lody compaction capability');
    assert(lodyCapabilities?.subagents?.version === 1, 'missing Lody subagent capability');

    const source = await firstWorker.connection.newSession({ cwd: home, mcpServers: [] });
    assert(
      source.configOptions?.some(
        (option) => option.id === 'model' && option.currentValue.endsWith('/scripted-model')
      ),
      'scripted Session did not use the selected Provider model'
    );
    const thought = await firstWorker.connection.setSessionConfigOption({
      sessionId: source.sessionId,
      configId: 'thought_level',
      value: 'high',
    });
    assert(
      thought.configOptions.some(
        (option) => option.id === 'thought_level' && option.currentValue === 'high'
      ),
      'scripted Session did not apply its thinking level'
    );
    const permission = await firstWorker.connection.setSessionConfigOption({
      sessionId: source.sessionId,
      configId: 'permission_mode',
      value: 'full-access',
    });
    assert(
      permission.configOptions.some(
        (option) => option.id === 'permission_mode' && option.currentValue === 'full-access'
      ),
      'scripted Session did not apply its permission mode'
    );

    const firstPrompt = await firstWorker.connection.prompt({
      sessionId: source.sessionId,
      prompt: [{ type: 'text', text: 'Read both package fixtures.' }],
    });
    assert(firstPrompt.stopReason === 'end_turn', 'scripted Read prompt did not finish');
    assert(
      scripted.requests[0]?.reasoning?.effort === 'high',
      'scripted request did not carry the configured thinking level'
    );
    assert(
      scripted.requests[1]?.input?.filter((item) => item.type === 'function_call_output').length ===
        2,
      'scripted Provider did not receive both concurrent Read results'
    );
    const readCalls = firstWorker.updates.filter(
      ({ update }) => update.sessionUpdate === 'tool_call' && update.kind === 'read'
    );
    assert(readCalls.length === 2, 'packaged worker did not publish both Read calls');
    assert(
      firstWorker.updates.filter(
        ({ update }) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed'
      ).length >= 2,
      'packaged worker did not complete both Read calls'
    );
    const firstTurnId = firstWorker.turnIds[0];
    assert(typeof firstTurnId === 'string', 'scripted source turn did not publish a Lody turn id');

    // Simulate an ungraceful desktop/CLI loss. The replacement worker must be
    // able to acquire the packaged Journal lease immediately and replay the
    // fully committed turn without repairing or duplicating it.
    await firstWorker.stop('SIGKILL');
    firstWorker = undefined;

    recoveryWorker = await startAcpWorker({
      name: 'lody-package-scripted-recovery',
      cwd: home,
      dataDirectory,
    });
    await recoveryWorker.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'lody-package-scripted-recovery', version: '1' },
    });
    await recoveryWorker.connection.loadSession({
      sessionId: source.sessionId,
      cwd: home,
      mcpServers: [],
    });
    assert(
      recoveryWorker.updates.some(({ update }) => update.sessionUpdate === 'user_message_chunk') &&
        recoveryWorker.updates.some(({ update }) => update.sessionUpdate === 'agent_message_chunk'),
      'recovered Session did not replay its durable conversation'
    );
    await recoveryWorker.connection.closeSession({ sessionId: source.sessionId });
    recoveryWorker.updates.length = 0;
    await recoveryWorker.connection.resumeSession({
      sessionId: source.sessionId,
      cwd: home,
      mcpServers: [],
    });
    assert(
      !recoveryWorker.updates.some(
        ({ update }) =>
          update.sessionUpdate === 'user_message_chunk' ||
          update.sessionUpdate === 'agent_message_chunk'
      ),
      'resume unexpectedly replayed durable conversation'
    );
    const resumedPrompt = await recoveryWorker.connection.prompt({
      sessionId: source.sessionId,
      prompt: [{ type: 'text', text: 'Run the scripted command.' }],
    });
    assert(resumedPrompt.stopReason === 'end_turn', 'resumed Bash prompt did not finish');
    assert(
      recoveryWorker.updates.some(
        ({ update }) =>
          update.sessionUpdate === 'tool_call' &&
          update.kind === 'execute' &&
          update.title === "printf 'sorbet-smoke\\n'"
      ),
      'packaged Bash call did not expose its command as the ACP title'
    );
    await recoveryWorker.connection.closeSession({ sessionId: source.sessionId });
    await recoveryWorker.stop();
    recoveryWorker = undefined;

    forkWorker = await startAcpWorker({
      name: 'lody-package-scripted-fork',
      cwd: home,
      dataDirectory,
    });
    await forkWorker.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'lody-package-scripted-fork', version: '1' },
    });
    const fork = await forkWorker.connection.unstable_forkSession({
      sessionId: source.sessionId,
      cwd: home,
      mcpServers: [],
      _meta: { lody: { forkAtTurn: { version: 1, turnId: firstTurnId } } },
    });
    assert(fork.sessionId !== source.sessionId, 'turn fork reused the source Session identity');
    const forkPrompt = await forkWorker.connection.prompt({
      sessionId: fork.sessionId,
      prompt: [{ type: 'text', text: 'Continue only from the first turn.' }],
    });
    assert(forkPrompt.stopReason === 'end_turn', 'forked Session was not independently promptable');
    const listed = await forkWorker.connection.listSessions({});
    assert(
      listed.sessions.some((session) => session.sessionId === source.sessionId) &&
        listed.sessions.some((session) => session.sessionId === fork.sessionId),
      'session/list omitted the source or forked Session'
    );
    await forkWorker.connection.closeSession({ sessionId: fork.sessionId });
    await forkWorker.connection.deleteSession({ sessionId: fork.sessionId });
    assert(
      !(await forkWorker.connection.listSessions({})).sessions.some(
        (session) => session.sessionId === fork.sessionId
      ),
      'session/delete left the fork in the Session catalog'
    );
    assert(
      scripted.requests.length === 5,
      'scripted Provider received an unexpected request count'
    );
  } finally {
    await firstWorker?.stop().catch(() => undefined);
    await recoveryWorker?.stop().catch(() => undefined);
    await forkWorker?.stop().catch(() => undefined);
    await scripted.close();
    await rm(home, { recursive: true, force: true });
  }
}

async function startAcpWorker({ name, cwd, dataDirectory }) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: {
      ...process.env,
      HOME: cwd,
      SORBET_DATA_DIR: dataDirectory,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-16_384);
  });
  const updates = [];
  const turnIds = [];
  const connection = new ClientSideConnection(
    () => ({
      sessionUpdate: async (params) => {
        updates.push(params);
        const turnId = params.update?.['_meta']?.lody?.turnId;
        if (typeof turnId === 'string' && !turnIds.includes(turnId)) turnIds.push(turnId);
      },
      requestPermission: async (params) => {
        const allowed = params.options.find((option) => option.kind === 'allow_once');
        return allowed
          ? { outcome: { outcome: 'selected', optionId: allowed.optionId } }
          : { outcome: { outcome: 'cancelled' } };
      },
      unstable_createElicitation: async () => ({ action: 'cancel' }),
      unstable_completeElicitation: async () => {},
    }),
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  );
  let stopped = false;
  return {
    child,
    connection,
    updates,
    turnIds,
    async stop(signal = 'SIGTERM') {
      if (stopped) return;
      stopped = true;
      child.kill(signal);
      await Promise.race([
        once(child, 'exit'),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`${name} did not exit after ${signal}. stderr: ${stderr}`)),
            2_000
          )
        ),
      ]);
    },
  };
}

async function startScriptedResponsesServer({ firstFixture, secondFixture }) {
  const requests = [];
  const scripts = [
    {
      type: 'tools',
      calls: [
        { name: 'read', arguments: { path: firstFixture } },
        { name: 'read', arguments: { path: secondFixture } },
      ],
    },
    { type: 'text', text: 'Read both packaged fixtures.' },
    {
      type: 'tools',
      calls: [{ name: 'bash', arguments: { command: "printf 'sorbet-smoke\\n'" } }],
    },
    { type: 'text', text: 'Ran the packaged command.' },
    { type: 'text', text: 'Continued from the selected fork boundary.' },
  ];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const script = scripts[requests.length - 1];
      assert(script, `unexpected scripted model request ${requests.length}`);
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const emit = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      const responseId = `resp_${requests.length}`;
      emit({
        type: 'response.created',
        response: { id: responseId, status: 'in_progress', output: [] },
      });
      const output = [];
      if (script.type === 'tools') {
        for (const [outputIndex, call] of script.calls.entries()) {
          const item = {
            type: 'function_call',
            id: `fc_${requests.length}_${outputIndex}`,
            call_id: `call_${requests.length}_${outputIndex}`,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
            status: 'completed',
          };
          output.push(item);
          emit({
            type: 'response.output_item.added',
            output_index: outputIndex,
            item: { ...item, arguments: '', status: 'in_progress' },
          });
          emit({
            type: 'response.function_call_arguments.done',
            output_index: outputIndex,
            item_id: item.id,
            arguments: item.arguments,
          });
          emit({ type: 'response.output_item.done', output_index: outputIndex, item });
        }
      } else {
        const item = {
          type: 'message',
          id: `msg_${requests.length}`,
          role: 'assistant',
          status: 'completed',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: script.text, annotations: [] }],
        };
        output.push(item);
        emit({
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...item, status: 'in_progress', content: [] },
        });
        emit({ type: 'response.output_text.delta', output_index: 0, delta: script.text });
        emit({ type: 'response.output_item.done', output_index: 0, item });
      }
      emit({
        type: 'response.completed',
        response: {
          id: responseId,
          status: 'completed',
          output,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      });
      response.end('data: [DONE]\n\n');
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object', 'scripted Provider did not bind a TCP port');
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

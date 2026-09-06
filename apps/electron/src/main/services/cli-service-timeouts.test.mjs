import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { Effect } from 'effect'
import ts from 'typescript'

// Execute the production method without booting Electron or its supervisor.
const text = await readFile(new URL('./cli-service.ts', import.meta.url), 'utf8')
const source = ts.createSourceFile('cli-service.ts', text, ts.ScriptTarget.Latest, true)
const constants = source.statements.filter(
  (node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((declaration) =>
      declaration.name.getText(source).startsWith('LOCAL_SESSION_CONTROL_')
    )
)
const resolver = source.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'resolveLocalSessionControlTimeoutMs'
)
const service = source.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === 'CliService'
)
const method = service?.members.find(
  (node) => ts.isMethodDeclaration(node) && node.name.getText(source) === 'sendLocalSessionControl'
)
assert.ok(resolver && method)
const harness = ts.transpileModule(
  `${constants.map((node) => node.getText(source)).join('\n')}
   ${resolver.getText(source)}
   class Harness { ${method.getText(source)} }
   globalThis.Harness = Harness`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText
const context = vm.createContext({ Effect, isLocalSessionControlRequest: () => true })
vm.runInContext(harness, context)

for (const [type, expectedTimeout, elapsed] of [
  ['machine/account-profiles', 30_000, 15_000],
  ['session/account-switch', 300_000, 120_000],
  ['machine/acp-authenticate', 300_000, 120_000],
  ['machine/acp-binary-install', 300_000, 120_000],
  ['machine/acp-capabilities-refresh', 120_000, 60_000],
  ['session/file-send-local', 120_000, 60_000],
  ['session/stop', 10_000, 1_000]
]) {
  void test(`${type} forwards its deadline and keeps the final response`, async () => {
    const instance = new context.Harness()
    const message = { type, requestId: 'synthetic-request' }
    const response = { type: `${type}_response`, success: true }
    const streamed = []
    instance.localControlClient = {
      sessionControl: (received, options) => {
        assert.equal(received, message)
        assert.equal(options.timeoutMs, expectedTimeout)
        // A deterministic transport model: no wall clock or real process is required.
        if (elapsed >= options.timeoutMs) return Effect.fail({ _tag: 'IpcTimeoutError' })
        options.onResponse(response)
        return Effect.succeed([response])
      }
    }
    const result = await instance.sendLocalSessionControl(message, {
      onResponse: (value) => streamed.push(value)
    })
    assert.equal(result.ok, true)
    assert.equal(result.responses[0], response)
    assert.equal(streamed[0], response)
  })
}

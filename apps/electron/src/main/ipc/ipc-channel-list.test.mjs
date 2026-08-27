import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { IPC_INVOKE_SERVICE_GROUPS, isIpcInvokeChannel } from '../../preload/ipc-invoke-policy.ts'

const ipcDirectory = import.meta.dirname
const servicesDirectory = path.join(ipcDirectory, 'services')
const registerServicesPath = path.join(ipcDirectory, 'register-services.ts')

void test('invoke policy allows methods only within renderer-facing service groups', () => {
  assert.equal(isIpcInvokeChannel('auth.getSession'), true)
  assert.equal(isIpcInvokeChannel('cli.methodAddedWithoutASecondAllowlist'), true)
  assert.equal(isIpcInvokeChannel('lodyAuth:getSession'), false)
  assert.equal(isIpcInvokeChannel('unknown.getState'), false)
  assert.equal(isIpcInvokeChannel('cli.restart.extra'), false)
})

function methodHasIpcDecorator(method) {
  return ts
    .getDecorators(method)
    ?.some(
      (decorator) =>
        ts.isCallExpression(decorator.expression) &&
        ts.isIdentifier(decorator.expression.expression) &&
        decorator.expression.expression.text === 'IpcMethod'
    )
}

async function readIpcClass(fileName) {
  const sourceText = await readFile(path.join(servicesDirectory, fileName), 'utf8')
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  const ipcClass = source.statements.find(
    (statement) =>
      ts.isClassDeclaration(statement) &&
      statement.name?.text.endsWith('Ipc') &&
      statement.heritageClauses?.some((clause) =>
        clause.types.some((type) => type.expression.getText(source) === 'IpcService')
      )
  )
  assert.ok(ipcClass && ts.isClassDeclaration(ipcClass), `${fileName} must export an IpcService`)
  assert.ok(ipcClass.name, `${fileName} IPC service must be named`)
  const groupProperty = ipcClass.members.find(
    (member) =>
      ts.isPropertyDeclaration(member) &&
      member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
      member.name.getText(source) === 'groupName'
  )
  assert.ok(
    groupProperty && ts.isStringLiteral(groupProperty.initializer),
    `${ipcClass.name.text}.groupName must be a string literal`
  )
  const publicMethods = ipcClass.members.filter(
    (member) =>
      ts.isMethodDeclaration(member) &&
      !member.modifiers?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
          modifier.kind === ts.SyntaxKind.StaticKeyword
      )
  )
  for (const method of publicMethods) {
    assert.ok(
      methodHasIpcDecorator(method),
      `${ipcClass.name.text}.${method.name.getText(source)} must have @IpcMethod()`
    )
  }
  return {
    className: ipcClass.name.text,
    groupName: groupProperty.initializer.text,
    methodNames: publicMethods.map((method) => method.name.getText(source))
  }
}

void test('every public service method is decorated and every service is registered', async () => {
  const registerSourceText = await readFile(registerServicesPath, 'utf8')
  const registerSource = ts.createSourceFile(
    registerServicesPath,
    registerSourceText,
    ts.ScriptTarget.Latest,
    true
  )
  const constructorsDeclaration = registerSource.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((declaration) => declaration.name.getText(registerSource) === 'IPC_SERVICE_CONSTRUCTORS')
  assert.ok(constructorsDeclaration, 'register-services must declare IPC_SERVICE_CONSTRUCTORS')
  const initializer = constructorsDeclaration.initializer
  assert.ok(
    initializer && ts.isAsExpression(initializer),
    'IPC_SERVICE_CONSTRUCTORS must use as const'
  )
  assert.ok(ts.isArrayLiteralExpression(initializer.expression))
  const registeredClassNames = new Set(
    initializer.expression.elements.map((element) => element.getText(registerSource))
  )

  const serviceFiles = (await readdir(servicesDirectory)).filter((file) => file.endsWith('-ipc.ts'))
  const services = await Promise.all(serviceFiles.map(readIpcClass))

  assert.deepEqual(
    registeredClassNames,
    new Set(services.map((service) => service.className)),
    'the constructor list must contain every renderer-facing IPC service exactly once'
  )
  assert.equal(
    new Set(services.map((service) => service.groupName)).size,
    services.length,
    'IPC service group names must be unique'
  )
  assert.deepEqual(
    new Set(IPC_INVOKE_SERVICE_GROUPS),
    new Set(services.map((service) => service.groupName)),
    'preload must allow every registered service group and no others'
  )
  assert.ok(services.every((service) => service.methodNames.length > 0))
})

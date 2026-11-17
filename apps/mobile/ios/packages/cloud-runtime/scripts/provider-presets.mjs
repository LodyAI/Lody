// Extract the Web editor's reviewed public preset constants; native builds use only generated data.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { format } from 'prettier';
const path = process.argv[2];
if (!path) throw new Error('Pass agent-config-dialog.tsx');
const source = await readFile(path, 'utf8');
const start = source.indexOf('export const DEEPSEEK_CLAUDE_PRESET_ID');
const end = source.indexOf('const PRESETS_BY_ID:');
if (start < 0 || end < start) throw new Error('Preset source layout changed');
const script = ts.transpileModule(
  source.slice(start, end) + '\n globalThis.result = PRESETS;',
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const context = { exports: {} };
vm.runInNewContext(script, context, { timeout: 1000 });
const presets = context.result.map((p) => ({
  id: p.id,
  name: p.label,
  brandId: p.brandId,
  cliType: p.cliType,
  agentType: p.agentType,
  tokenEnvKey: p.tokenEnvKey,
  modes: (
    p.credentialModes ?? [
      { id: 'default', labelDefault: 'Default', fixedEnv: {} },
    ]
  ).map((m) => ({
    id: m.id,
    name: m.labelDefault,
    env: { ...p.fixedEnv, ...m.fixedEnv },
    tokenPrefix: m.tokenPrefix,
    customEndpoint: !!m.baseUrlEnvKey,
    endpoints: (m.baseUrlOptions ?? [])
      .filter((e) => e.value)
      .map((e) => ({ id: e.id, name: e.labelDefault, url: e.value })),
    endpoint:
      m.fixedEnv?.ANTHROPIC_BASE_URL ??
      p.fixedEnv?.ANTHROPIC_BASE_URL ??
      m.baseUrlOptions?.find((e) => e.id === m.defaultBaseUrlOptionId)?.value,
  })),
}));
await writeFile(
  new URL('../src/protocol/provider-presets.ts', import.meta.url),
  await format(
    `// Generated from Web agent-config-dialog.tsx, SHA256 ${createHash('sha256').update(source).digest('hex')}.\nexport type ProviderPresetDefinition = {id:string;name:string;brandId:string;cliType:string;agentType:string;tokenEnvKey:string;modes:{id:string;name:string;env:Record<string,string>;tokenPrefix?:string;customEndpoint:boolean;endpoints:{id:string;name:string;url:string}[];endpoint?:string}[]};\nexport const providerPresets:ProviderPresetDefinition[] = ${JSON.stringify(presets)};\n`,
    { parser: 'typescript', singleQuote: true, trailingComma: 'all' },
  ),
);

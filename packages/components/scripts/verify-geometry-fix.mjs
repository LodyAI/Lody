import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const argumentsList = process.argv.slice(2);
const positional = argumentsList.filter((argument) => !argument.startsWith('--'));
const ledgerArgument = argumentsList.find((argument) => argument.startsWith('--ledger='));
const [requestedOutput, ...requestedKeys] = positional;

if (!requestedOutput || requestedKeys.length === 0) {
  throw new Error('Usage: pnpm geometry:verify-fix <dir> <findingKey...> [--ledger=<path>]');
}

const outputDirectory = path.resolve(packageRoot, requestedOutput);
const ledgerPath = ledgerArgument
  ? path.resolve(packageRoot, ledgerArgument.slice('--ledger='.length))
  : path.join(packageRoot, 'geometry-ledger.json');

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function resolvePort() {
  if (process.env.GEOMETRY_REPORT_PORT) return Number(process.env.GEOMETRY_REPORT_PORT);
  for (let port = 6100; port < 6120; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error('No available Storybook port in the range 6100-6119');
}

function run(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: packageRoot,
      env: process.env,
      stdio: 'inherit',
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} exited with ${signal ? `signal ${signal}` : `status ${String(code)}`}`
        )
      );
    });
  });
}

// The ratchet gate IS the verification run: it walks the same capture plan with
// no screenshots and fails if any OTHER finding regressed, so "did this fix
// land" and "did it cost something elsewhere" are one measurement rather than
// two runs that could disagree. The decision itself is made in TypeScript
// beside the ratchet; this script only applies the ledger it writes out.
const port = await resolvePort();
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
await run(
  pnpmCommand,
  [
    'exec',
    'playwright',
    'test',
    'tests/e2e/chat-workspace-geometry.spec.ts',
    '--grep',
    'reviewed ledger baseline',
    '--workers=1',
    '--retries=0',
    '--reporter=line',
  ],
  {
    env: {
      ...process.env,
      GEOMETRY_PIPELINE_OUTPUT_DIR: outputDirectory,
      GEOMETRY_VERIFY_FIX_KEYS: requestedKeys.join(','),
      PLAYWRIGHT_PORT: String(port),
      PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${port}`,
      VITE_PREVIEW_PUBLIC_BASE_DOMAIN:
        process.env.VITE_PREVIEW_PUBLIC_BASE_DOMAIN ?? 'local.invalid',
      ...(process.platform === 'darwin' && process.env.PLAYWRIGHT_USE_SYSTEM_CHROME == null
        ? { PLAYWRIGHT_USE_SYSTEM_CHROME: '1' }
        : {}),
    },
  }
);

const verificationPath = path.join(outputDirectory, 'fix-verification.json');
const verification = JSON.parse(await readFile(verificationPath, 'utf8'));
if (verification.version !== 1 || !Array.isArray(verification.verifications)) {
  throw new Error(`Unsupported geometry fix verification: ${verificationPath}`);
}

for (const item of verification.verifications) {
  const measured = item.resolved
    ? 'no longer reported by any rail'
    : `|offset| ${Math.abs(item.offset).toFixed(3)}px`;
  console.log(
    `${item.passed ? 'FIXED' : 'STILL OFF'}  ${item.key}\n  ${item.label}\n  ${measured}${
      item.reason ? `\n  ${item.reason}` : ''
    }`
  );
}

if (!verification.passed) {
  console.error('\nGeometry ledger unchanged: not every requested finding is fixed.');
  process.exitCode = 1;
} else {
  await writeFile(ledgerPath, `${JSON.stringify(verification.ledger, null, 2)}\n`, 'utf8');
  console.log(
    `\nGeometry ledger: marked ${verification.verifications.length} finding(s) fixed in ${ledgerPath}`
  );
}

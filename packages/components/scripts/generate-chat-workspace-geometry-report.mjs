import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const templatePath = path.join(
  packageRoot,
  'scripts/templates/chat-workspace-geometry-report.html'
);
const argumentsList = process.argv.slice(2);
const shouldOpen = argumentsList.includes('--open');
const requestedOutput = argumentsList.find((argument) => !argument.startsWith('--'));
const outputDirectory = path.resolve(packageRoot, requestedOutput ?? 'geometry-report');
const reportPath = path.join(outputDirectory, 'index.html');
const dataPath = path.join(outputDirectory, 'report-data.json');

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function resolveReportPort() {
  if (process.env.GEOMETRY_REPORT_PORT) return Number(process.env.GEOMETRY_REPORT_PORT);
  for (let port = 6100; port < 6120; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error('No available Storybook port in the geometry-report range 6100-6119');
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

async function openReport() {
  const command =
    process.platform === 'darwin'
      ? ['open', [reportPath]]
      : process.platform === 'win32'
        ? ['cmd.exe', ['/c', 'start', '', reportPath]]
        : ['xdg-open', [reportPath]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const reportPort = await resolveReportPort();
const reportEnvironment = {
  ...process.env,
  GEOMETRY_REPORT_OUTPUT_DIR: outputDirectory,
  PLAYWRIGHT_PORT: String(reportPort),
  PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${reportPort}`,
  VITE_PREVIEW_PUBLIC_BASE_DOMAIN: process.env.VITE_PREVIEW_PUBLIC_BASE_DOMAIN ?? 'local.invalid',
  ...(process.platform === 'darwin' && process.env.PLAYWRIGHT_USE_SYSTEM_CHROME == null
    ? { PLAYWRIGHT_USE_SYSTEM_CHROME: '1' }
    : {}),
};

await rm(path.join(outputDirectory, 'assets'), { recursive: true, force: true });
await run(
  pnpmCommand,
  [
    'exec',
    'playwright',
    'test',
    'tests/e2e/chat-workspace-geometry-report.spec.ts',
    '--workers=1',
    '--retries=0',
    '--reporter=line',
  ],
  { env: reportEnvironment }
);

const [template, reportDataText] = await Promise.all([
  readFile(templatePath, 'utf8'),
  readFile(dataPath, 'utf8'),
]);
const reportData = JSON.parse(reportDataText);
const serializedData = JSON.stringify(reportData)
  .replaceAll('<', '\\u003c')
  .replaceAll('\u2028', '\\u2028')
  .replaceAll('\u2029', '\\u2029');
const reportHtml = template.replace('__GEOMETRY_REPORT_DATA__', serializedData);
if (reportHtml === template) throw new Error('Geometry report template data marker is missing');
if (/data:image\//i.test(reportHtml)) {
  throw new Error('Geometry report must reference image files instead of embedding Base64 images');
}
await writeFile(reportPath, reportHtml, 'utf8');

const imagePaths = [
  ...reportData.details.flatMap((detail) => [detail.images.clean, detail.images.annotated]),
];
const imageStats = await Promise.all(
  imagePaths.map(async (imagePath) => ({
    imagePath,
    file: await stat(path.join(outputDirectory, imagePath)),
  }))
);
const detailImageBytes = imageStats.reduce((total, { file }) => total + file.size, 0);
console.log(`Geometry report: ${reportPath}`);
console.log(
  `${reportData.details.length} detail pairs: ${(detailImageBytes / 1024).toFixed(1)} KiB total`
);

if (shouldOpen) await openReport();

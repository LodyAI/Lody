import { createServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ScenarioArtifacts = {
  rootDir: string;
  scenarioDir: string;
  stableId: string;
};

export function findStableId(tags: readonly string[]): string {
  const stableId = tags.find((tag) => /^@LODY-[A-Z0-9-]+-\d{3}$/u.test(tag));
  if (!stableId) throw new Error('Scenario is missing a stable @LODY-AREA-NNN id');
  return stableId.slice(1);
}

export function createScenarioArtifacts(tags: readonly string[]): ScenarioArtifacts {
  const stableId = findStableId(tags);
  const acceptanceRound = process.env.LODY_ACCEPTANCE_ROUND_ID?.trim();
  const rootDir = acceptanceRound
    ? join(process.cwd(), 'artifacts', 'acceptance', acceptanceRound)
    : join(process.cwd(), 'artifacts');
  const scenarioDir = join(rootDir, 'scenarios', stableId.toLowerCase());
  mkdirSync(scenarioDir, { recursive: true });
  return { rootDir, scenarioDir, stableId };
}

export async function reserveTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Kernel did not return a TCP port for the E2E runtime');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

export async function assertTcpPortReleased(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function assertNamedPipeReleased(path: string): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export function appendFailureIndex(artifacts: ScenarioArtifacts): void {
  const indexPath = join(artifacts.rootDir, 'failure-index.json');
  const current = (() => {
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  current.push({
    stableId: artifacts.stableId,
    path: `scenarios/${artifacts.stableId.toLowerCase()}`,
  });
  writeFileSync(indexPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

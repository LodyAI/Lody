import { replayReproPack } from './repro-pack';

const command = process.argv[2];
const packDir = process.argv[3];
if (command !== 'replay' || !packDir) {
  console.error('usage: tsx src/repro-cli.ts replay <packDir>');
  process.exit(2);
}

try {
  const result = await replayReproPack(packDir);
  // Public stdout: fingerprint and divergence only. No private material.
  console.log(
    JSON.stringify({
      fingerprint: result.fingerprint,
      divergence: result.divergence,
      scope: result.scope,
    })
  );
  process.exit(result.divergence ? 1 : 0);
} catch (error) {
  const text = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ error: text }));
  process.exit(1);
}

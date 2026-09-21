import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { quoteCommandArgument } from './command-line.js';

const SCRIPT_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), 'load-scripted-acp.mjs');

export class LoadSessionFixture {
  readonly agentName = 'Deterministic Heavy Load Agent';
  readonly agentCommandLine: string;

  constructor(readonly eventLogPath: string) {
    writeFileSync(eventLogPath, '', 'utf8');
    this.agentCommandLine = [process.execPath, SCRIPT_ENTRY, eventLogPath]
      .map(quoteCommandArgument)
      .join(' ');
  }
}

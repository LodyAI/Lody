/** Lab-only write/import facts. Not an attacker view and not a production log. */

export interface ContentWriteFact {
  readonly genesisHex: string;
  readonly stream: 'loro' | 'flock';
  readonly deviceHex: string;
  readonly epoch: number;
  readonly text: string;
  /** Independent reference-model decision at the writer's last authenticated ledger. */
  readonly writerMayWrite: boolean | undefined;
}

const writes: ContentWriteFact[] = [];

export function recordContentWrite(fact: ContentWriteFact): void {
  writes.push(fact);
}

export function contentWritesFor(genesisHex: string): readonly ContentWriteFact[] {
  return writes.filter((row) => row.genesisHex === genesisHex);
}

export function clearContentWrites(): void {
  writes.length = 0;
}

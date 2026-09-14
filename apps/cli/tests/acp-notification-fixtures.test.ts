import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { LoroRepo } from 'loro-repo';

import { parseSessionNotifications, type SessionId } from '@lody/shared';

import { appendAutonomousACPNotifications } from '../src/lib/acp/history';
import { SessionDocument } from '../src/lib/loro/doc';
import type { MessageContent } from '@lody/shared';

describe('acp notification fixtures', () => {
  it('derives stable terminal_output blocks and keeps ANSI escapes', async () => {
    const fixturePath = path.join(
      __dirname,
      'fixtures',
      'acp',
      'codex-terminal-notifications.sample.json'
    );
    const notifications = parseSessionNotifications(
      JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
    );

    const repo = await LoroRepo.create({});
    const doc = new SessionDocument(repo, 'session-sample' as SessionId);
    await doc.initOffline();

    try {
      await appendAutonomousACPNotifications(doc, notifications);
      const history = await doc.sessionData.history.readAll();
      const toolCalls = history
        .flatMap((h) => {
          const rawItems = h.items;
          return Array.isArray(rawItems) ? (rawItems as unknown as MessageContent[]) : [];
        })
        .filter((c) => c.type === 'tool_call');

      expect(toolCalls.length).toBeGreaterThan(0);
      const last = toolCalls[toolCalls.length - 1]!;

      expect(last.rawInput).toBeUndefined();
      expect(last.rawOutput).toBeUndefined();

      const terminalOutputs = (last.content || []).filter((c) => c.type === 'terminal_output');
      expect(terminalOutputs.length).toBeGreaterThan(0);
      expect(terminalOutputs.some((b) => b.output === '\u001b[31mred\u001b[0m\n')).toBe(true);
    } finally {
      await repo.destroy();
    }
  });
});

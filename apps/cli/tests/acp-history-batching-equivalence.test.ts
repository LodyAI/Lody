import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';
import { LoroRepo } from 'loro-repo';

import {
  parseSessionNotifications,
  type AcpSessionNotification,
  type MessageContent,
  type SessionId,
} from '@lody/shared';

import { appendAutonomousACPNotifications } from '../src/lib/acp/history';
import { SessionDocument } from '../src/lib/loro/doc';

const normalizeMessageContent = (item: MessageContent): MessageContent => {
  const normalized = JSON.parse(JSON.stringify(item)) as MessageContent;
  if (normalized.type === 'tool_call' && !Array.isArray(normalized.content)) {
    return {
      ...normalized,
      content: [],
    };
  }
  return normalized;
};

const normalizeHistory = (history: unknown[]) => {
  return history.map((entry) => {
    const record = entry as {
      role?: unknown;
      items?: unknown;
      contents?: unknown;
      plan?: unknown;
      modelInfo?: unknown;
    };
    const rawContents = Array.isArray(record.items)
      ? (record.items as MessageContent[])
      : Array.isArray(record.contents)
        ? (record.contents as MessageContent[])
        : [];

    return JSON.parse(
      JSON.stringify({
        role: record.role,
        contents: rawContents.map(normalizeMessageContent),
        ...(Array.isArray(record.plan) ? { plan: record.plan } : {}),
        ...(record.modelInfo ? { modelInfo: record.modelInfo } : {}),
      })
    );
  });
};

const loadFixtureNotifications = (fixtureName: string): AcpSessionNotification[] => {
  const fixturePath = path.join(__dirname, 'fixtures', 'acp', fixtureName);
  return parseSessionNotifications(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
};

const buildHistory = async (
  notifications: AcpSessionNotification[],
  mode: 'batched' | 'streamed'
): Promise<unknown[]> => {
  const repo = await LoroRepo.create({});
  const doc = new SessionDocument(repo, `${mode}-session` as SessionId);
  await doc.initOffline();

  try {
    if (mode === 'batched') {
      await appendAutonomousACPNotifications(doc, notifications);
    } else {
      for (const notification of notifications) {
        await appendAutonomousACPNotifications(doc, notification);
      }
    }
    return await doc.sessionData.history.readAll();
  } finally {
    await repo.destroy();
  }
};

describe('ACP history batching equivalence', () => {
  it.each([
    'codex-terminal-notifications.sample.json',
    'claude-code-notifications.captured.json',
    'claude-code-terminal-notifications.captured.json',
    'claude-code-thinking-notifications.captured.json',
    'kimi-shell-notifications.sample.json',
  ])('preserves history when replaying %s as a batch or as individual updates', async (fixture) => {
    const notifications = loadFixtureNotifications(fixture);
    const [batchedHistory, streamedHistory] = await Promise.all([
      buildHistory(notifications, 'batched'),
      buildHistory(notifications, 'streamed'),
    ]);

    expect(normalizeHistory(batchedHistory)).toEqual(normalizeHistory(streamedHistory));
  });
});

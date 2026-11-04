import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@lody/shared';
import { toExportSessionSummary } from './formatters';
import { buildTranscriptMarkdown } from './markdown';

const createSessionMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 'session-1',
  machineId: 'machine-1',
  createdAt: '2026-03-23T10:00:00.000Z',
  userId: 'user-1',
  cliType: 'builtin',
  agentType: 'claude',
  ...overrides,
});

describe('session export formatters', () => {
  it('renders transcript markdown with thought blocks and attachment links', () => {
    const markdown = buildTranscriptMarkdown({
      session: toExportSessionSummary(createSessionMeta({ title: 'Exporter' }), 'workspace-1'),
      turns: [
        {
          turnId: 'turn-1',
          role: 'assistant',
          timestamp: '2026-03-23T10:01:00.000Z',
          finished: true,
          sendStatus: undefined,
          startedAt: null,
          endedAt: null,
          modelInfo: undefined,
          items: [
            { type: 'text', text: 'Implemented the command. See [Old](session://child).' },
            { type: 'thought', text: 'Need to keep this independent.' },
            {
              type: 'image',
              imageId: 'img-1',
              mimeType: 'image/png',
              fileName: 'diagram.png',
              sizeBytes: 30,
            },
          ],
        },
      ],
      attachments: [
        {
          imageId: 'img-1',
          mimeType: 'image/png',
          fileName: 'img-1.png',
          originalFileName: 'diagram.png',
          sizeBytes: 30,
          width: null,
          height: null,
          sourceTurnIds: ['turn-1'],
          relativePath: 'artifacts/attachments/files/img-1.png',
        },
      ],
    });

    expect(markdown).toContain('# Exporter');
    expect(markdown).toContain('[Open in Lody](lody://session/session-1?workspace=workspace-1)');
    expect(markdown).toContain('[Old](lody://session/child?workspace=workspace-1)');
    expect(markdown).toContain('#### Thought');
    expect(markdown).toContain('Need to keep this independent.');
    expect(markdown).toContain('![diagram.png](artifacts/attachments/files/img-1.png)');
  });
});

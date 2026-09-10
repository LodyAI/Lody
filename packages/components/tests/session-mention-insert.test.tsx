// @vitest-environment jsdom

import { File as NodeFile } from 'node:buffer';
import type { MachineId, SessionId, WorkspaceId } from '@lody/shared';
import { usePastedTextAttachments } from '../src/hooks/use-pasted-text-attachments';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const uploadedFiles = vi.hoisted(() => [] as File[]);
vi.mock('@lody/platform/react', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePlatformCapability: () => false,
}));
vi.mock('../src/atoms/local-probe', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  localMachineIdAtom: (await import('jotai')).atom('local'),
}));
vi.mock('../src/lib/electron-session-file-sender', () => ({
  canUseElectronLocalFileSend: () => true,
  sendSessionFileToLocalRuntime: async ({ file }: { file: File }) => {
    uploadedFiles.push(file);
    return { ok: true, files: [{ type: 'file', fileName: file.name, transport: 'local' }] };
  },
}));

let sessionItems: Array<{ sessionId: string; title: string; slug: string; activityAt: number }> =
  [];

vi.mock('../src/components/mentions/mention-project-file-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMentionProjectFiles: () => ({
    fileData: { entry: null, status: 'ready' as const },
    initializeLazyDirectory: async () => undefined,
    getKnownFileTokens: () => new Set<string>(),
  }),
}));

vi.mock('../src/components/mentions/mention-skill-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMentionProjectSkills: () => ({
    skillState: { status: 'ready' as const },
    skillItems: [],
    knownSkillTokens: new Set<string>(),
  }),
}));

vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionMentionItems: () => sessionItems,
}));

// Agent Roles read the visible-machine index, which needs the authenticated
// Convex context; the same reason the session source above is stubbed.
vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
}));

import {
  CombinedMentionTextarea,
  type CombinedMentionTextareaHandle,
} from '../src/components/mentions/combined-mention-textarea';
import type { Mention as MentionRange } from '../src/ui/mention/index';
import { ChatComposer } from '../src/components/chat/chat-composer';
import { applyTextRewrites } from '@lody/shared';
import { buildSessionMentionRewrites } from '../src/components/mentions/mention-session-source';
import { buildPastedTextRewrites, type PastedTextDraft } from '../src/lib/pasted-text-draft';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A session mention written from OUTSIDE the composer — the drop target of a
 * dragged sidebar row.
 *
 * Asserted at the composer boundary rather than on the drop handler, because
 * what makes the feature work is not the drop: it is that the insert produces
 * the same artefact a menu commit does. Text alone renders identically and is
 * then sent verbatim, so a test that only checked the draft text would pass on
 * a mention that never reaches the agent.
 */
describe('inserting a session mention from outside the composer', () => {
  let root: Root;
  let container: HTMLDivElement;
  let handle: CombinedMentionTextareaHandle | null;
  let value: string;
  let ranges: MentionRange[];

  beforeEach(async () => {
    await initI18n('en');
    sessionItems = [
      { sessionId: 'sess_ci', title: 'Fix CI', slug: 'fix-ci', activityAt: 2 },
      { sessionId: 'sess_docs', title: 'Docs pass', slug: 'docs-pass', activityAt: 1 },
    ];
    handle = null;
    value = '';
    ranges = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    uploadedFiles.length = 0;
  });

  async function render(next = value) {
    value = next;
    await act(async () => {
      root.render(
        <CombinedMentionTextarea
          value={value}
          onValueChange={(text) => {
            value = text;
          }}
          mentionSource={{ kind: 'local', localProjectId: 'p1' } as never}
          mentionActionsRef={(instance) => {
            handle = instance;
          }}
          onMentionRangesChange={(nextRanges) => {
            ranges = nextRanges;
          }}
          resetOnEmpty={false}
        />
      );
    });
  }

  async function insert(sessionId: string) {
    let inserted = false;
    await act(async () => {
      inserted = handle?.insertSessionMention(sessionId) ?? false;
    });
    // The composer is controlled by its owner, so re-render with what it wrote.
    await render(value);
    return inserted;
  }

  it('writes the slug and a range carrying the session id', async () => {
    await render('');

    expect(await insert('sess_ci')).toBe(true);
    expect(value).toBe('@fix-ci ');
    expect(ranges).toEqual([{ value: 'sess_ci', start: 0, end: 7, kind: 'session' }]);
  });

  it('appends to an existing draft with exactly one separating space', async () => {
    await render('compare with');

    expect(await insert('sess_ci')).toBe(true);
    expect(value).toBe('compare with @fix-ci ');
    expect(ranges).toEqual([{ value: 'sess_ci', start: 13, end: 20, kind: 'session' }]);

    // The draft now ends in the trailing space this insert wrote; the next one
    // must not double it.
    expect(await insert('sess_docs')).toBe(true);
    expect(value).toBe('compare with @fix-ci @docs-pass ');
    expect(ranges.map((range) => value.slice(range.start, range.end))).toEqual([
      '@fix-ci',
      '@docs-pass',
    ]);
  });

  it('is idempotent — a session already mentioned is not mentioned twice', async () => {
    await render('');
    expect(await insert('sess_ci')).toBe(true);

    expect(await insert('sess_ci')).toBe(false);
    expect(value).toBe('@fix-ci ');
    expect(ranges).toHaveLength(1);
  });

  it('reports failure for a session that is not mentionable', async () => {
    await render('hello');
    // The composer's own session is excluded from the list upstream, so an
    // unknown id is exactly what a self-drop looks like here.
    expect(await insert('sess_missing')).toBe(false);
    expect(value).toBe('hello');
    expect(ranges).toHaveLength(0);
  });
  it.each(['Convert to message text', 'Remove attachment'])(
    'keeps final send text consistent after file conversion, editing and %s',
    async (action) => {
      vi.stubGlobal('File', NodeFile);
      let send!: ReturnType<typeof usePastedTextAttachments>;
      let drafts: PastedTextDraft[] = [];
      function Harness() {
        send = usePastedTextAttachments('workspace' as WorkspaceId, 'local' as MachineId);
        const [text, setText] = React.useState('@fix-ci explain this');
        const [files, setFiles] = React.useState<PastedTextDraft[]>([]);
        value = text;
        drafts = files;
        return (
          <ChatComposer
            promptValue={text}
            onPromptChange={setText}
            pastedTextDrafts={files}
            onPastedTextDraftsChange={setFiles}
            mentionActionsRef={(next) => {
              handle = next;
            }}
            onMentionRangesChange={(next) => {
              ranges = next;
            }}
          />
        );
      }
      await act(async () => root.render(<Harness />));
      expect(ranges).toEqual([{ value: 'sess_ci', start: 0, end: 7, kind: 'session' }]);
      const click = async (element: Element | null | undefined) => {
        expect(element).toBeTruthy();
        await act(async () => (element as HTMLElement).click());
      };
      const button = (label: string) =>
        [...document.querySelectorAll('button, [role="menuitem"]')].find(
          (element) => element.textContent?.trim() === label
        );
      const trigger = container.querySelector('[aria-label="Add attachment"]');
      await act(async () =>
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      );
      await click(button('Convert message text to file'));
      expect(drafts[0]?.text).toBe('@fix-ci explain this');
      expect(ranges.filter((range) => range.kind === 'session')).toEqual([]);
      const expanded = () =>
        applyTextRewrites(value, [
          ...buildPastedTextRewrites(drafts),
          ...buildSessionMentionRewrites(value, ranges),
        ]).text;
      expect(expanded()).toBe(`[pasted-${drafts[0]!.id}.txt]`);
      // A later mention must survive label length changes and move with the splice.
      await act(async () => {
        handle?.replaceText(value.length, value.length, ' ');
      });
      await act(async () => {
        handle?.insertSessionMention('sess_docs');
      });
      const chip = container.querySelector('[data-mention-kind="pasted_text"]')!;
      vi.spyOn(chip, 'getClientRects').mockReturnValue([
        { left: 0, right: 100, top: 0, bottom: 20 },
      ] as unknown as DOMRectList);
      const input = container.querySelector('textarea')!;
      input.setSelectionRange(0, 0);
      await click(input);
      const editor = document.querySelector('[role="dialog"] textarea') as HTMLTextAreaElement;
      expect(editor).toBeTruthy();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          editor,
          'edited context'
        );
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(drafts[0]!.text).toBe('edited context');
      expect(expanded()).toBe(
        `[pasted-${drafts[0]!.id}.txt] use lody mcp to query session[id: sess_docs] history `
      );
      const blocks = [
        { type: 'text', text: expanded() },
        ...(await send(drafts, 'session' as SessionId)),
      ];
      expect(blocks).toEqual([
        {
          type: 'text',
          text: `[pasted-${drafts[0]!.id}.txt] use lody mcp to query session[id: sess_docs] history `,
        },
        { type: 'file', fileName: `pasted-${drafts[0]!.id}.txt`, transport: 'local' },
      ]);
      expect(await uploadedFiles[0]!.text()).toBe('edited context');
      await click(button(action));
      expect(drafts).toEqual([]);
      expect(expanded()).toBe(
        `${action === 'Remove attachment' ? '' : 'edited context'} use lody mcp to query session[id: sess_docs] history `
      );
      expect(
        ranges
          .filter((range) => range.kind === 'session')
          .map((range) => value.slice(range.start, range.end))
      ).toEqual(['@docs-pass']);
    }
  );
});

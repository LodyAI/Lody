// @vitest-environment jsdom

import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileChatList } from '../src/components/mobile/mobile-chat-list';
import type { MobileConversationItem } from '../src/components/mobile/mobile-project-screen';
import { initI18n } from '../src/i18n';

const chats: MobileConversationItem[] = [
  {
    id: 'local-chat',
    title: 'Local chat',
    kind: 'local',
    projectKey: 'machine:project',
    projectLabel: 'Local project',
  },
  {
    id: 'github-chat',
    title: 'GitHub chat',
    kind: 'github',
    projectKey: 'lody-ai/lody',
    projectLabel: 'lody-ai/lody',
  },
  { id: 'plain-chat', title: 'Plain chat', kind: 'chat' },
];

describe('mobile chat project group actions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it('renders a compose action for each project bucket and reports its target', () => {
    const onNewChatInProject = vi.fn();
    flushSync(() => {
      root.render(
        <Provider store={createStore()}>
          <MobileChatList
            chats={chats}
            groupBy="project"
            onNewChatInProject={onNewChatInProject}
            newChatInProjectAriaLabel={(label) => `New chat in ${label}`}
          />
        </Provider>
      );
    });

    const localButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="New chat in Local project"]'
    );
    expect(localButton).not.toBeNull();
    expect(container.querySelector('[aria-label="New chat in Chat"]')).toBeNull();

    localButton?.click();
    expect(onNewChatInProject).toHaveBeenCalledWith({
      kind: 'local',
      projectKey: 'machine:project',
    });
    expect(container.querySelector('[aria-label="New chat in lody-ai/lody"]')).not.toBeNull();
  });

  it('does not render project compose actions outside project grouping', () => {
    flushSync(() => {
      root.render(
        <Provider store={createStore()}>
          <MobileChatList
            chats={chats}
            groupBy="date"
            onNewChatInProject={vi.fn()}
            newChatInProjectAriaLabel={(label) => `New chat in ${label}`}
          />
        </Provider>
      );
    });

    expect(container.querySelector('[aria-label^="New chat in "]')).toBeNull();
  });
});

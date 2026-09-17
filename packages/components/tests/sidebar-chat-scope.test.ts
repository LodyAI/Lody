// @vitest-environment jsdom

import { createStore } from 'jotai';
import { beforeEach, describe, expect, it } from 'vitest';

import { archiveScopeAtom, chatScopeAtom } from '../src/atoms/sidebar-state';

const CHAT_SCOPE_STORAGE_KEY = 'lody-sidebar-chat-scope';
const ARCHIVE_SCOPE_STORAGE_KEY = 'lody-archive-scope';

function mountChatScopeStore() {
  const store = createStore();
  const unsubscribe = store.sub(chatScopeAtom, () => undefined);
  return { store, unsubscribe };
}

function mountArchiveScopeStore() {
  const store = createStore();
  const unsubscribe = store.sub(archiveScopeAtom, () => undefined);
  return { store, unsubscribe };
}

describe('chatScopeAtom', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows all workspace tasks when the user has not chosen a filter', () => {
    const { store, unsubscribe } = mountChatScopeStore();

    expect(store.get(chatScopeAtom)).toBe('team');
    expect(localStorage.getItem(CHAT_SCOPE_STORAGE_KEY)).toBeNull();

    unsubscribe();
  });

  it('preserves an explicitly saved My Tasks filter', () => {
    localStorage.setItem(CHAT_SCOPE_STORAGE_KEY, JSON.stringify('my'));

    const { store, unsubscribe } = mountChatScopeStore();

    expect(store.get(chatScopeAtom)).toBe('my');

    unsubscribe();
  });
});

describe('archiveScopeAtom', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows all archived workspace tasks when the user has not chosen a filter', () => {
    const { store, unsubscribe } = mountArchiveScopeStore();

    expect(store.get(archiveScopeAtom)).toBe('team');
    expect(localStorage.getItem(ARCHIVE_SCOPE_STORAGE_KEY)).toBeNull();

    unsubscribe();
  });

  it('preserves an explicitly saved My Tasks archive filter', () => {
    localStorage.setItem(ARCHIVE_SCOPE_STORAGE_KEY, JSON.stringify('my'));

    const { store, unsubscribe } = mountArchiveScopeStore();

    expect(store.get(archiveScopeAtom)).toBe('my');

    unsubscribe();
  });
});

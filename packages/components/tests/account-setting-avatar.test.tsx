import { expect, it, vi } from 'vitest';
import type { SessionMeta } from '@lody/shared';
import { buildSessionListRows } from '../src/components/sessions/session-list-rows';
import { persistUserAvatar } from '../src/components/settings/account-setting';

const OLD_IMAGE = 'https://avatars.example.test/old';
const NEW_IMAGE = 'https://avatars.example.test/new';
const authorSession = { id: 'session-1', userId: 'user-1', agentType: 'codex' } as SessionMeta;

type Organization = {
  id: string;
  members: Array<{ userId: string; user: { name: string; image: string } }>;
};

function createState() {
  const state = {
    savedImage: OLD_IMAGE,
    sessionImage: OLD_IMAGE,
    activeOrganizationId: 'workspace-a',
    organizations: new Map<string, Organization>([
      ['workspace-a', { id: 'workspace-a', members: [] }],
      ['workspace-b', { id: 'workspace-b', members: [] }],
    ]),
  };
  for (const organization of state.organizations.values()) {
    organization.members = [
      { userId: 'user-1', user: { name: 'Author', image: OLD_IMAGE } },
      { userId: 'user-2', user: { name: 'Teammate', image: OLD_IMAGE } },
    ];
  }
  return state;
}

function authorImage(state: ReturnType<typeof createState>) {
  const organization = state.organizations.get(state.activeOrganizationId)!;
  return buildSessionListRows([authorSession], {
    scope: 'team',
    currentUserId: 'user-1',
    defaultTitle: 'Synthetic session',
    members: organization.members,
  })[0]?.owner?.image;
}

function handlers(state: ReturnType<typeof createState>) {
  return {
    updateUser: vi.fn(async ({ image }: { image: string }) => {
      state.savedImage = image;
      return { error: null };
    }),
    refetchSession: async () => {
      state.sessionImage = state.savedImage;
    },
    refetchActiveOrganization: async () => {
      const organization = state.organizations.get(state.activeOrganizationId)!;
      organization.members[0]!.user.image = state.savedImage;
    },
  };
}

it('publishes the saved session avatar to the team session author', async () => {
  const state = createState();
  const { updateUser, refetchSession, refetchActiveOrganization } = handlers(state);

  await persistUserAvatar({
    url: NEW_IMAGE,
    updateUser,
    refetchSession,
    refetchActiveOrganization,
  });
  await Promise.resolve();

  expect(state.sessionImage).toBe(NEW_IMAGE);
  expect(authorImage(state)).toBe(NEW_IMAGE);
});

it('leaves a successful save intact when organization refresh fails', async () => {
  const state = createState();
  const { updateUser, refetchSession } = handlers(state);
  const refreshError = new Error('organization unavailable');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});

  await expect(
    persistUserAvatar({
      url: NEW_IMAGE,
      updateUser,
      refetchSession,
      refetchActiveOrganization: async () => {
        throw refreshError;
      },
    })
  ).resolves.toBe(NEW_IMAGE);
  await Promise.resolve();

  expect(state.savedImage).toBe(NEW_IMAGE);
  expect(state.sessionImage).toBe(NEW_IMAGE);
  expect(authorImage(state)).toBe(OLD_IMAGE);
  expect(log).toHaveBeenCalledWith(refreshError);
  log.mockRestore();
});

it('refreshes the organization active when the save completes after a switch', async () => {
  const state = createState();
  const saving = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const { refetchSession, refetchActiveOrganization } = handlers(state);
  const updateUser = vi.fn(async ({ image }: { image: string }) => {
    started.resolve();
    await saving.promise;
    state.savedImage = image;
    return { error: null };
  });

  const save = persistUserAvatar({
    url: NEW_IMAGE,
    updateUser,
    refetchSession,
    refetchActiveOrganization,
  });
  await started.promise;
  state.activeOrganizationId = 'workspace-b';
  saving.resolve();
  await expect(save).resolves.toBe(NEW_IMAGE);
  await Promise.resolve();

  expect(state.organizations.get('workspace-a')!.members[0]!.user.image).toBe(OLD_IMAGE);
  expect(authorImage(state)).toBe(NEW_IMAGE);
});

it('does not refresh shared state when saving the avatar fails', async () => {
  const state = createState();
  // Make an unintended refresh observable through the shared state.
  state.savedImage = NEW_IMAGE;
  const { refetchSession, refetchActiveOrganization } = handlers(state);

  await expect(
    persistUserAvatar({
      url: NEW_IMAGE,
      updateUser: async () => ({ error: { message: 'save failed' } }),
      refetchSession,
      refetchActiveOrganization,
    })
  ).rejects.toThrow('save failed');

  expect(state.sessionImage).toBe(OLD_IMAGE);
  expect(authorImage(state)).toBe(OLD_IMAGE);
});

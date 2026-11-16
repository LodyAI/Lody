import { z } from 'zod';

/** Only identity references cross Lody's catalog/turn boundary; never memory contents. */
export const MemoryBindingSchema = z
  .object({
    providerId: z.string().trim().min(1).max(100),
    memoryId: z.string().trim().min(1).max(200),
  })
  .strict();
export type MemoryBinding = z.infer<typeof MemoryBindingSchema>;

export const MemoryCreateInputSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    role: z.string().max(200).optional(),
    defaultSpace: z.string().max(200).optional(),
  })
  .strict();
export type MemoryCreateInput = z.infer<typeof MemoryCreateInputSchema>;
/**
 * One batch per request so a "connect everything" click stays a single call:
 * looping on the client would race the inventory refresh between installs.
 */
export const MemoryAgentTargetsSchema = z.array(z.string().trim().min(1).max(100)).min(1).max(50);
export const MemoryProviderRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), providerId: z.string().min(1).max(100) }).strict(),
  z
    .object({
      action: z.enum(['create', 'update']),
      providerId: z.string().min(1).max(100),
      input: MemoryCreateInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.enum(['connect', 'disconnect']),
      providerId: z.string().min(1).max(100),
      targets: MemoryAgentTargetsSchema,
    })
    .strict(),
  // `signIn` opens a flow, `signInPoll` asks whether the browser finished it;
  // `install` puts the provider on the machine, `installPoll` watches it land.
  // None carries a device code: the flow belongs to the machine that started
  // it, so the secret half never has to cross back through the UI.
  z
    .object({
      action: z.enum(['signIn', 'signInPoll', 'install', 'installPoll']),
      providerId: z.string().min(1).max(100),
    })
    .strict(),
]);
export type MemoryProviderRequest = z.infer<typeof MemoryProviderRequestSchema>;
export const MemoryIdentitySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  role: z.string().optional(),
});
export type MemoryIdentity = z.infer<typeof MemoryIdentitySchema>;

/**
 * How much a connected agent gains. `hook` agents let the provider run on every
 * turn, so recall and capture are automatic; `mcp` agents only receive the
 * provider's tools, which the model has to call on purpose.
 */
export const MemoryAgentIntegrationSchema = z.enum(['hook', 'mcp']);
export type MemoryAgentIntegration = z.infer<typeof MemoryAgentIntegrationSchema>;

/**
 * Why a row is inert, or how its last attempt ended. A code rather than a
 * sentence: the daemon has no locale, so only the UI can phrase these.
 */
export const MemoryAgentNoticeSchema = z.enum([
  'absent_on_machine',
  'cloud_disconnected',
  'connect_failed',
  'disconnect_failed',
  'deferred',
]);
export type MemoryAgentNotice = z.infer<typeof MemoryAgentNoticeSchema>;

/** A local agent a provider can attach itself to. Still no memory contents. */
export const MemoryAgentSchema = z
  .object({
    /** Lody's own agentType, so rows stay labelled the way the rest of Lody is. */
    id: z.string().min(1),
    /**
     * Other agentTypes Lody may report for the same harness. The panel lists
     * the machine's own agent configs, so it has to recognise a config saved
     * under an alias as the row it already has rather than a second agent.
     */
    aliases: z.array(z.string().min(1)).max(10).optional(),
    displayName: z.string(),
    integration: MemoryAgentIntegrationSchema,
    /** The provider covers this agent at all. */
    supported: z.boolean(),
    /** Supported, present on this machine, and the provider is ready to act. */
    connectable: z.boolean(),
    connected: z.boolean(),
    notice: MemoryAgentNoticeSchema.optional(),
  })
  .strict();
export type MemoryAgent = z.infer<typeof MemoryAgentSchema>;

/**
 * Where a browser sign-in has got to. `pending` carries the half the user has
 * to see — a page to open and a code to read back — and nothing else: a device
 * flow's own code stays on the machine that started it.
 */
export const MemorySignInSchema = z
  .object({
    status: z.enum(['pending', 'approved', 'expired']),
    /** The page the user approves on. Opened externally, so http(s) only. */
    verificationUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === 'https:' || protocol === 'http:';
      }, 'verificationUrl must use http or https')
      .optional(),
    /** Shown and copyable, for the browser that opened on the wrong page. */
    userCode: z.string().trim().min(1).max(128).optional(),
    expiresInSec: z.number().int().positive().max(86_400).optional(),
  })
  .strict();
export type MemorySignIn = z.infer<typeof MemorySignInSchema>;

/**
 * Where putting a provider on this machine has got to. Fetching a binary
 * outlasts the request that asked for it, so the job reports back across
 * several replies instead of holding one open.
 */
/**
 * Why an install failed, when the package manager said so in a way the user
 * can act on. Lody cannot raise its own permissions, and a machine with no npm
 * cannot take this path at all, so both are named rather than folded into a
 * plain failure.
 */
export const MemoryInstallFailureSchema = z.enum(['npm_missing', 'permission']);
export type MemoryInstallFailure = z.infer<typeof MemoryInstallFailureSchema>;
export const MemoryInstallSchema = z
  .object({
    status: z.enum(['running', 'done', 'failed']),
    /**
     * What a running install is fetching: the provider itself, or first the
     * runtime it is installed with when the machine had none that worked.
     */
    step: z.enum(['runtime', 'provider']).optional(),
    /** Only a failed install whose cause was recognised carries this. */
    failure: MemoryInstallFailureSchema.optional(),
  })
  .strict();
export type MemoryInstall = z.infer<typeof MemoryInstallSchema>;

export const MemoryProviderResponseSchema = z
  .object({
    type: z.literal('machine/memory'),
    status: z.enum(['ready', 'not_installed', 'not_running', 'error']),
    memories: z.array(MemoryIdentitySchema),
    /** Only agent-connect providers report this; identity providers omit it. */
    agents: z.array(MemoryAgentSchema).optional(),
    /**
     * Who this machine is signed in as. The panel does not show it today —
     * every provider there describes itself in one line, and an account
     * prefixed to one of them broke the symmetry that lets the two be
     * compared — but a confirmation that uploads history has to name it.
     */
    account: z.string().trim().min(1).max(320).optional(),
    /** Only answers to `signIn` and `signInPoll` carry this. */
    signIn: MemorySignInSchema.optional(),
    /** Only answers to `install` and `installPoll` carry this. */
    install: MemoryInstallSchema.optional(),
    error: z.string().optional(),
  })
  .strict();
export type MemoryProviderResponse = z.infer<typeof MemoryProviderResponseSchema>;

/** UI metadata only. Commands and environment mapping belong to the daemon adapter. */
export const MEMORY_PROVIDERS = [
  {
    id: 'nowledge-mem',
    name: 'Nowledge Mem',
    installUrl: 'https://mem.nowledge.co/en',
    createFields: ['name', 'id', 'description', 'role'],
  },
  {
    id: 'everme',
    name: 'EverMe',
    installUrl: 'https://github.com/EverMind-AI/EverMe',
    createFields: [],
  },
] as const;

/**
 * Providers that attach to the agents already on a machine instead of managing
 * named identities: one account holds one memory, and connecting an agent only
 * decides who may reach it. They render an agent list, never an identity editor.
 */
export const AGENT_CONNECT_PROVIDER_IDS = ['everme'] as const;
export const isAgentConnectProvider = (providerId: string): boolean =>
  (AGENT_CONNECT_PROVIDER_IDS as readonly string[]).includes(providerId);

/**
 * Providers whose sign-in Lody can drive itself, so a first-time user never
 * has to leave for a terminal or go hunting for an API key. Separate from the
 * list above on purpose: connecting agents and holding an account are two
 * different capabilities, and a provider may grow one without the other.
 */
export const SIGN_IN_PROVIDER_IDS = ['everme'] as const;
export const providerSignsIn = (providerId: string): boolean =>
  (SIGN_IN_PROVIDER_IDS as readonly string[]).includes(providerId);

/**
 * Providers Lody can fetch onto the machine rather than only link to. Listed
 * apart again: a provider may be installable long before Lody can sign in to
 * it, and a hosted one may be signed in to without ever being installed.
 */
export const INSTALL_PROVIDER_IDS = ['everme'] as const;
export const providerInstalls = (providerId: string): boolean =>
  (INSTALL_PROVIDER_IDS as readonly string[]).includes(providerId);

/**
 * Providers set up only from the machine itself. Each reaches one person's
 * account — signing it in, fetching its CLI, attaching that machine's agents
 * to it — so a request relayed from another device would bind this machine to
 * whoever sent it. Settings never sends these for another machine, and the
 * daemon refuses them on every channel but its own local one.
 */
export const isLocalOnlyMemoryProvider = (providerId: string): boolean =>
  isAgentConnectProvider(providerId) || providerSignsIn(providerId) || providerInstalls(providerId);

/** Lody's machine-scoped association; the provider continues to own memory contents. */
export const MemoryAssociationSchema = MemoryBindingSchema.extend({
  machineId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
}).strict();
export type MemoryAssociation = z.infer<typeof MemoryAssociationSchema>;

/** Only a successful authoritative inventory can establish that an identity was deleted. */
export function isMemoryIdentityMissing(
  binding: MemoryBinding,
  inventory: MemoryProviderResponse | undefined
): boolean {
  return (
    inventory?.status === 'ready' &&
    !inventory.memories.some((entry) => entry.id === binding.memoryId)
  );
}

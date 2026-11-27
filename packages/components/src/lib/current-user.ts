import { z } from 'zod';

export const CurrentUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  image: z.string().nullable().optional(),
});

export type CurrentUser = z.infer<typeof CurrentUserSchema>;

const SessionUserSchema = z
  .object({
    id: z.string().min(1).optional(),
    _id: z.string().min(1).optional(),
    email: z.string().email(),
    name: z.string().nullable().optional(),
    image: z.string().nullable().optional(),
  })
  .refine((value) => Boolean(value.id || value._id), {
    message: 'Session user is missing both id and _id',
  });

function resolveDisplayName(name: string | null | undefined, email: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length > 0) {
    return trimmed;
  }
  const localPart = email.split('@')[0]?.trim();
  if (localPart && localPart.length > 0) {
    return localPart;
  }
  return 'User';
}

export function normalizeCurrentUserFromSessionUser(sessionUser: unknown): CurrentUser {
  const parsed = SessionUserSchema.parse(sessionUser);
  return CurrentUserSchema.parse({
    id: parsed.id ?? parsed._id,
    email: parsed.email,
    name: resolveDisplayName(parsed.name, parsed.email),
    image: parsed.image,
  });
}

export function safeNormalizeCurrentUserFromSessionUser(sessionUser: unknown): CurrentUser | null {
  const parsed = SessionUserSchema.safeParse(sessionUser, { jitless: true });
  if (!parsed.success) {
    return null;
  }
  const normalized = CurrentUserSchema.safeParse(
    {
      id: parsed.data.id ?? parsed.data._id,
      email: parsed.data.email,
      name: resolveDisplayName(parsed.data.name, parsed.data.email),
      image: parsed.data.image,
    },
    { jitless: true }
  );
  return normalized.success ? normalized.data : null;
}

import { z } from 'zod';
import { CurrentUserSchema, type CurrentUser } from './current-user';

export const AUTH_TOKEN_STORAGE_KEY = 'lody_auth_token';
const AUTH_BOOTSTRAP_STORAGE_KEY = 'lody:auth-bootstrap';
const BOOTSTRAP_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const AuthBootstrapSnapshotSchema = z.object({
  user: CurrentUserSchema,
  updatedAt: z.number(),
});

export type AuthBootstrapSnapshot = z.infer<typeof AuthBootstrapSnapshotSchema>;

export function readStoredAuthToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function writeStoredAuthToken(token: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  } catch {}
}

export function clearStoredAuthToken(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {}
}

export function readAuthBootstrapSnapshot(): AuthBootstrapSnapshot | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = localStorage.getItem(AUTH_BOOTSTRAP_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = AuthBootstrapSnapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    if (Date.now() - parsed.data.updatedAt > BOOTSTRAP_SNAPSHOT_TTL_MS) {
      localStorage.removeItem(AUTH_BOOTSTRAP_STORAGE_KEY);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function readBootstrappedCurrentUser(): CurrentUser | null {
  return readAuthBootstrapSnapshot()?.user ?? null;
}

export function writeAuthBootstrapSnapshot(user: CurrentUser): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const snapshot: AuthBootstrapSnapshot = {
      user,
      updatedAt: Date.now(),
    };
    localStorage.setItem(AUTH_BOOTSTRAP_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore
  }
}

export function clearAuthBootstrapSnapshot(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.removeItem(AUTH_BOOTSTRAP_STORAGE_KEY);
  } catch {
    // ignore
  }
}

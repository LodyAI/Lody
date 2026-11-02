import { useCallback, useMemo, useState } from 'react';
import {
  generateWorkspaceSlug,
  getWorkspaceSlugRuleError,
  isUsableWorkspaceSlug,
  normalizeWorkspaceSlugInput,
  WorkspaceSlugRuleError,
} from '@/lib/workspace';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useAuthenticatedConvex } from './use-authenticated-convex';
import { useCloudQuery } from '@lody/platform/react';

export type WorkspaceSlugError = 'required' | WorkspaceSlugRuleError;

export const useWorkspaceSlugField = (workspaceName: string) => {
  const { isAuthenticated, isLoading: isAuthLoading } = useAuthenticatedConvex();
  // When manuallyEdited is false, slug is derived directly from suggestedSlug
  // (no effect needed to keep them in sync)
  const [manualSlug, setManualSlug] = useState('');
  const [manuallyEdited, setManuallyEdited] = useState(false);
  const suggestedSlug = useMemo(() => generateWorkspaceSlug(workspaceName), [workspaceName]);

  const slug = manuallyEdited ? manualSlug : suggestedSlug;

  const updateSlug = useCallback((value: string) => {
    setManuallyEdited(true);
    setManualSlug(normalizeWorkspaceSlugInput(value));
  }, []);

  const resetSlug = useCallback(() => {
    setManuallyEdited(false);
    setManualSlug('');
  }, []);

  const shouldCheck = isUsableWorkspaceSlug(slug);
  const canCheckAvailability = shouldCheck && isAuthenticated;
  const slugCheckArgs = shouldCheck ? { slug } : 'skip';
  // Keep the union explicit so the query is skipped until both auth and slug are ready.
  const availability = useCloudQuery(
    cloudOperations.auth.isWorkspaceSlugAvailable,
    slugCheckArgs as { slug: string } | 'skip'
  );

  const isChecking =
    shouldCheck && (isAuthLoading || (canCheckAvailability && availability === undefined));
  const isAvailable = canCheckAvailability && Boolean(availability?.available);

  const error = useMemo<WorkspaceSlugError | null>(() => {
    if (!slug) {
      return 'required';
    }
    const formatError = getWorkspaceSlugRuleError(slug);
    if (formatError) {
      return formatError;
    }
    if (shouldCheck && !isChecking && !isAvailable) {
      return 'unavailable';
    }
    return null;
  }, [slug, shouldCheck, isChecking, isAvailable]);

  return {
    slug,
    setSlug: updateSlug,
    resetSlug,
    canReset: manuallyEdited && slug !== suggestedSlug,
    isChecking,
    isAvailable,
    error,
  };
};

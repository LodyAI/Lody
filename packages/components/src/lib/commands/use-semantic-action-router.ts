import { useLayoutEffect, useRef, type RefObject } from 'react';
import {
  createSemanticActionRouter,
  type SemanticActionScope,
  type SemanticActionRouter,
} from './semantic-action-router';

export function useSemanticActionRouter({
  rootRef,
  enabled,
  resetKey,
  defaultScopeId,
  scopes,
  routerRef: providedRouterRef,
}: {
  rootRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  resetKey: string;
  defaultScopeId: string;
  scopes: Record<string, SemanticActionScope['actions']>;
  routerRef?: RefObject<SemanticActionRouter | null>;
}) {
  const actionsRef = useRef(scopes);
  actionsRef.current = scopes;
  const internalRouterRef = useRef<SemanticActionRouter | null>(null);
  const routerRef = providedRouterRef ?? internalRouterRef;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return undefined;
    const router = createSemanticActionRouter(
      root,
      () => {
        const elements = Array.from(root.querySelectorAll<HTMLElement>('[data-lody-action-scope]'));
        return Object.entries(actionsRef.current).map(([id, actions]) => ({
          id,
          element: elements.find((element) => element.dataset.lodyActionScope === id) ?? null,
          actions,
        }));
      },
      defaultScopeId
    );
    routerRef.current = router;
    return () => {
      router.dispose();
      routerRef.current = null;
    };
  }, [rootRef, enabled, resetKey, defaultScopeId, routerRef]);

  return routerRef;
}

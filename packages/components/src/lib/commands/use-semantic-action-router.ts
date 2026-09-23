import { useLayoutEffect, useRef, type RefObject } from 'react';
import { createSemanticActionRouter, type SemanticActionScope } from './semantic-action-router';

export function useSemanticActionRouter({
  rootRef,
  enabled,
  resetKey,
  defaultScopeId,
  scopes,
}: {
  rootRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  resetKey: string;
  defaultScopeId: string;
  scopes: Record<string, SemanticActionScope['actions']>;
}) {
  const actionsRef = useRef(scopes);
  actionsRef.current = scopes;
  const routerRef = useRef<ReturnType<typeof createSemanticActionRouter> | null>(null);

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
  }, [rootRef, enabled, resetKey, defaultScopeId]);

  useLayoutEffect(() => {
    routerRef.current?.refresh();
  });
  return routerRef;
}

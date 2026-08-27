import { createContext, useContext, type ReactNode } from 'react';

const WorkspaceRouteTargetContext = createContext<string | null>(null);

export function WorkspaceRouteTargetProvider({
  slug,
  children,
}: {
  slug: string;
  children: ReactNode;
}) {
  return (
    <WorkspaceRouteTargetContext.Provider value={slug}>
      {children}
    </WorkspaceRouteTargetContext.Provider>
  );
}

export function useWorkspaceRouteTargetSlug(): string | null {
  return useContext(WorkspaceRouteTargetContext);
}

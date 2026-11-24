import { createContext, useContext, type ReactNode } from 'react';

export type ConversationPaneSearch = {
  tab?: string;
  pr?: number;
  browser?: boolean;
  simulator?: boolean;
};

export type ConversationPaneController = {
  focused: boolean;
  scopeId?: string;
  actions: ReactNode;
  setSearch: (patch: ConversationPaneSearch, options?: { push?: boolean }) => void;
  setTab: (tab: string | undefined, options?: { push?: boolean }) => void;
};

export const ConversationPaneContext = createContext<ConversationPaneController | null>(null);
export const useConversationPane = () => useContext(ConversationPaneContext);

export function useConversationFocusScope(scope: string): string {
  const pane = useConversationPane();
  return pane?.scopeId ? `${scope}:${pane.scopeId}` : scope;
}

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { TodayEditorController } from './today-editor-controller';

export const TodayEditorContext = createContext<TodayEditorController | null>(null);

/** The surface's editor controller; re-renders when the active node changes. */
export function useTodayEditor(): TodayEditorController | null {
  const controller = useContext(TodayEditorContext);
  useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getVersion ?? zeroVersion
  );
  return controller;
}

const noopSubscribe = () => () => {};
const zeroVersion = () => 0;

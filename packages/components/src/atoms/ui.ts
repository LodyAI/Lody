import { atom } from 'jotai';

/**
 * 移动端 secondary navigation Drawer 的开关状态。
 * Phase 1 后移动端主导航由 bottom navigation 承担，Drawer 只保留深层入口和过渡期 fallback。
 */
export const mobileDrawerOpenAtom = atom(false);

/**
 * 设置移动端 secondary navigation Drawer 开关状态的 atom
 */
export const setMobileDrawerOpenAtom = atom(null, (_get, set, isOpen: boolean) => {
  set(mobileDrawerOpenAtom, isOpen);
});

/**
 * 切换移动端 secondary navigation Drawer 开关状态的 atom
 */
export const toggleMobileDrawerAtom = atom(null, (get, set) => {
  set(mobileDrawerOpenAtom, !get(mobileDrawerOpenAtom));
});

/**
 * Remembered home/project context for the persistent mobile workspace base.
 *
 * On mobile the home/project landing stays mounted *underneath* the session
 * detail overlay (see `MobileWorkspaceStack`) so going back reveals it live —
 * mirroring how the session detail page stays mounted under the PR drawer.
 * The base reads its context live from the `/chat` route search while that
 * route is active; once the user drills into a session (where the chat search
 * is gone from the URL) the base falls back to this remembered value so it
 * keeps showing the page the session was opened from.
 *
 * Deliberately NOT persisted: on a cold load that deep-links straight to a
 * session there is no origin page, so the base should default to home rather
 * than resurrect a stale context from a previous visit.
 */
export type MobileWorkspaceBaseContext = {
  context?: 'local' | 'github' | 'chat';
  machine?: string;
  project?: string;
  repo?: string;
};

export const mobileWorkspaceBaseContextAtom = atom<MobileWorkspaceBaseContext>({});

/**
 * 全局数据加载状态
 * 用于跟踪哪些数据已经被加载过，避免重复请求
 */
export interface DataLoadingState {
  projects: boolean;
  machines: boolean;
  agents: boolean;
}

export const dataLoadedAtom = atom<DataLoadingState>({
  projects: false,
  machines: false,
  agents: false,
});

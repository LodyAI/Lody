import { createContext, useContext, type ReactNode, type RefObject } from 'react';

/** What Base UI's Portal accepts as its mount point. */
export type PopupContainer = HTMLElement | RefObject<HTMLElement | null> | null | undefined;

const PopupContainerContext = createContext<PopupContainer>(undefined);

/**
 * Where the popups below this point mount.
 *
 * A floating list defaults to `document.body`, which is right on a page and
 * wrong inside a modal that owns its own focus scope and scroll lock: a popup
 * mounted outside that subtree is "outside" to the modal, so focus is pulled
 * back to it and the wheel is swallowed before the list can scroll. The surface
 * that owns such a modal states its container once here, and every Select and
 * Combobox under it mounts inside the modal instead.
 *
 * It is a container rather than a flag so this package needs no knowledge of
 * which modal implementation a host uses; the host names the element.
 */
export function PopupContainerProvider({
  container,
  children,
}: {
  container: PopupContainer;
  children: ReactNode;
}) {
  return (
    <PopupContainerContext.Provider value={container}>{children}</PopupContainerContext.Provider>
  );
}

/** The container a popup mounts into, or `undefined` for the document body. */
export function usePopupContainer(): PopupContainer {
  return useContext(PopupContainerContext);
}

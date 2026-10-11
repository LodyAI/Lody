import * as stylex from '@stylexjs/stylex';
import { createContext, useContext, type ReactNode, type RefObject } from 'react';

/** What Base UI's Portal accepts as its mount point. */
export type PopupContainer = HTMLElement | RefObject<HTMLElement | null> | null | undefined;

// Modal hosts are separate from floating popup hosts: a centered panel's
// transform must not become the containing block for the next fixed modal.
const ModalContainerContext = createContext<PopupContainer>(undefined);

/** A host modal's interaction scope for nested modal portals. */
export function ModalContainerProvider({
  container,
  children,
}: {
  container: PopupContainer;
  children: ReactNode;
}) {
  return (
    <ModalContainerContext.Provider value={container}>{children}</ModalContainerContext.Provider>
  );
}

export function useModalContainer(): PopupContainer {
  return useContext(ModalContainerContext);
}

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

const styles = stylex.create({
  portal: { display: 'contents' },
});

/**
 * The class every popup's portal element takes.
 *
 * Base UI mounts a popup through a `<div>` of its own, appended to the
 * container. In a named container that div is a child of the host's layout: a
 * modal panel is a flex column with a `gap`, so each Select opened in it added
 * one more flex item and one more gap, and the portals stay mounted after the
 * list closes — the footer climbed and left a strip of empty panel under it.
 * The positioner inside is out of flow either way, so the wrapper needs no box.
 */
export const portalClassName = stylex.props(styles.portal).className;

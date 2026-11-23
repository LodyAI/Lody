import { Drawer, type DrawerContentProps } from '@lody/ui/drawer';
import { usePopupContainer } from '@lody/ui/popup-container';

/** Keep the mobile diff in the enclosing session drawer's pointer and focus scope. */
export function SessionMobileDiffDrawerContent(props: Omit<DrawerContentProps, 'container'>) {
  const container = usePopupContainer();
  // A body portal inherits Vaul/Radix's pointer-events:none and lets gestures
  // reach the conversation beneath it. The host lives outside scrolling content.
  return <Drawer.Content {...props} container={container} />;
}

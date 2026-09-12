import { Portal as PortalPrimitive, type PortalProps } from '@diceui/shared';
import * as React from 'react';
import { useMentionContext } from './mention-root';

const PORTAL_NAME = 'MentionPortal';

interface MentionPortalProps extends Pick<PortalProps, 'container' | 'children'> {}

const MentionPortal = React.forwardRef<HTMLDivElement, MentionPortalProps>(
  (props, forwardedRef) => {
    const { container, ...portalProps } = props;
    const context = useMentionContext(PORTAL_NAME);
    const [owner, setOwner] = React.useState<HTMLElement | null>(null);
    React.useLayoutEffect(() => {
      // A body portal falls outside Radix's interactive/scrollable modal subtree.
      // Mount beside the editor's scrolling body, inside its nearest modal layer.
      setOwner(
        context.inputRef.current?.closest<HTMLElement>(
          '[data-lody-dialog-content], [data-vaul-drawer]'
        ) ?? null
      );
    }, [context.inputRef, context.open]);

    return (
      <PortalPrimitive
        container={container !== undefined ? container : (owner ?? undefined)}
        {...portalProps}
        ref={forwardedRef}
        asChild
      />
    );
  }
);

MentionPortal.displayName = PORTAL_NAME;

const Portal = MentionPortal;

export { MentionPortal, Portal };

export type { MentionPortalProps };

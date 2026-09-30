import * as React from 'react';
import { Card as UiCard } from '@lody/ui/card';

/**
 * Product adapter over `@lody/ui`'s Card. The old wrapper had a `CardContent`
 * body section; the new root is already a padded flex column, so the section
 * survives as a plain block callers can still hang layout classes on.
 */
const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardContent(props, ref) {
    return <div ref={ref} {...props} />;
  }
);

export const Card = {
  ...UiCard,
  Content: CardContent,
};

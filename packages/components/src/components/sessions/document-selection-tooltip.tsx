import type { ReactElement, ReactNode } from 'react';
import { Tooltip } from '@lody/ui/tooltip';

export function DocumentSelectionTooltip({
  content,
  children,
}: {
  readonly content: ReactNode;
  readonly children: ReactElement;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Content>{content}</Tooltip.Content>
    </Tooltip.Root>
  );
}

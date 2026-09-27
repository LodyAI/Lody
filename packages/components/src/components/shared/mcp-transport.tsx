import { Globe, SquareTerminal } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import type { McpTransport } from '@lody/shared';
import { withClassName } from '@/lib/stylex';

const styles = stylex.create({
  icon: { width: '14px', height: '14px' },
});

/** Selection order for every transport picker. */
export const MCP_TRANSPORTS: readonly McpTransport[] = ['stdio', 'http'];

/** Transport names stay literal — `stdio` and Streamable HTTP are the MCP
 *  spec's own identifiers, so they read the same in every locale. */
export const MCP_TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: 'stdio',
  http: 'Streamable HTTP',
};

/** For width-constrained controls (the segmented transport switch). */
export const MCP_TRANSPORT_SHORT_LABELS: Record<McpTransport, string> = {
  stdio: 'stdio',
  http: 'HTTP',
};

export function McpTransportIcon({
  transport,
  className,
}: {
  transport: McpTransport;
  className?: string;
}) {
  const Icon = transport === 'http' ? Globe : SquareTerminal;
  return <Icon {...withClassName(stylex.props(styles.icon), className)} aria-hidden="true" />;
}

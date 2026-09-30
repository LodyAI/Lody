import { createFileRoute } from '@tanstack/react-router';
import { CodingAgentRemotePage, codingAgentHead } from '@site/src/site-pages/coding-agents';

export const Route = createFileRoute('/coding-agent-remote-control')({
  head: () => codingAgentHead('remote'),
  component: CodingAgentRemotePage,
});

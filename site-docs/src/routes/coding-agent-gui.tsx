import { createFileRoute } from '@tanstack/react-router';
import { CodingAgentGuiPage, codingAgentHead } from '@site/src/site-pages/coding-agents';

export const Route = createFileRoute('/coding-agent-gui')({
  head: () => codingAgentHead('gui'),
  component: CodingAgentGuiPage,
});

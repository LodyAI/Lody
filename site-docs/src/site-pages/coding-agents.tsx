import {
  CodingAgentGuiPage,
  CodingAgentRemotePage,
  type CodingAgentPageKind,
} from '@site/components/coding-agent-pages';
import { brandTitle, pageHead } from '@site/lib/metadata';

export function codingAgentHead(kind: Exclude<CodingAgentPageKind, 'scheduler'>) {
  return pageHead({
    title: brandTitle(
      kind === 'gui' ? 'One GUI for Your Coding Agents' : 'Remote Control for Your Coding Agents'
    ),
    description:
      kind === 'gui'
        ? 'A unified GUI for Codex, Claude Code, Kimi Code, GLM over Claude Code, DeepSeek Harness, and Pi. Run tasks and review changes in Lody.'
        : 'Control coding agents on your connected machine from your phone or browser. Explore Lody remote access for Codex, Claude Code, Kimi Code, GLM, DeepSeek Harness, and Pi.',
    path: kind === 'gui' ? '/coding-agent-gui/' : '/coding-agent-remote-control/',
    locale: 'en-US',
  });
}

export { CodingAgentGuiPage, CodingAgentRemotePage };

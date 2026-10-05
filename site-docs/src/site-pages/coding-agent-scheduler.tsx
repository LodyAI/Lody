import { CodingAgentSchedulerPage } from '@site/components/coding-agent-scheduler-page';
import { brandTitle, pageHead } from '@site/lib/metadata';

export function codingAgentSchedulerHead() {
  return pageHead({
    title: brandTitle('Coding Agent Scheduler'),
    description:
      'Schedule Codex, Claude Code, Kimi Code, GLM over Claude Code, DeepSeek Harness, and Pi tasks in Lody. Choose a machine, review the schedule, and follow each run.',
    path: '/coding-agent-scheduler/',
    locale: 'en-US',
  });
}

export { CodingAgentSchedulerPage };

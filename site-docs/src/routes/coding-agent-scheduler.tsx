import { createFileRoute } from '@tanstack/react-router';
import {
  CodingAgentSchedulerPage,
  codingAgentSchedulerHead,
} from '@site/src/site-pages/coding-agent-scheduler';

export const Route = createFileRoute('/coding-agent-scheduler')({
  head: codingAgentSchedulerHead,
  component: CodingAgentSchedulerPage,
});

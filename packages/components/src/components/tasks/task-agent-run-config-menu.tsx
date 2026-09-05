import { AgentRunConfigMenu, type AgentRunConfigMenuProps } from '../shared/agent-run-config-menu';
import { TASKS_MENU_CLASS, tasksMenuSurfaceStyle } from './tasks-surface';
export type TaskAgentRunConfigMenuProps = AgentRunConfigMenuProps;
export function TaskAgentRunConfigMenu(props: TaskAgentRunConfigMenuProps) {
  return (
    <AgentRunConfigMenu
      menuClassName={TASKS_MENU_CLASS}
      menuStyle={tasksMenuSurfaceStyle}
      {...props}
    />
  );
}

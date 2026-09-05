import { ProjectRefSelector, type ProjectRefSelectorProps } from '../shared/project-ref-selector';
import { TASKS_MENU_CLASS, tasksMenuSurfaceStyle } from './tasks-surface';
export type TaskProjectSelectorProps = ProjectRefSelectorProps;
export function TaskProjectSelector(props: TaskProjectSelectorProps) {
  return (
    <ProjectRefSelector
      menuClassName={TASKS_MENU_CLASS}
      menuStyle={tasksMenuSurfaceStyle}
      {...props}
    />
  );
}

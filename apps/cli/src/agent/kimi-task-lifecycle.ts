import { convertTaskLifecycleNotification } from './claude-task-lifecycle';

export const convertKimiTaskLifecycleNotification = (params: unknown) =>
  convertTaskLifecycleNotification(params, {
    defaultActor: 'Kimi task',
    taskMetaFallbackActor: 'Kimi task',
  });

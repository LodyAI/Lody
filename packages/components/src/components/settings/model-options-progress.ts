import type { TFunction } from 'i18next';
import type { AcpModelOptionsRefreshProgress } from '@/hooks/use-refresh-machine-acp-capabilities';

/** "Reading options for <model> (3/40)": the model a refresh is reading right now. */
export function formatModelOptionsProgressText(
  t: TFunction,
  progress: AcpModelOptionsRefreshProgress
): string {
  return t(
    'settings.agent.provider.readingModelOptions',
    'Reading options for {{model}} ({{index}}/{{total}})',
    { model: progress.modelName, index: progress.index, total: progress.total }
  );
}

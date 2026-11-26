import type { SiteLocale } from '@site/src/site-pages/shared';
import {
  ReplicaBranchWorktreePill,
  ReplicaPermissionModeTrigger,
  ReplicaProjectSelectorTrigger,
  ReplicaRunConfigTrigger,
} from '../landing-replica/composer-controls';

/* Display-only docs preview of the home composer's repository and branch
   pickers. It reuses the landing replica's trigger markup with synthetic data,
   so the GitHub guide does not ship a stale screenshot of the old home page. */

type Copy = {
  branch: string;
  caption: string;
  permission: string;
  placeholder: string;
  repo: string;
};

const COPY: Record<SiteLocale, Copy> = {
  en: {
    branch: 'main',
    caption:
      'Mock composer. Choose a workspace repository in the top-left selector, then pick its branch.',
    permission: 'Agent (full access)',
    placeholder: 'Tell the agent what you need.',
    repo: 'loro-dev/lody',
  },
  zh: {
    branch: 'main',
    caption: '模拟输入框。在左上角选择工作区里的仓库，再选择对应的分支。',
    permission: 'Agent（完全访问）',
    placeholder: '告诉 Agent 你需要什么。',
    repo: 'loro-dev/lody',
  },
  'zh-hant': {
    branch: 'main',
    caption: '模擬輸入框。在左上角選擇工作區中的儲存庫，再選擇對應的分支。',
    permission: 'Agent（完全存取）',
    placeholder: '告訴 Agent 你需要什麼。',
    repo: 'loro-dev/lody',
  },
  ja: {
    branch: 'main',
    caption:
      'モック入力欄です。左上のセレクターでワークスペースのリポジトリを選び、ブランチを指定します。',
    permission: 'Agent（フルアクセス）',
    placeholder: 'エージェントにやりたいことを伝えてください。',
    repo: 'loro-dev/lody',
  },
  ko: {
    branch: 'main',
    caption:
      '모의 입력창입니다. 왼쪽 위 선택기에서 워크스페이스 저장소를 고른 다음 브랜치를 선택하세요.',
    permission: 'Agent(전체 액세스)',
    placeholder: '에이전트에게 필요한 작업을 알려주세요.',
    repo: 'loro-dev/lody',
  },
  es: {
    branch: 'main',
    caption:
      'Compositor de ejemplo. Elige un repositorio del espacio de trabajo en el selector superior izquierdo y luego selecciona su rama.',
    permission: 'Agent (acceso total)',
    placeholder: 'Indica al agente qué necesitas.',
    repo: 'loro-dev/lody',
  },
  fr: {
    branch: 'main',
    caption:
      'Zone de saisie factice. Choisissez un dépôt de l’espace de travail dans le sélecteur en haut à gauche, puis sélectionnez sa branche.',
    permission: 'Agent (accès complet)',
    placeholder: 'Indiquez à l’agent ce dont vous avez besoin.',
    repo: 'loro-dev/lody',
  },
  ru: {
    branch: 'main',
    caption:
      'Демонстрационное поле ввода. Выберите репозиторий рабочего пространства в верхнем левом списке, затем укажите его ветку.',
    permission: 'Agent (полный доступ)',
    placeholder: 'Расскажите агенту, что нужно сделать.',
    repo: 'loro-dev/lody',
  },
};

/** The repo/branch row above the home composer, with synthetic repository data. */
export function GithubRepoPickerPreview({ locale = 'en' }: { locale?: SiteLocale }) {
  const copy = COPY[locale];
  return (
    <div className="my-6">
      <div
        aria-hidden="true"
        className="lody-app-preview [--composer:var(--muted)] overflow-hidden rounded-xl border border-border bg-background p-4 text-foreground shadow-sm sm:p-6"
      >
        <div className="mx-auto w-full max-w-2xl">
          <div className="flex w-full min-w-0 select-none items-center gap-1">
            <ReplicaProjectSelectorTrigger label={copy.repo} kind="github" locale={locale} />
            <ReplicaBranchWorktreePill
              branch={copy.branch}
              worktree={false}
              showWorktree={false}
              locale={locale}
            />
          </div>
          <div className="mt-1 flex flex-col rounded-xl border border-foreground/[0.10] bg-[hsl(var(--composer))] px-2 py-1.5 dark:border-input-border/70 dark:bg-input/90">
            <div className="min-h-[88px] px-1 pt-1 text-sm text-input-placeholder/40">
              {copy.placeholder}
            </div>
            <div className="flex items-center gap-1.5 pt-0.5">
              <ReplicaRunConfigTrigger agent="codex" modelLabel="5.3-codex" thinkLabel="xhigh" />
              <ReplicaPermissionModeTrigger label={copy.permission} modeId="agent-full-access" />
            </div>
          </div>
        </div>
      </div>
      <div className="mt-2 text-center text-xs text-muted-foreground">{copy.caption}</div>
    </div>
  );
}

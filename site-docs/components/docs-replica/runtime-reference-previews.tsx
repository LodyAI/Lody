import type { SiteLocale } from '@site/src/site-pages/shared';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowUp,
  Boxes,
  Bot,
  Braces,
  Check,
  ChevronDown,
  Clock,
  Code,
  Coins,
  Cpu,
  Gauge,
  Gem,
  LoaderCircle,
  Pause,
  Play,
  Sparkles,
  SquareTerminal,
  Target,
  Terminal,
  X,
  Zap,
} from 'lucide-react';
import { ReplicaRunConfigTrigger } from '../landing-replica/composer-controls';
import { cn } from '../landing-replica/utils';

/* Display-only previews for the docs' runtime reference and Claude/Codex
   capability pages. They replace static screenshots with synthetic data and
   intentionally reuse only site-docs relative primitives plus lucide-react.
   Source markup/copy was copied from the app files named on each component;
   none of these previews import the app, @lody/*, Convex, jotai, or i18next. */

const PREVIEW_SHELL =
  'lody-app-preview overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-sm';
const CAPTION_CLASS = 'mt-2 text-center text-xs text-muted-foreground';

type PreviewProps = { locale?: SiteLocale };

// ─── Agent config type selector ─────────────────────────────────────────────
// Source: packages/components/src/components/settings/agent-config-dialog.tsx
// Story: packages/components/src/stories/AgentConfigDialog.stories.tsx

type AgentConfigCopy = {
  title: string;
  claude: string;
  codex: string;
  caption: string;
};

const AGENT_CONFIG_COPY: Record<SiteLocale, AgentConfigCopy> = {
  en: {
    title: 'Configuration Type',
    claude: 'Claude',
    codex: 'Codex',
    caption:
      'Mock selector. Choose Claude for Claude-compatible endpoints or Codex for OpenAI runtimes.',
  },
  zh: {
    title: '配置类型',
    claude: 'Claude',
    codex: 'Codex',
    caption: '模拟选择器。Claude 用于 Claude 兼容端点，Codex 用于 OpenAI 运行时。',
  },
  'zh-hant': {
    title: '設定類型',
    claude: 'Claude',
    codex: 'Codex',
    caption: '模擬選擇器。Claude 用於 Claude 相容端點，Codex 用於 OpenAI 執行環境。',
  },
  ja: {
    title: '構成タイプ',
    claude: 'Claude',
    codex: 'Codex',
    caption:
      'モックセレクターです。Claude 互換エンドポイントには Claude を、OpenAI ランタイムには Codex を選択します。',
  },
  ko: {
    title: '구성 유형',
    claude: 'Claude',
    codex: 'Codex',
    caption:
      '모의 선택기입니다. Claude 호환 엔드포인트는 Claude를, OpenAI 런타임은 Codex를 선택하세요.',
  },
  es: {
    title: 'Tipo de configuración',
    claude: 'Claude',
    codex: 'Codex',
    caption:
      'Selector de ejemplo. Elige Claude para endpoints compatibles con Claude o Codex para entornos de ejecución de OpenAI.',
  },
  fr: {
    title: 'Type de configuration',
    claude: 'Claude',
    codex: 'Codex',
    caption:
      'Sélecteur factice. Choisissez Claude pour les points de terminaison compatibles avec Claude ou Codex pour les environnements d’exécution OpenAI.',
  },
  ru: {
    title: 'Тип конфигурации',
    claude: 'Claude',
    codex: 'Codex',
    caption:
      'Демонстрационный список выбора. Выберите Claude для Claude-совместимых эндпоинтов или Codex для сред выполнения OpenAI.',
  },
};

/** Static configuration-type select with its option list held open. */
export function AgentConfigPreview({ locale = 'en' }: PreviewProps) {
  const copy = AGENT_CONFIG_COPY[locale];
  return (
    <div className="my-6">
      <div aria-hidden="true" className={cn(PREVIEW_SHELL, 'p-4 sm:p-6')}>
        <div className="mx-auto w-full max-w-[320px]">
          <div className="mb-2 text-base font-semibold tracking-tight sm:text-lg">{copy.title}</div>
          <div className="relative">
            <div className="flex h-11 items-center justify-between rounded-lg border border-input-border bg-card px-3 text-base font-medium shadow-xs">
              <span>{copy.claude}</span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
              <div className="flex items-center justify-between bg-selection px-3 py-2.5 text-base">
                <span>{copy.claude}</span>
                <Check className="h-4 w-4" strokeWidth={2.5} />
              </div>
              <div className="px-3 py-2.5 text-base">{copy.codex}</div>
            </div>
          </div>
        </div>
      </div>
      <p className={CAPTION_CLASS}>{copy.caption}</p>
    </div>
  );
}

// ─── Registry runtime picker ────────────────────────────────────────────────
// Source: packages/components/src/components/settings/provider-row.tsx,
// provider-setup-row.tsx, agent-config-dialog.tsx
// Stories: packages/components/src/stories/ProviderRow.stories.tsx,
// ProviderSetupRow.stories.tsx

type RuntimeOption = {
  name: string;
  icon: LucideIcon;
};

const REGISTRY_RUNTIMES: RuntimeOption[] = [
  { name: 'Auggie CLI', icon: SquareTerminal },
  { name: 'Autohand Code', icon: Bot },
  { name: 'Cline', icon: Code },
  { name: 'Codebuddy Code', icon: Braces },
  { name: 'Factory Droid', icon: Cpu },
  { name: 'Gemini CLI', icon: Sparkles },
  { name: 'Kimi CLI', icon: Gem },
  { name: 'OpenCode', icon: Terminal },
  { name: 'Qwen Code', icon: Boxes },
  { name: 'pi ACP', icon: Bot },
];

type CliRuntimeCopy = {
  title: string;
  subtitle: string;
  experimental: string;
  caption: string;
};

const CLI_RUNTIME_COPY: Record<SiteLocale, CliRuntimeCopy> = {
  en: {
    title: 'ACP Provider',
    subtitle: 'Runtimes from the ACP Registry',
    experimental: 'Experimental',
    caption:
      'Mock registry picker. Install the selected runtime on the target machine before running it.',
  },
  zh: {
    title: 'ACP 运行时',
    subtitle: '来自 ACP Registry 的运行时',
    experimental: '实验性',
    caption: '模拟注册表选择器。使用前需在目标机器上安装所选运行时。',
  },
  'zh-hant': {
    title: 'ACP 執行環境',
    subtitle: '來自 ACP Registry 的執行環境',
    experimental: '實驗性',
    caption: '模擬登錄檔選擇器。執行前需先在目標機器上安裝所選執行環境。',
  },
  ja: {
    title: 'ACP プロバイダー',
    subtitle: 'ACP Registry のランタイム',
    experimental: '実験的',
    caption:
      'モックレジストリ選択画面です。実行する前に、対象マシンに選択したランタイムをインストールしてください。',
  },
  ko: {
    title: 'ACP 프로바이더',
    subtitle: 'ACP Registry의 런타임',
    experimental: '실험적',
    caption:
      '모의 레지스트리 선택기입니다. 실행하기 전에 대상 머신에 선택한 런타임을 먼저 설치하세요.',
  },
  es: {
    title: 'Proveedor ACP',
    subtitle: 'Entornos de ejecución del registro ACP',
    experimental: 'Experimental',
    caption:
      'Selector de registro de ejemplo. Instala el entorno de ejecución seleccionado en la máquina de destino antes de ejecutarlo.',
  },
  fr: {
    title: 'Fournisseur ACP',
    subtitle: 'Environnements d’exécution du registre ACP',
    experimental: 'Expérimental',
    caption:
      'Sélecteur de registre factice. Installez l’environnement d’exécution choisi sur la machine cible avant de l’utiliser.',
  },
  ru: {
    title: 'Провайдер ACP',
    subtitle: 'Среды выполнения из реестра ACP',
    experimental: 'Экспериментально',
    caption:
      'Демонстрационный выбор из реестра. Перед запуском установите выбранную среду выполнения на целевой машине.',
  },
};

/** Static list of registry runtimes, copied from the provider picker rows. */
export function CliRuntimePreview({ locale = 'en' }: PreviewProps) {
  const copy = CLI_RUNTIME_COPY[locale];
  return (
    <div className="my-6">
      <div aria-hidden="true" className={cn(PREVIEW_SHELL, 'p-4 sm:p-6')}>
        <div className="mx-auto w-full max-w-3xl">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">{copy.title}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{copy.subtitle}</div>
            </div>
            <span className="rounded-full border border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              ACP
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {REGISTRY_RUNTIMES.map(({ name, icon: Icon }) => (
              <div
                key={name}
                className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/70 bg-card px-3 py-2.5"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="truncate text-sm font-medium">{name}</span>
                </span>
                <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {copy.experimental}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className={CAPTION_CLASS}>{copy.caption}</p>
    </div>
  );
}

// ─── Fast / Think run-config controls ───────────────────────────────────────
// Source: packages/components/src/components/sessions/desktop-run-config-menu.tsx,
// packages/components/src/components/mobile/mobile-fast-plan-toggles.tsx

type FastModeCopy = {
  model: string;
  thinking: string;
  fast: string;
  on: string;
  tradeoff: string;
  caption: string;
};

const FAST_MODE_COPY: Record<SiteLocale, FastModeCopy> = {
  en: {
    model: 'gpt-5.5',
    thinking: 'Xhigh',
    fast: 'Fast',
    on: 'On',
    tradeoff: 'Tradeoff:',
    caption:
      'Fast mode uses the quickest inference tier for future turns — roughly 2.5× faster at a higher cost per token.',
  },
  zh: {
    model: 'gpt-5.5',
    thinking: 'Xhigh',
    fast: 'Fast',
    on: '开',
    tradeoff: '权衡：',
    caption: 'Fast 模式会为后续轮次使用最快的推理档位——速度约提升 2.5 倍，但每个 token 成本更高。',
  },
  'zh-hant': {
    model: 'gpt-5.5',
    thinking: 'Xhigh',
    fast: 'Fast',
    on: '開',
    tradeoff: '權衡：',
    caption: 'Fast 模式會為後續回合使用最快的推論層級——速度約提升 2.5 倍，但每 token 成本較高。',
  },
  ja: {
    model: 'gpt-5.5',
    thinking: 'Xhigh',
    fast: 'Fast',
    on: 'オン',
    tradeoff: 'トレードオフ：',
    caption:
      'Fast モードは以降のターンに最速の推論ティアを使用します。速度は約 2.5 倍になりますが、トークンあたりのコストが高くなります。',
  },
  ko: {
    model: 'gpt-5.5',
    thinking: 'Xhigh',
    fast: 'Fast',
    on: '켜짐',
    tradeoff: '트레이드오프:',
    caption:
      'Fast 모드는 이후 턴에 가장 빠른 추론 티어를 사용합니다. 속도는 약 2.5배 빨라지지만 토큰당 비용이 더 높습니다.',
  },
  es: {
    model: 'gpt-5.5',
    thinking: 'Xhigh',
    fast: 'Fast',
    on: 'Activado',
    tradeoff: 'Compromiso:',
    caption:
      'El modo Fast utiliza el nivel de inferencia más rápido para los siguientes turnos: aproximadamente 2,5× más rápido a un mayor coste por token.',
  },
  fr: {
    model: 'gpt-5.5',
    thinking: 'Xhigh',
    fast: 'Fast',
    on: 'Activé',
    tradeoff: 'Compromis :',
    caption:
      'Le mode Fast utilise le niveau d’inférence le plus rapide pour les tours suivants : environ 2,5× plus rapide pour un coût par jeton plus élevé.',
  },
  ru: {
    model: 'gpt-5.5',
    thinking: 'Xhigh',
    fast: 'Fast',
    on: 'Вкл',
    tradeoff: 'Компромисс:',
    caption:
      'Режим Fast использует самый быстрый уровень инференса для следующих ходов — примерно в 2,5 раза быстрее при более высокой стоимости за токен.',
  },
};

/** Static composer footer face: model + thinking trigger and a lit Fast control. */
export function FastModePreview({ locale = 'en' }: PreviewProps) {
  const copy = FAST_MODE_COPY[locale];
  return (
    <div className="my-6">
      <div aria-hidden="true" className={cn(PREVIEW_SHELL, 'p-4 sm:p-6')}>
        <div className="mx-auto w-full max-w-2xl">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2 shadow-sm">
            <ReplicaRunConfigTrigger
              agent="codex"
              modelLabel={copy.model}
              thinkLabel={copy.thinking}
            />
            <span aria-hidden="true" className="h-4 w-px bg-border" />
            <span className="inline-flex h-7 shrink-0 select-none items-center gap-1.5 rounded-[4px] bg-status-success/10 px-2 text-[0.9em] leading-tight text-status-success">
              <Zap className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
              <span>{copy.fast}</span>
              <span className="rounded bg-status-success/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                {copy.on}
              </span>
            </span>
          </div>
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-status-success/20 bg-status-success/[0.06] px-3 py-2">
            <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-success" aria-hidden="true" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">{copy.tradeoff}</span> {copy.caption}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── AskUserQuestion card ───────────────────────────────────────────────────
// Source: packages/components/src/components/sessions/ask-user-question-card.tsx
// Story: packages/components/src/stories/AskUserQuestionCard.stories.tsx

type AskOptionCopy = {
  label: string;
  description: string;
  selected?: boolean;
};

type AskQuestionCopy = {
  badge: string;
  question: string;
  options: AskOptionCopy[];
  customPlaceholder?: string;
};

type AskQuestionPreviewCopy = {
  single: AskQuestionCopy;
  multi: AskQuestionCopy;
  caption: string;
};

const ASK_QUESTION_COPY: Record<SiteLocale, AskQuestionPreviewCopy> = {
  en: {
    single: {
      badge: 'Single select',
      question: 'What did you eat?',
      options: [
        {
          label: 'Breakfast',
          description: 'Morning meal — e.g., eggs, toast, oatmeal, congee',
          selected: true,
        },
        {
          label: 'Lunch',
          description: 'Midday meal — e.g., sandwich, salad, rice bowl',
        },
        {
          label: 'Dinner',
          description: 'Evening meal — e.g., pasta, stir-fry, hotpot',
        },
        {
          label: 'Snack',
          description: 'Light bite between meals — e.g., fruit, nuts, chips',
        },
      ],
      customPlaceholder: 'Type a custom answer...',
    },
    multi: {
      badge: 'Multi-select',
      question: 'Which constraints matter?',
      options: [
        {
          label: 'Offline',
          description: 'Must keep working without a network',
          selected: true,
        },
        {
          label: 'Compatibility',
          description: 'Preserve the existing public API',
        },
        {
          label: 'Speed',
          description: 'Prefer the lowest-latency path',
          selected: true,
        },
      ],
    },
    caption:
      'Mock AskUserQuestion card. The runtime can request single-select, multi-select, or custom answers while a task is running.',
  },
  zh: {
    single: {
      badge: '单选',
      question: '你吃了什么？',
      options: [
        {
          label: '早餐',
          description: '早上吃的——例如鸡蛋、吐司、燕麦、粥',
          selected: true,
        },
        {
          label: '午餐',
          description: '中午吃的——例如三明治、沙拉、盖饭',
        },
        {
          label: '晚餐',
          description: '晚上吃的——例如意面、炒菜、火锅',
        },
        {
          label: '零食',
          description: '两餐之间的小食——例如水果、坚果、薯片',
        },
      ],
      customPlaceholder: '输入自定义回答……',
    },
    multi: {
      badge: '多选',
      question: '哪些约束条件重要？',
      options: [
        {
          label: '离线',
          description: '无网络时也必须可用',
          selected: true,
        },
        {
          label: '兼容性',
          description: '保留现有公开 API',
        },
        {
          label: '速度',
          description: '优先使用延迟最低的路径',
          selected: true,
        },
      ],
    },
    caption: '模拟 AskUserQuestion 卡片。运行时可在任务执行中请求单选、多选或自定义回答。',
  },
  'zh-hant': {
    single: {
      badge: '單選',
      question: '你吃了什麼？',
      options: [
        {
          label: '早餐',
          description: '早上的餐點——例如蛋、吐司、燕麥、粥',
          selected: true,
        },
        {
          label: '午餐',
          description: '中午的餐點——例如三明治、沙拉、丼飯',
        },
        {
          label: '晚餐',
          description: '晚上的餐點——例如義大利麵、熱炒、火鍋',
        },
        {
          label: '點心',
          description: '兩餐之間的小食——例如水果、堅果、洋芋片',
        },
      ],
      customPlaceholder: '輸入自訂回答……',
    },
    multi: {
      badge: '多選',
      question: '哪些限制條件最重要？',
      options: [
        {
          label: '離線',
          description: '沒有網路時也必須能運作',
          selected: true,
        },
        {
          label: '相容性',
          description: '保留既有的公開 API',
        },
        {
          label: '速度',
          description: '優先採用延遲最低的路徑',
          selected: true,
        },
      ],
    },
    caption: '模擬 AskUserQuestion 卡片。執行環境可在任務進行中請求單選、多選或自訂回答。',
  },
  ja: {
    single: {
      badge: '単一選択',
      question: '何を食べましたか？',
      options: [
        {
          label: '朝食',
          description: '朝の食事 — 例：卵、トースト、オートミール、おかゆ',
          selected: true,
        },
        {
          label: '昼食',
          description: '昼の食事 — 例：サンドイッチ、サラダ、丼もの',
        },
        {
          label: '夕食',
          description: '夜の食事 — 例：パスタ、炒め物、鍋',
        },
        {
          label: '間食',
          description: '食事の合間の軽食 — 例：フルーツ、ナッツ、チップス',
        },
      ],
      customPlaceholder: 'カスタム回答を入力...',
    },
    multi: {
      badge: '複数選択',
      question: '重視する制約はどれですか？',
      options: [
        {
          label: 'オフライン',
          description: 'ネットワークなしでも動作し続ける必要がある',
          selected: true,
        },
        {
          label: '互換性',
          description: '既存の公開 API を維持する',
        },
        {
          label: '速度',
          description: '最も低遅延なパスを優先する',
          selected: true,
        },
      ],
    },
    caption:
      'モック AskUserQuestion カードです。タスク実行中、ランタイムは単一選択・複数選択・自由入力の回答を求められることがあります。',
  },
  ko: {
    single: {
      badge: '단일 선택',
      question: '무엇을 드셨나요?',
      options: [
        {
          label: '아침',
          description: '아침 식사 — 예: 달걀, 토스트, 오트밀, 죽',
          selected: true,
        },
        {
          label: '점심',
          description: '점심 식사 — 예: 샌드위치, 샐러드, 덮밥',
        },
        {
          label: '저녁',
          description: '저녁 식사 — 예: 파스타, 볶음 요리, 전골',
        },
        {
          label: '간식',
          description: '식사 사이의 가벼운 먹거리 — 예: 과일, 견과류, 과자',
        },
      ],
      customPlaceholder: '직접 답변 입력...',
    },
    multi: {
      badge: '다중 선택',
      question: '어떤 제약 조건이 중요한가요?',
      options: [
        {
          label: '오프라인',
          description: '네트워크 없이도 계속 동작해야 함',
          selected: true,
        },
        {
          label: '호환성',
          description: '기존 공개 API를 유지해야 함',
        },
        {
          label: '속도',
          description: '가장 지연이 적은 경로를 우선함',
          selected: true,
        },
      ],
    },
    caption:
      '모의 AskUserQuestion 카드입니다. 런타임은 작업 실행 중에 단일 선택, 다중 선택 또는 직접 입력 답변을 요청할 수 있습니다.',
  },
  es: {
    single: {
      badge: 'Selección única',
      question: '¿Qué comiste?',
      options: [
        {
          label: 'Desayuno',
          description: 'Comida de la mañana: p. ej., huevos, tostadas, avena',
          selected: true,
        },
        {
          label: 'Almuerzo',
          description: 'Comida de mediodía: p. ej., sándwich, ensalada, bol de arroz',
        },
        {
          label: 'Cena',
          description: 'Comida de la noche: p. ej., pasta, salteado, olla caliente',
        },
        {
          label: 'Merienda',
          description: 'Bocado ligero entre comidas: p. ej., fruta, frutos secos, patatas',
        },
      ],
      customPlaceholder: 'Escribe una respuesta personalizada...',
    },
    multi: {
      badge: 'Selección múltiple',
      question: '¿Qué restricciones importan?',
      options: [
        {
          label: 'Sin conexión',
          description: 'Debe seguir funcionando sin red',
          selected: true,
        },
        {
          label: 'Compatibilidad',
          description: 'Mantener la API pública existente',
        },
        {
          label: 'Velocidad',
          description: 'Priorizar la ruta de menor latencia',
          selected: true,
        },
      ],
    },
    caption:
      'Tarjeta AskUserQuestion de ejemplo. El entorno de ejecución puede solicitar respuestas de selección única, múltiple o personalizadas durante una tarea.',
  },
  fr: {
    single: {
      badge: 'Choix unique',
      question: 'Qu’avez-vous mangé ?',
      options: [
        {
          label: 'Petit-déjeuner',
          description: 'Repas du matin — ex. œufs, tartines, flocons d’avoine',
          selected: true,
        },
        {
          label: 'Déjeuner',
          description: 'Repas de midi — ex. sandwich, salade, bol de riz',
        },
        {
          label: 'Dîner',
          description: 'Repas du soir — ex. pâtes, wok, fondue',
        },
        {
          label: 'En-cas',
          description: 'Collation entre les repas — ex. fruits, noix, chips',
        },
      ],
      customPlaceholder: 'Saisir une réponse personnalisée...',
    },
    multi: {
      badge: 'Choix multiple',
      question: 'Quelles contraintes comptent ?',
      options: [
        {
          label: 'Hors ligne',
          description: 'Doit continuer à fonctionner sans réseau',
          selected: true,
        },
        {
          label: 'Compatibilité',
          description: 'Préserver l’API publique existante',
        },
        {
          label: 'Vitesse',
          description: 'Privilégier le chemin à plus faible latence',
          selected: true,
        },
      ],
    },
    caption:
      'Carte AskUserQuestion factice. L’environnement d’exécution peut demander une réponse à choix unique, à choix multiple ou personnalisée pendant une tâche.',
  },
  ru: {
    single: {
      badge: 'Один вариант',
      question: 'Что вы ели?',
      options: [
        {
          label: 'Завтрак',
          description: 'Утренний приём пищи — например, яйца, тосты, овсянка',
          selected: true,
        },
        {
          label: 'Обед',
          description: 'Дневной приём пищи — например, сэндвич, салат, рис с гарниром',
        },
        {
          label: 'Ужин',
          description: 'Вечерний приём пищи — например, паста, жаркое, хот-пот',
        },
        {
          label: 'Перекус',
          description: 'Лёгкий перекус между приёмами пищи — например, фрукты, орехи, чипсы',
        },
      ],
      customPlaceholder: 'Введите свой ответ...',
    },
    multi: {
      badge: 'Несколько вариантов',
      question: 'Какие ограничения важны?',
      options: [
        {
          label: 'Офлайн',
          description: 'Должно продолжать работать без сети',
          selected: true,
        },
        {
          label: 'Совместимость',
          description: 'Сохранить существующий публичный API',
        },
        {
          label: 'Скорость',
          description: 'Отдавать предпочтение пути с минимальной задержкой',
          selected: true,
        },
      ],
    },
    caption:
      'Демонстрационная карточка AskUserQuestion. Во время выполнения задачи среда выполнения может запрашивать одиночный, множественный или произвольный ответ.',
  },
};

function AskQuestionCard({
  question,
  multiSelect,
}: {
  question: AskQuestionCopy;
  multiSelect: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-border bg-card p-4 shadow-sm">
      <span className="w-fit rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {question.badge}
      </span>
      <h3 className="mt-2 text-base font-semibold leading-snug">{question.question}</h3>
      <div className="mt-3 flex flex-col gap-1.5">
        {question.options.map((option) => (
          <div
            key={option.label}
            className={cn(
              'flex items-start gap-3 rounded-lg border px-3 py-2',
              option.selected ? 'border-primary/35 bg-primary/[0.04]' : 'border-border/70'
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                multiSelect ? 'rounded-[3px]' : 'rounded-full',
                option.selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input-border bg-background'
              )}
            >
              {option.selected ? (
                multiSelect ? (
                  <Check className="h-3 w-3" strokeWidth={3} />
                ) : (
                  <span className="size-1.5 rounded-full bg-primary-foreground" />
                )
              ) : null}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                {option.description}
              </span>
            </span>
          </div>
        ))}
      </div>
      {question.customPlaceholder ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-input-border bg-background px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-xs text-input-placeholder">
            {question.customPlaceholder}
          </span>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** Static AskUserQuestion examples for single-select, multi-select and custom answers. */
export function AskQuestionPreview({ locale = 'en' }: PreviewProps) {
  const copy = ASK_QUESTION_COPY[locale];
  return (
    <div className="my-6">
      <div
        aria-hidden="true"
        className={cn(PREVIEW_SHELL, 'pointer-events-none bg-muted/20 p-4 sm:p-6')}
      >
        <div className="mx-auto grid w-full max-w-3xl gap-4 md:grid-cols-2">
          <AskQuestionCard question={copy.single} multiSelect={false} />
          <AskQuestionCard question={copy.multi} multiSelect />
        </div>
      </div>
      <p className={CAPTION_CLASS}>{copy.caption}</p>
    </div>
  );
}

// ─── Goal status banner ─────────────────────────────────────────────────────
// Source: packages/components/src/components/sessions/session-goal-banner.tsx,
// packages/components/src/components/sessions/session-goal-control.ts
// Story: packages/components/src/stories/SessionGoalBanner.stories.tsx

type GoalCopy = {
  label: string;
  status: string;
  objective: string;
  pause: string;
  resume: string;
  clear: string;
  elapsed: string;
  tokens: string;
  progress: string;
  elapsedValue: string;
  tokensValue: string;
  progressValue: string;
  caption: string;
};

const GOAL_COPY: Record<SiteLocale, GoalCopy> = {
  en: {
    label: 'Goal',
    status: 'Pursuing goal',
    objective: 'explain how remote preview works?',
    pause: 'Pause',
    resume: 'Resume',
    clear: 'Clear',
    elapsed: 'Elapsed',
    tokens: 'tokens',
    progress: 'Progress',
    elapsedValue: '16s',
    tokensValue: '12.4K / 50K',
    progressValue: '25%',
    caption:
      'Mock goal banner. Active goals show Pause; paused goals show Resume. Elapsed and token data are synthetic.',
  },
  zh: {
    label: '目标',
    status: '执行目标中',
    objective: '解释远程预览如何工作？',
    pause: '暂停',
    resume: '继续',
    clear: '清除',
    elapsed: '已用',
    tokens: 'tokens',
    progress: '进度',
    elapsedValue: '16s',
    tokensValue: '12.4K / 50K',
    progressValue: '25%',
    caption: '模拟目标横幅。目标进行中显示暂停，暂停后显示继续。时间与 token 数据为模拟值。',
  },
  'zh-hant': {
    label: '目標',
    status: '執行目標中',
    objective: '說明遠端預覽的運作方式？',
    pause: '暫停',
    resume: '繼續',
    clear: '清除',
    elapsed: '已耗時',
    tokens: 'tokens',
    progress: '進度',
    elapsedValue: '16s',
    tokensValue: '12.4K / 50K',
    progressValue: '25%',
    caption:
      '模擬目標橫幅。進行中的目標會顯示暫停，暫停時則顯示繼續。時間與 token 資料皆為模擬值。',
  },
  ja: {
    label: 'ゴール',
    status: '目標を実行中',
    objective: 'リモートプレビューの仕組みを説明して',
    pause: '一時停止',
    resume: '再開',
    clear: 'クリア',
    elapsed: '経過時間',
    tokens: 'トークン',
    progress: '進捗',
    elapsedValue: '16s',
    tokensValue: '12.4K / 50K',
    progressValue: '25%',
    caption:
      'モックのゴールバナーです。実行中のゴールでは「一時停止」、一時停止中では「再開」が表示されます。経過時間とトークン数はモック値です。',
  },
  ko: {
    label: '목표',
    status: '목표 수행 중',
    objective: '원격 미리보기가 어떻게 동작하는지 설명해 줘',
    pause: '일시정지',
    resume: '재개',
    clear: '지우기',
    elapsed: '경과',
    tokens: '토큰',
    progress: '진행률',
    elapsedValue: '16s',
    tokensValue: '12.4K / 50K',
    progressValue: '25%',
    caption:
      '모의 목표 배너입니다. 진행 중인 목표는 일시정지를, 일시정지된 목표는 재개를 표시합니다. 경과 시간과 토큰 데이터는 모의 값입니다.',
  },
  es: {
    label: 'Objetivo',
    status: 'Persiguiendo objetivo',
    objective: '¿explicar cómo funciona la vista previa remota?',
    pause: 'Pausar',
    resume: 'Reanudar',
    clear: 'Borrar',
    elapsed: 'Transcurrido',
    tokens: 'tokens',
    progress: 'Progreso',
    elapsedValue: '16s',
    tokensValue: '12.4K / 50K',
    progressValue: '25%',
    caption:
      'Banner de objetivo de ejemplo. Los objetivos activos muestran Pausar; los pausados muestran Reanudar. El tiempo y los tokens son sintéticos.',
  },
  fr: {
    label: 'Objectif',
    status: 'Objectif en cours',
    objective: 'expliquer comment fonctionne l’aperçu à distance ?',
    pause: 'Mettre en pause',
    resume: 'Reprendre',
    clear: 'Effacer',
    elapsed: 'Écoulé',
    tokens: 'jetons',
    progress: 'Progression',
    elapsedValue: '16s',
    tokensValue: '12.4K / 50K',
    progressValue: '25%',
    caption:
      'Bannière d’objectif factice. Les objectifs actifs affichent Mettre en pause ; ceux en pause affichent Reprendre. Le temps écoulé et les jetons sont factices.',
  },
  ru: {
    label: 'Цель',
    status: 'Выполнение цели',
    objective: 'объяснить, как работает удалённый предпросмотр?',
    pause: 'Пауза',
    resume: 'Продолжить',
    clear: 'Очистить',
    elapsed: 'Прошло',
    tokens: 'Токены',
    progress: 'Прогресс',
    elapsedValue: '16s',
    tokensValue: '12.4K / 50K',
    progressValue: '25%',
    caption:
      'Демонстрационный баннер цели. Для активных целей отображается «Пауза», для приостановленных — «Продолжить». Данные о времени и токенах являются примером.',
  },
};

function GoalAction({
  icon: Icon,
  label,
  tone = 'neutral',
  muted = false,
}: {
  icon: LucideIcon;
  label: string;
  tone?: 'neutral' | 'success' | 'danger';
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium',
        tone === 'neutral' && 'border-border bg-card text-foreground',
        tone === 'success' && 'border-status-success/35 bg-status-success/10 text-status-success',
        tone === 'danger' && 'border-destructive/30 bg-background text-destructive',
        muted && 'opacity-45'
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

/** Static Codex-style goal banner with objective, usage and state controls. */
export function GoalPreview({ locale = 'en' }: PreviewProps) {
  const copy = GOAL_COPY[locale];
  return (
    <div className="my-6">
      <div aria-hidden="true" className={cn(PREVIEW_SHELL, 'bg-status-info/10')}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-status-info/30 px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Target className="h-4 w-4 shrink-0 text-status-info" aria-hidden="true" />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-status-info">
              {copy.label}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-status-info/30 bg-background/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-status-info">
              <LoaderCircle className="h-3 w-3" aria-hidden="true" />
              {copy.status}
            </span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <GoalAction icon={Pause} label={copy.pause} />
            <GoalAction icon={Play} label={copy.resume} tone="success" muted />
            <GoalAction icon={X} label={copy.clear} tone="danger" />
          </div>
        </div>
        <div className="px-3 pb-3 pt-2">
          <p className="text-sm font-medium leading-snug">{copy.objective}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {copy.elapsed} {copy.elapsedValue}
            </span>
            <span className="inline-flex items-center gap-1">
              <Coins className="h-3 w-3" aria-hidden="true" />
              {copy.tokens} {copy.tokensValue}
            </span>
            <span className="inline-flex items-center gap-1">
              <Gauge className="h-3 w-3" aria-hidden="true" />
              {copy.progress} {copy.progressValue}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background/80">
            <div className="h-full w-1/4 rounded-full bg-status-info" />
          </div>
        </div>
      </div>
      <p className={CAPTION_CLASS}>{copy.caption}</p>
    </div>
  );
}

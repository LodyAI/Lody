import { schedulesFeatureEnabledAtom } from '@/atoms/settings';
import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { useAtomValue } from 'jotai';
import type {
  AcpConfigOptionValue,
  BuiltinRuntimeOverrides,
  CustomAcpLaunchSpec,
  CommentReferencePayload,
  SessionId,
  SessionMeta,
  SessionInputBlock,
  SessionTurnInputConfig,
} from '@lody/shared';
import {
  buildSessionTurnInputConfig,
  extractPromptPreviewFromInputBlocks,
  getMachineFlockLocalProjects,
  resolveSessionConversationConfig,
} from '@lody/shared';

import { getAllAgentConfigAtom } from '@/atoms';
import { docMetaCacheReadyAtom } from '@/atoms/doc-meta';
import { tasksFeatureEnabledAtom } from '@/atoms/settings';
import {
  extractIssuePRMentionsFromText,
  useKnownIssuePrItems,
} from '@/components/mentions/issue-pr-hash-mention';
import { useSessionMcpSelection } from '@/hooks/use-session-mcp-selection';
import { canShowSubscriptionRateLimits } from '@/lib/session-usage';
import { canShowCodexResetForecast } from '@/lib/codex-reset-forecast';
import { useResolvedTheme } from '../../theme-provider';
import { SessionChatInputArea, type SessionChatInputAreaHandle } from './session-chat-input-area';
import { useSessionAcpSelectorContext } from '@/hooks/use-session-acp-selector-context';
import {
  resolveSessionLocalProjectRootPath,
  resolveSessionRepoFullName,
} from '@/lib/session-local-file-source';
import type { AgentSelection } from '@/components/shared/agent-selector';
import type { DraftSessionTab } from '@/lib/session-draft-tabs';
import { agentDefaultsCache } from '@/lib/local-storage-cache';
import {
  isThoughtLevelSelector,
  type AcpConfigOptionSelector,
  type AcpSelectConfigOptionSelector,
} from '@/components/shared/acp-selector-options';
import {
  useAcpSessionConfigSelectionState,
  useReconcileAcpSessionConfigSelection,
} from '@/hooks/use-acp-session-config-selection';
import { filterAcpSessionConfigOptionValues } from '@/lib/acp-session-config-selection';
import { useComposerCycleCommands } from '@/hooks/use-composer-cycle-commands';
import { ChildTabEmptyState } from './child-tab-empty-state';
import { useSessionDoc } from '@/hooks/use-session-doc';

const areConfigOptionValuesEqual = (
  left?: Record<string, AcpConfigOptionValue>,
  right?: Record<string, AcpConfigOptionValue>
): boolean => {
  const leftEntries = Object.entries(left ?? {});
  const rightEntries = Object.entries(right ?? {});
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  return leftEntries.every(([key, value]) => right?.[key] === value);
};

export type DraftSessionSendPayload = {
  draftId: DraftSessionTab['id'];
  sessionId: SessionId;
  inputBlocks: SessionInputBlock[];
  preservedInputText?: string;
  agentConfigId?: DraftSessionTab['agentConfigId'];
  cliType: DraftSessionTab['cliType'];
  agentType: DraftSessionTab['agentType'];
  /** Launch spec resolved from the selected agent config for `cliType: 'custom'`. */
  customAcp?: CustomAcpLaunchSpec;
  /** Runtime binary override resolved from the selected builtin agent config. */
  runtimeOverrides?: BuiltinRuntimeOverrides;
  /** Analytics-only; the dispatched values live in `inputConfig`. */
  configOptionSelectors?: AcpConfigOptionSelector[];
  /**
   * Complete first-turn input config, built by the composer that owns the
   * selections. The parent accepts the session with this turn as one unit
   * (`startSession`), so prompt/mode/model/config values must be read from
   * here, never carried or reconstructed separately.
   */
  inputConfig: SessionTurnInputConfig;
};

export interface DraftSessionChatInterfaceProps {
  draft: DraftSessionTab;
  parentSession: SessionMeta;
  commandsEnabled?: boolean;
  onDraftChange: (draftId: DraftSessionTab['id'], patch: Partial<DraftSessionTab>) => void;
  onSendDraft: (payload: DraftSessionSendPayload) => Promise<boolean>;
  onCommentReferencesChange?: (references: CommentReferencePayload[]) => void;
}

export type DraftSessionChatInterfaceHandle = {
  focusInput: () => void;
  addCommentReference: (reference: CommentReferencePayload) => boolean;
  insertSessionMention: (sessionId: string) => boolean;
};

export const DraftSessionChatInterface = memo(
  forwardRef<DraftSessionChatInterfaceHandle, DraftSessionChatInterfaceProps>(
    function DraftSessionChatInterface(
      {
        draft,
        parentSession,
        commandsEnabled = true,
        onDraftChange,
        onSendDraft,
        onCommentReferencesChange,
      },
      ref
    ) {
      const resolvedTheme = useResolvedTheme();
      const isDark = resolvedTheme === 'dark';
      const inputAreaRef = useRef<SessionChatInputAreaHandle>(null);
      const {
        state: sessionConfigSelectionState,
        selectedModeId,
        selectedModelId,
        configOptionValues,
        selectMode,
        selectModel,
        selectConfigOption,
        dispatch: dispatchSessionConfigSelection,
      } = useAcpSessionConfigSelectionState();
      const sessionConfigTargetKey = `${draft.id}:${draft.agentConfigId ?? ''}:${draft.cliType}:${draft.agentType}`;
      const {
        availableCommands,
        capabilityAuthority,
        configOptionSelectors,
        defaultModeId,
        defaultModelId,
        machineFlockRows,
        modeOptions,
        modelOptions,
        sessionMachine,
      } = useSessionAcpSelectorContext({
        machineId: parentSession.machineId,
        configId: draft.agentConfigId,
        cliType: draft.cliType,
        agentType: draft.agentType,
        selectedModeId,
        selectedModelId,
        configOptionValues,
      });
      const dispatchConfigOptionValues = useMemo(
        () => filterAcpSessionConfigOptionValues(configOptionValues, configOptionSelectors),
        [configOptionSelectors, configOptionValues]
      );
      const agentConfigs = useAtomValue(getAllAgentConfigAtom);
      const docMetaCacheReady = useAtomValue(docMetaCacheReadyAtom);
      const tasksFeatureEnabled = useAtomValue(tasksFeatureEnabledAtom);
      const schedulesEnabled = useAtomValue(schedulesFeatureEnabledAtom);
      // The draft composer has no MCP picker yet, so the first turn carries the
      // workspace default selection — the same set the promoted child composer
      // resolves for an empty session doc.
      const mcpSelection = useSessionMcpSelection(undefined, {});
      // Same resolution the composer uses: a local project may carry its repo
      // only in project.githubRepoFullName, not in repoFullName.
      const parentRepoFullName = resolveSessionRepoFullName(parentSession);
      const { knownItems: knownIssuePrItems } = useKnownIssuePrItems(
        parentRepoFullName || undefined
      );
      const { doc: parentSessionDoc, ready: parentSessionDocReady } = useSessionDoc(
        parentSession.id
      );
      const parentConversationConfig = useMemo(
        () => resolveSessionConversationConfig(parentSessionDoc.history, parentSessionDoc.mq),
        [parentSessionDoc.history, parentSessionDoc.mq]
      );
      const preferAgentDefaults =
        draft.agentConfigId !== undefined && draft.agentConfigId !== parentSession.agentConfigId;
      const draftAgentDefaults = useMemo(
        () =>
          preferAgentDefaults && draft.agentConfigId
            ? agentDefaultsCache.get(draft.agentConfigId)
            : null,
        [draft.agentConfigId, preferAgentDefaults]
      );
      const preferredSessionConfig = useMemo(() => {
        const inheritedConfigOptionValues = preferAgentDefaults
          ? draftAgentDefaults?.configOptionValues
          : parentConversationConfig.configOptionValues;
        return {
          modeId:
            draft.modeId ??
            (preferAgentDefaults ? draftAgentDefaults?.modeId : parentConversationConfig.modeId),
          modelId:
            draft.modelId ??
            (preferAgentDefaults ? draftAgentDefaults?.modelId : parentConversationConfig.modelId),
          configOptionValues: {
            ...(inheritedConfigOptionValues ?? {}),
            ...(draft.configOptionValues ?? {}),
          },
        };
      }, [
        draft.configOptionValues,
        draft.modeId,
        draft.modelId,
        draftAgentDefaults?.configOptionValues,
        draftAgentDefaults?.modeId,
        draftAgentDefaults?.modelId,
        parentConversationConfig.configOptionValues,
        parentConversationConfig.modeId,
        parentConversationConfig.modelId,
        preferAgentDefaults,
      ]);
      const selectorOptions = useMemo(
        () => ({
          capabilityAuthority,
          configOptionSelectors,
          defaultModeId,
          defaultModelId,
          modeOptions,
          modelOptions,
        }),
        [
          capabilityAuthority,
          configOptionSelectors,
          defaultModeId,
          defaultModelId,
          modeOptions,
          modelOptions,
        ]
      );
      const sessionConfigPreferenceRevision = `${sessionConfigTargetKey}:${parentConversationConfig.sourceConfigKey ?? ''}`;
      useReconcileAcpSessionConfigSelection({
        enabled: parentSessionDocReady,
        targetKey: sessionConfigTargetKey,
        preferenceRevision: sessionConfigPreferenceRevision,
        preferences: preferredSessionConfig,
        selectorOptions,
        dispatch: dispatchSessionConfigSelection,
      });
      const thinkEffortSelector = useMemo(
        () =>
          configOptionSelectors.find(
            (selector): selector is AcpSelectConfigOptionSelector =>
              selector.type === 'select' && isThoughtLevelSelector(selector)
          ),
        [configOptionSelectors]
      );
      const thinkEffortCurrent = thinkEffortSelector
        ? configOptionValues[thinkEffortSelector.configId]
        : undefined;
      useComposerCycleCommands({
        enabled: commandsEnabled,
        mode: {
          values: modeOptions.map((option) => option.value),
          current: selectedModeId,
          onSelect: selectMode,
        },
        model: {
          values: modelOptions.map((option) => option.value),
          current: selectedModelId,
          onSelect: selectModel,
        },
        thinkEffort: thinkEffortSelector
          ? {
              values: thinkEffortSelector.options.map((option) => option.value),
              current:
                typeof thinkEffortCurrent === 'string'
                  ? thinkEffortCurrent
                  : thinkEffortSelector.currentValue,
              onSelect: (value) => selectConfigOption(thinkEffortSelector.configId, value),
            }
          : null,
        provider: null,
      });

      const transientSession = useMemo(
        () =>
          ({
            ...parentSession,
            id: draft.sessionId,
            parentSessionId: parentSession.id,
            agentConfigId: draft.agentConfigId,
            cliType: draft.cliType,
            agentType: draft.agentType,
            contextWindowUsage: undefined,
            status: { type: 'idle' },
          }) satisfies SessionMeta,
        [draft.agentConfigId, draft.agentType, draft.cliType, draft.sessionId, parentSession]
      );

      const sessionAgentConfig = useMemo(
        () => agentConfigs.find((config) => config.id === draft.agentConfigId),
        [agentConfigs, draft.agentConfigId]
      );
      const sessionMachineLocalProjects = useMemo(
        () => ({
          ...(sessionMachine?.localProjects ?? {}),
          ...getMachineFlockLocalProjects(machineFlockRows),
        }),
        [machineFlockRows, sessionMachine?.localProjects]
      );
      const sessionLocalProjectRootPath = useMemo(
        () => resolveSessionLocalProjectRootPath(transientSession, sessionMachineLocalProjects),
        [sessionMachineLocalProjects, transientSession]
      );
      useLayoutEffect(() => {
        if (
          !parentSessionDocReady ||
          sessionConfigSelectionState.targetKey !== sessionConfigTargetKey ||
          sessionConfigSelectionState.preferenceRevision !== sessionConfigPreferenceRevision
        ) {
          return;
        }
        const nextConfigOptionValues =
          Object.keys(configOptionValues).length > 0 ? configOptionValues : undefined;
        if (
          selectedModeId !== draft.modeId ||
          selectedModelId !== draft.modelId ||
          !areConfigOptionValuesEqual(draft.configOptionValues, nextConfigOptionValues)
        ) {
          onDraftChange(draft.id, {
            modeId: selectedModeId,
            modelId: selectedModelId,
            configOptionValues: nextConfigOptionValues,
          });
        }
      }, [
        configOptionValues,
        draft.configOptionValues,
        draft.id,
        draft.modeId,
        draft.modelId,
        onDraftChange,
        parentSessionDocReady,
        selectedModeId,
        selectedModelId,
        sessionConfigSelectionState.targetKey,
        sessionConfigSelectionState.preferenceRevision,
        sessionConfigPreferenceRevision,
        sessionConfigTargetKey,
      ]);

      const buildSendPayload = useCallback(
        (
          inputBlocks: SessionInputBlock[],
          preservedInputText?: string
        ): DraftSessionSendPayload => {
          const prompt = extractPromptPreviewFromInputBlocks(inputBlocks);
          return {
            draftId: draft.id,
            sessionId: draft.sessionId,
            inputBlocks,
            preservedInputText,
            agentConfigId: draft.agentConfigId,
            cliType: draft.cliType,
            agentType: draft.agentType,
            customAcp: sessionAgentConfig?.customAcp,
            runtimeOverrides: sessionAgentConfig?.runtimeOverrides,
            configOptionSelectors,
            // Unlike chat-landing's first turn, the prompt deliberately has no
            // agent-config prompt prefix: a child tab continues the parent's
            // running context, matching what the promoted composer would send.
            inputConfig: buildSessionTurnInputConfig({
              inputBlocks,
              prompt,
              cliType: draft.cliType,
              agentType: draft.agentType,
              modeId: selectedModeId,
              modelId: selectedModelId,
              configOptionValues: dispatchConfigOptionValues,
              issuePRMentions: prompt
                ? extractIssuePRMentionsFromText(
                    prompt,
                    knownIssuePrItems,
                    parentRepoFullName || undefined
                  )
                : undefined,
              mcpServerIds: mcpSelection.selectedIds,
              taskToolsEnabled: tasksFeatureEnabled,
              scheduleToolsEnabled: schedulesEnabled,
            }),
          };
        },
        [
          configOptionSelectors,
          draft.agentConfigId,
          draft.agentType,
          draft.cliType,
          sessionAgentConfig?.customAcp,
          sessionAgentConfig?.runtimeOverrides,
          draft.id,
          draft.sessionId,
          dispatchConfigOptionValues,
          knownIssuePrItems,
          mcpSelection.selectedIds,
          parentRepoFullName,
          selectedModeId,
          selectedModelId,
          tasksFeatureEnabled,
          schedulesEnabled,
        ]
      );

      const handleSendMessage = useCallback(
        async (inputBlocks: SessionInputBlock[]) => {
          return await onSendDraft(buildSendPayload(inputBlocks));
        },
        [buildSendPayload, onSendDraft]
      );

      const handleAgentConfigChange = useCallback(
        (selection: AgentSelection) => {
          const nextConfig = agentConfigs.find((config) => config.id === selection.agentId);
          if (!nextConfig) {
            return;
          }
          const useParentConfig = nextConfig.id === parentSession.agentConfigId;
          const agentDefaults = useParentConfig ? null : agentDefaultsCache.get(nextConfig.id);
          onDraftChange(draft.id, {
            agentConfigId: nextConfig.id,
            cliType: nextConfig.cliType,
            agentType: nextConfig.agentType,
            modeId: agentDefaults?.modeId ?? null,
            modelId: agentDefaults?.modelId ?? null,
            configOptionValues: agentDefaults?.configOptionValues,
          });
        },
        [agentConfigs, draft.id, onDraftChange, parentSession.agentConfigId]
      );

      useImperativeHandle(
        ref,
        () => ({
          focusInput: () => {
            inputAreaRef.current?.focusInput();
          },
          addCommentReference: (reference: CommentReferencePayload) => {
            return inputAreaRef.current?.addCommentReference(reference) ?? false;
          },
          insertSessionMention: (sessionId: string) => {
            return inputAreaRef.current?.insertSessionMention(sessionId) ?? false;
          },
        }),
        []
      );

      return (
        <div className="flex h-full flex-col">
          <div className="relative min-h-0 flex-1 bg-background">
            <ChildTabEmptyState onSuggest={(text) => inputAreaRef.current?.setInputText(text)} />
          </div>
          <SessionChatInputArea
            ref={inputAreaRef}
            session={transientSession}
            sessionLocalProjectRootPath={sessionLocalProjectRootPath}
            isMachineRemoved={!sessionMachine && docMetaCacheReady}
            isAgentBusy={false}
            isDark={isDark}
            isEmptyConversation={true}
            commandsEnabled={commandsEnabled}
            selectedModeId={selectedModeId}
            selectedModelId={selectedModelId}
            modeOptions={modeOptions}
            modelOptions={modelOptions}
            rateLimits={
              (!draft.agentConfigId || sessionAgentConfig) &&
              canShowSubscriptionRateLimits({
                cliType: draft.cliType,
                agentType: draft.agentType,
                config: sessionAgentConfig,
              })
                ? sessionMachine?.raceLimits
                : undefined
            }
            /* Judged here, with the resolved config: a side chat can run a
               Codex-compatible provider whose identity `cliType`/`agentType`
               alone would not reveal. */
            showCodexResetForecast={
              (!draft.agentConfigId || !!sessionAgentConfig) &&
              canShowCodexResetForecast({
                cliType: draft.cliType,
                agentType: draft.agentType,
                config: sessionAgentConfig,
              })
            }
            configOptionSelectors={configOptionSelectors}
            configOptionValues={configOptionValues}
            availableCommands={availableCommands}
            onModeChange={selectMode}
            onModelChange={selectModel}
            onConfigOptionChange={selectConfigOption}
            onSendMessage={handleSendMessage}
            onStop={() => {}}
            onRemoveQueueItem={async () => {}}
            onAgentConfigChange={handleAgentConfigChange}
            initialInputText={draft.prompt}
            onInputValueChange={(prompt) => onDraftChange(draft.id, { prompt })}
            onCommentReferencesChange={onCommentReferencesChange}
          />
        </div>
      );
    }
  )
);

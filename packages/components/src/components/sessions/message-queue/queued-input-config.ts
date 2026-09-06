import type { ACPSessionConfig, MessageQueueItemInput } from '@lody/shared';

/** Keep the negotiated turn payload intact when persisting it for later dispatch. */
export function buildQueuedInputConfig(
  inputConfig: ACPSessionConfig
): MessageQueueItemInput['acpSessionConfig'] {
  return {
    prompt: inputConfig.prompt,
    inputBlocks: inputConfig.inputBlocks,
    cliType: inputConfig.cliType,
    agentType: inputConfig.agentType,
    modeId: inputConfig.modeId ?? undefined,
    modelId: inputConfig.modelId ?? undefined,
    configOptionValues: inputConfig.configOptionValues ?? undefined,
    issuePRMentions: inputConfig.issuePRMentions ?? undefined,
    mcpServerIds: [...(inputConfig.mcpServerIds ?? [])],
    taskToolsEnabled: inputConfig.taskToolsEnabled,
    agentRoleId: inputConfig.agentRoleId,
    agentRoleRevision: inputConfig.agentRoleRevision,
    resume: inputConfig.resume ?? undefined,
    chainDepth: 0,
  };
}

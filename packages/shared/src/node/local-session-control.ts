import type { LocalSessionControlRequest, LocalSessionControlResponse } from '../message';

const SESSION_IMAGE_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const SESSION_IMAGE_MAX_COUNT = 8;
const SESSION_IMAGE_ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const SESSION_FILE_MAX_SIZE_BYTES = 100 * 1024 * 1024;
const SESSION_FILE_MAX_COUNT = 8;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isObjectRecord(value)) {
    return false;
  }
  return Object.values(value).every((item) => typeof item === 'string');
}

function isWorktreeSetupConfig(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    isObjectRecord(value.scripts) &&
    (typeof value.scripts.bash === 'undefined' || typeof value.scripts.bash === 'string') &&
    (typeof value.scripts.powershell === 'undefined' ||
      typeof value.scripts.powershell === 'string') &&
    (typeof value.timeoutMs === 'undefined' ||
      (typeof value.timeoutMs === 'number' &&
        Number.isInteger(value.timeoutMs) &&
        value.timeoutMs > 0))
  );
}

function isConfigOptionValueRecord(value: unknown): value is Record<string, string | boolean> {
  if (!isObjectRecord(value)) {
    return false;
  }
  return Object.values(value).every(
    (item) => typeof item === 'string' || typeof item === 'boolean'
  );
}

function isOptionalString(value: unknown): boolean {
  return typeof value === 'undefined' || typeof value === 'string';
}

function isAcpAuthMethodSummary(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return (
    (value.type === 'agent' || value.type === 'env_var' || value.type === 'terminal') &&
    isOptionalString(value.id) &&
    isOptionalString(value.name) &&
    isOptionalString(value.description) &&
    (typeof value.args === 'undefined' ||
      (Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string')))
  );
}

function isAcpAuthenticationFormField(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    (value.type === 'text' || value.type === 'secret' || value.type === 'select') &&
    typeof value.label === 'string' &&
    value.label.trim().length > 0 &&
    isOptionalString(value.description) &&
    typeof value.required === 'boolean' &&
    isOptionalString(value.defaultValue) &&
    (value.type !== 'secret' || typeof value.defaultValue === 'undefined') &&
    (value.type !== 'select' ||
      (Array.isArray(value.options) &&
        value.options.length > 0 &&
        value.options.every(
          (option) =>
            isObjectRecord(option) &&
            typeof option.value === 'string' &&
            typeof option.label === 'string'
        )))
  );
}

function isAcpAuthenticationForm(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return (
    isOptionalString(value.title) &&
    isOptionalString(value.description) &&
    Array.isArray(value.fields) &&
    value.fields.length > 0 &&
    value.fields.every(isAcpAuthenticationFormField)
  );
}

function isPreviewTarget(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    (value.protocol === 'http' || value.protocol === 'https') &&
    typeof value.host === 'string' &&
    value.host.length > 0 &&
    value.host.length <= 253 &&
    typeof value.port === 'number' &&
    Number.isInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65535 &&
    (typeof value.path === 'undefined' ||
      (typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 16_384))
  );
}

function isPreviewSource(value: unknown): boolean {
  if (typeof value === 'undefined') {
    return true;
  }
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    isOptionalString(value.toolName) &&
    isOptionalString(value.devServerType) &&
    isOptionalString(value.command) &&
    isOptionalString(value.cwd) &&
    (typeof value.pid === 'undefined' ||
      (typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0))
  );
}

function isPreviewApproval(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return (
    (value.source === 'browser_address' || value.source === 'share_action') &&
    value.targetClass === 'loopback' &&
    isPreviewTarget(value.target) &&
    typeof value.confirmedByUserId === 'string' &&
    typeof value.confirmedAt === 'number' &&
    Number.isInteger(value.confirmedAt) &&
    value.confirmedAt >= 0
  );
}

function isPreviewCandidate(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    typeof value.status === 'string' &&
    isOptionalString(value.candidateId) &&
    (typeof value.target === 'undefined' || isPreviewTarget(value.target)) &&
    isPreviewSource(value.source)
  );
}

function isPreviewConnection(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    typeof value.status === 'string' &&
    isOptionalString(value.grantId) &&
    isOptionalString(value.publicUrl) &&
    isOptionalString(value.tunnelId) &&
    (typeof value.target === 'undefined' || isPreviewTarget(value.target)) &&
    isOptionalString(value.approvedByUserId)
  );
}

function isAgentConfigCliType(value: unknown): value is 'builtin' | 'registry' | 'custom' {
  return value === 'builtin' || value === 'registry' || value === 'custom';
}

function isLegacyBuiltinCliType(value: unknown): value is 'claude' | 'codex' {
  return value === 'claude' || value === 'codex';
}

function normalizeAcpTarget(
  cliTypeValue: unknown,
  agentTypeValue: unknown
): { cliType: 'builtin' | 'registry' | 'custom'; agentType: string } | null {
  const cliType = typeof cliTypeValue === 'string' ? cliTypeValue.trim() : '';
  const agentType = typeof agentTypeValue === 'string' ? agentTypeValue.trim() : '';

  if (isAgentConfigCliType(cliType) && agentType.length > 0) {
    return { cliType, agentType };
  }

  // Legacy payload before #1221: only `agentType=claude|codex` existed.
  if (!cliType && isLegacyBuiltinCliType(agentType)) {
    return { cliType: 'builtin', agentType };
  }

  // Transitional payload from old session meta: `cliType=claude|codex` and missing `agentType`.
  if (isLegacyBuiltinCliType(cliType) && !agentType) {
    return { cliType: 'builtin', agentType: cliType };
  }

  if (isLegacyBuiltinCliType(cliType) && isLegacyBuiltinCliType(agentType)) {
    return { cliType: 'builtin', agentType };
  }

  return null;
}

function isProjectRef(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }

  if (value.kind === 'github') {
    return typeof value.repoFullName === 'string' && typeof value.branch === 'string';
  }

  if (value.kind === 'local') {
    return (
      typeof value.localProjectId === 'string' &&
      isOptionalString(value.branch) &&
      isOptionalString(value.githubRepoFullName) &&
      (value.useWorktree === undefined || typeof value.useWorktree === 'boolean')
    );
  }

  return false;
}

function isIssuePRMention(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }

  return (
    (value.type === 'issue' || value.type === 'pr') &&
    typeof value.title === 'string' &&
    typeof value.url === 'string' &&
    typeof value.number === 'number'
  );
}

// Intentionally accepts only text|image — NOT `file` blocks. `inputBlocks`
// only travels on the DEPRECATED local-control session/create + session/chat
// requests (rejected at runtime as legacy_control_removed; real messages go
// through meta-activated Loro dispatch, see context/message-flow.md), and the
// repo rule is to not add functionality to that path. File attachments use
// session/file-upload + session/file-send-local instead.
function isSessionInputBlock(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }

  if (value.type === 'text') {
    return typeof value.text === 'string';
  }

  if (value.type !== 'image') {
    return false;
  }

  const mimeType = value.mimeType;
  const sizeBytes = value.sizeBytes;
  const fileName = value.fileName;
  const width = value.width;
  const height = value.height;

  return (
    typeof value.imageId === 'string' &&
    typeof mimeType === 'string' &&
    SESSION_IMAGE_ALLOWED_MIME_TYPES.has(mimeType) &&
    typeof sizeBytes === 'number' &&
    Number.isInteger(sizeBytes) &&
    sizeBytes > 0 &&
    sizeBytes <= SESSION_IMAGE_MAX_SIZE_BYTES &&
    (typeof fileName === 'undefined' || typeof fileName === 'string') &&
    (typeof width === 'undefined' ||
      (typeof width === 'number' && Number.isInteger(width) && width > 0)) &&
    (typeof height === 'undefined' ||
      (typeof height === 'number' && Number.isInteger(height) && height > 0))
  );
}

function isSessionInputBlocks(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }

  let imageCount = 0;
  for (const block of value) {
    if (!isSessionInputBlock(block)) {
      return false;
    }
    if (isObjectRecord(block) && block.type === 'image') {
      imageCount += 1;
      if (imageCount > SESSION_IMAGE_MAX_COUNT) {
        return false;
      }
    }
  }

  return true;
}

function isSessionImagePayload(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }

  const mimeType = value.mimeType;
  const sizeBytes = value.sizeBytes;
  const fileName = value.fileName;
  const width = value.width;
  const height = value.height;

  return (
    typeof value.imageId === 'string' &&
    typeof mimeType === 'string' &&
    SESSION_IMAGE_ALLOWED_MIME_TYPES.has(mimeType) &&
    typeof sizeBytes === 'number' &&
    Number.isInteger(sizeBytes) &&
    sizeBytes > 0 &&
    sizeBytes <= SESSION_IMAGE_MAX_SIZE_BYTES &&
    (typeof fileName === 'undefined' || typeof fileName === 'string') &&
    (typeof width === 'undefined' ||
      (typeof width === 'number' && Number.isInteger(width) && width > 0)) &&
    (typeof height === 'undefined' ||
      (typeof height === 'number' && Number.isInteger(height) && height > 0))
  );
}

function isSessionFilePayload(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }

  const sizeBytes = value.sizeBytes;
  const machineId = value.machineId;
  const transport = value.transport;

  return (
    value.type === 'file' &&
    typeof value.fileId === 'string' &&
    typeof value.fileName === 'string' &&
    typeof value.mimeType === 'string' &&
    typeof sizeBytes === 'number' &&
    Number.isInteger(sizeBytes) &&
    sizeBytes >= 0 &&
    sizeBytes <= SESSION_FILE_MAX_SIZE_BYTES &&
    typeof value.sha256 === 'string' &&
    typeof value.textPreview === 'boolean' &&
    (transport === 'r2' || transport === 'local') &&
    // transport='local' must name the machine holding the bytes (pending backfill).
    (transport === 'r2'
      ? typeof machineId === 'undefined' || typeof machineId === 'string'
      : typeof machineId === 'string' && machineId.length > 0) &&
    typeof value.uploadedAt === 'number'
  );
}

function isSessionImageGroupContent(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    value.type === 'image_group' &&
    Array.isArray(value.images) &&
    value.images.length > 0 &&
    value.images.length <= SESSION_IMAGE_MAX_COUNT &&
    value.images.every((item) => isSessionImagePayload(item))
  );
}

function isStringList(
  value: unknown,
  options?: {
    min?: number;
    max?: number;
  }
): value is string[] {
  if (!Array.isArray(value)) {
    return false;
  }

  const min = options?.min ?? 0;
  const max = options?.max ?? Number.POSITIVE_INFINITY;
  if (value.length < min || value.length > max) {
    return false;
  }

  return value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function isACPSessionConfig(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }

  const issuePRMentions = value.issuePRMentions;
  const inputBlocks = value.inputBlocks;
  const configOptionValues = value.configOptionValues;
  const normalizedTarget = normalizeAcpTarget(value.cliType, value.agentType);
  if (!normalizedTarget) {
    return false;
  }
  const { cliType, agentType } = normalizedTarget;
  // This dependency-free validator has a hand-maintained CJS mirror and cannot
  // import the ESM runtime table. Keep this literal aligned with ai.ts and the
  // TS/CJS parity test.
  const isBuiltinAgentType =
    agentType === 'claude' ||
    agentType === 'codex' ||
    agentType === 'kimi' ||
    agentType === 'deepseek';
  if (
    typeof value.prompt !== 'string' ||
    (cliType === 'builtin' && !isBuiltinAgentType) ||
    !isOptionalString(value.modeId) ||
    !isOptionalString(value.modelId) ||
    !isOptionalString(value.resume) ||
    (typeof configOptionValues !== 'undefined' && !isConfigOptionValueRecord(configOptionValues)) ||
    (typeof inputBlocks !== 'undefined' && !isSessionInputBlocks(inputBlocks))
  ) {
    return false;
  }

  if (typeof issuePRMentions === 'undefined') {
    return true;
  }

  return Array.isArray(issuePRMentions) && issuePRMentions.every(isIssuePRMention);
}

export function isLocalSessionControlRequest(value: unknown): value is LocalSessionControlRequest {
  if (!isObjectRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.type === 'session/create') {
    return (
      typeof value.sessionId === 'string' &&
      typeof value.machineId === 'string' &&
      typeof value.workspaceId === 'string' &&
      (typeof value.project === 'undefined' || isProjectRef(value.project)) &&
      isACPSessionConfig(value.acpSessionConfig) &&
      (typeof value.worktreeSetup === 'undefined' || isWorktreeSetupConfig(value.worktreeSetup)) &&
      (typeof value.env === 'undefined' || isStringRecord(value.env)) &&
      (typeof value.userTurnId === 'undefined' || typeof value.userTurnId === 'string') &&
      typeof value.userId === 'string' &&
      typeof value.userName === 'string' &&
      typeof value.userEmail === 'string'
    );
  }

  if (value.type === 'session/chat') {
    return (
      typeof value.sessionId === 'string' &&
      typeof value.machineId === 'string' &&
      typeof value.workspaceId === 'string' &&
      (typeof value.project === 'undefined' || isProjectRef(value.project)) &&
      isACPSessionConfig(value.acpSessionConfig) &&
      typeof value.userTurnId === 'string' &&
      typeof value.userId === 'string' &&
      typeof value.userName === 'string' &&
      typeof value.userEmail === 'string'
    );
  }

  if (value.type === 'session/cancel') {
    return (
      typeof value.sessionId === 'string' &&
      typeof value.machineId === 'string' &&
      typeof value.workspaceId === 'string' &&
      typeof value.turnId === 'string'
    );
  }

  if (value.type === 'machine/status') {
    return typeof value.machineId === 'string' && typeof value.workspaceId === 'string';
  }

  if (value.type === 'machine/ping') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.workspaceId === 'string' &&
      typeof value.requestId === 'string' &&
      value.requestId.trim().length > 0
    );
  }

  if (value.type === 'machine/restart' || value.type === 'machine/upgrade') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.workspaceId === 'string' &&
      typeof value.requesterUserId === 'string' &&
      value.requesterUserId.trim().length > 0 &&
      typeof value.requestToken === 'string' &&
      value.requestToken.trim().length > 0 &&
      typeof value.requestId === 'string' &&
      value.requestId.trim().length > 0 &&
      (value.type === 'machine/restart' ||
        typeof value.targetVersion === 'undefined' ||
        (typeof value.targetVersion === 'string' && value.targetVersion.trim().length > 0))
    );
  }

  if (value.type === 'machine/acp-capabilities-refresh') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.workspaceId === 'string' &&
      typeof value.configId === 'string' &&
      value.configId.trim().length > 0 &&
      typeof value.cliType === 'undefined' &&
      typeof value.agentType === 'undefined' &&
      typeof value.customAcp === 'undefined' &&
      typeof value.runtimeOverrides === 'undefined' &&
      typeof value.env === 'undefined'
    );
  }

  if (value.type === 'machine/acp-authenticate') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.workspaceId === 'string' &&
      typeof value.requestId === 'string' &&
      value.requestId.trim().length > 0 &&
      value.requestId.length <= 1024 &&
      (value.action === 'start' ||
        value.action === 'cancel' ||
        value.action === 'submit-code' ||
        value.action === 'submit-input') &&
      (value.action === 'start'
        ? typeof value.configId === 'string' &&
          value.configId.trim().length > 0 &&
          typeof value.authenticationRequestId === 'undefined' &&
          typeof value.authorizationCode === 'undefined' &&
          typeof value.interactionId === 'undefined' &&
          typeof value.authenticationInput === 'undefined'
        : value.action === 'cancel'
          ? typeof value.authenticationRequestId === 'string' &&
            value.authenticationRequestId.trim().length > 0 &&
            value.authenticationRequestId.length <= 1024 &&
            typeof value.configId === 'undefined' &&
            typeof value.authorizationCode === 'undefined' &&
            typeof value.interactionId === 'undefined' &&
            typeof value.authenticationInput === 'undefined'
          : value.action === 'submit-code'
            ? typeof value.authenticationRequestId === 'string' &&
              value.authenticationRequestId.trim().length > 0 &&
              value.authenticationRequestId.length <= 1024 &&
              typeof value.authorizationCode === 'string' &&
              value.authorizationCode.trim().length > 0 &&
              value.authorizationCode.length <= 4096 &&
              typeof value.configId === 'undefined' &&
              typeof value.interactionId === 'undefined' &&
              typeof value.authenticationInput === 'undefined'
            : value.action === 'submit-input'
              ? typeof value.authenticationRequestId === 'string' &&
                value.authenticationRequestId.trim().length > 0 &&
                value.authenticationRequestId.length <= 1024 &&
                typeof value.interactionId === 'string' &&
                value.interactionId.trim().length > 0 &&
                value.interactionId.length <= 1024 &&
                typeof value.authenticationInput === 'string' &&
                value.authenticationInput.length > 0 &&
                value.authenticationInput.length <= 65536 &&
                typeof value.configId === 'undefined' &&
                typeof value.authorizationCode === 'undefined'
              : false) &&
      typeof value.cliType === 'undefined' &&
      typeof value.agentType === 'undefined' &&
      typeof value.customAcp === 'undefined' &&
      typeof value.runtimeOverrides === 'undefined' &&
      typeof value.env === 'undefined' &&
      typeof value.methodId === 'undefined'
    );
  }

  if (value.type === 'machine/acp-binary-status' || value.type === 'machine/acp-binary-install') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.workspaceId === 'string' &&
      typeof value.agentType === 'string' &&
      value.agentType.trim().length > 0
    );
  }

  if (value.type === 'session/code-collab-host-start') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.workspaceId === 'string' &&
      typeof value.sessionId === 'string' &&
      typeof value.requestedByUserId === 'string' &&
      value.requestedByUserId.trim().length > 0
    );
  }

  if (value.type === 'session/image-upload') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.sessionId === 'string' &&
      isOptionalString(value.workspaceId) &&
      isStringList(value.paths, { min: 1, max: SESSION_IMAGE_MAX_COUNT })
    );
  }

  if (value.type === 'session/file-upload' || value.type === 'session/file-send-local') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.sessionId === 'string' &&
      isOptionalString(value.workspaceId) &&
      isStringList(value.paths, { min: 1, max: SESSION_FILE_MAX_COUNT })
    );
  }

  if (value.type === 'session/preview-candidate-report') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.workspaceId === 'string' &&
      typeof value.sessionId === 'string' &&
      isPreviewTarget(value.target) &&
      isPreviewSource(value.source)
    );
  }

  if (value.type === 'session/preview-create') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.workspaceId === 'string' &&
      typeof value.sessionId === 'string' &&
      typeof value.requestedByUserId === 'string' &&
      isPreviewTarget(value.target) &&
      isPreviewApproval(value.approval) &&
      (typeof value.replaceExisting === 'undefined' || typeof value.replaceExisting === 'boolean')
    );
  }

  if (value.type === 'session/preview-revoke') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.workspaceId === 'string' &&
      typeof value.sessionId === 'string' &&
      typeof value.requestedByUserId === 'string' &&
      isOptionalString(value.reason)
    );
  }

  return false;
}

function isMachineResourceInfo(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }

  return (
    typeof value.totalMemoryGB === 'number' &&
    typeof value.usedMemoryGB === 'number' &&
    typeof value.freeMemoryGB === 'number' &&
    typeof value.totalCpus === 'number' &&
    typeof value.cpuUsagePercent === 'number'
  );
}

function isMachineLifecycleCapability(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    (value.launchMode === 'daemon' ||
      value.launchMode === 'foreground' ||
      value.launchMode === 'electron' ||
      value.launchMode === 'unknown') &&
    typeof value.canRemoteRestart === 'boolean' &&
    typeof value.canRemoteUpgrade === 'boolean' &&
    (typeof value.reason === 'undefined' ||
      value.reason === 'not_daemon' ||
      value.reason === 'electron' ||
      value.reason === 'unsupported_install')
  );
}

function isAcpModeInfo(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (typeof value.description === 'undefined' || typeof value.description === 'string')
  );
}

function isAcpModelInfo(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    typeof value.modelId === 'string' &&
    (typeof value.name === 'undefined' || typeof value.name === 'string') &&
    (typeof value.description === 'undefined' || typeof value.description === 'string')
  );
}

export function isLocalSessionControlResponse(
  value: unknown
): value is LocalSessionControlResponse {
  if (!isObjectRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.type === 'session/create_ack') {
    return typeof value.sessionId === 'string';
  }

  if (value.type === 'session/create_response') {
    return (
      typeof value.sessionId === 'string' &&
      typeof value.success === 'boolean' &&
      isOptionalString(value.error)
    );
  }

  if (value.type === 'session/chat_ack') {
    return typeof value.sessionId === 'string' && typeof value.userTurnId === 'string';
  }

  if (value.type === 'session/chat_response') {
    return (
      typeof value.sessionId === 'string' &&
      typeof value.userTurnId === 'string' &&
      typeof value.success === 'boolean' &&
      isOptionalString(value.error)
    );
  }

  if (value.type === 'session/cancel_response') {
    return (
      typeof value.sessionId === 'string' &&
      typeof value.success === 'boolean' &&
      isOptionalString(value.error)
    );
  }

  if (value.type === 'machine/status_response') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.success === 'boolean' &&
      (typeof value.resources === 'undefined' || isMachineResourceInfo(value.resources)) &&
      (typeof value.lifecycle === 'undefined' || isMachineLifecycleCapability(value.lifecycle)) &&
      isOptionalString(value.error)
    );
  }

  if (value.type === 'machine/ping_response') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.requestId === 'string' &&
      value.requestId.trim().length > 0 &&
      typeof value.success === 'boolean' &&
      (typeof value.message === 'undefined' || value.message === 'pong') &&
      isOptionalString(value.error)
    );
  }

  if (value.type === 'machine/restart_response' || value.type === 'machine/upgrade_response') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.requestId === 'string' &&
      value.requestId.trim().length > 0 &&
      typeof value.success === 'boolean' &&
      typeof value.accepted === 'boolean' &&
      (value.disposition === 'accepted' ||
        value.disposition === 'already_pending' ||
        value.disposition === 'unauthorized' ||
        value.disposition === 'invalid_target' ||
        value.disposition === 'unsupported_launch_mode' ||
        value.disposition === 'unsupported_install' ||
        value.disposition === 'error') &&
      isOptionalString(value.error) &&
      (value.type === 'machine/restart_response' ||
        (isOptionalString(value.currentVersion) && isOptionalString(value.targetVersion)))
    );
  }

  if (value.type === 'machine/acp-capabilities-refresh_response') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.configId === 'string' &&
      value.configId.trim().length > 0 &&
      isAgentConfigCliType(value.cliType) &&
      typeof value.agentType === 'string' &&
      value.agentType.trim().length > 0 &&
      typeof value.success === 'boolean' &&
      (typeof value.modes === 'undefined' ||
        (Array.isArray(value.modes) && value.modes.every(isAcpModeInfo))) &&
      (typeof value.models === 'undefined' ||
        (Array.isArray(value.models) && value.models.every(isAcpModelInfo))) &&
      (typeof value.authRequired === 'undefined' || typeof value.authRequired === 'boolean') &&
      (typeof value.authMethods === 'undefined' ||
        (Array.isArray(value.authMethods) && value.authMethods.every(isAcpAuthMethodSummary))) &&
      isOptionalString(value.error)
    );
  }

  if (value.type === 'machine/acp-authenticate_response') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.requestId === 'string' &&
      value.requestId.trim().length > 0 &&
      typeof value.agentType === 'string' &&
      value.agentType.trim().length > 0 &&
      typeof value.success === 'boolean' &&
      (value.disposition === 'authenticated' ||
        value.disposition === 'cancelled' ||
        value.disposition === 'not-running' ||
        value.disposition === 'input-accepted' ||
        value.disposition === 'error') &&
      (typeof value.capabilitiesRefreshed === 'undefined' ||
        typeof value.capabilitiesRefreshed === 'boolean') &&
      (typeof value.authRequired === 'undefined' || typeof value.authRequired === 'boolean') &&
      (typeof value.authMethods === 'undefined' ||
        (Array.isArray(value.authMethods) && value.authMethods.every(isAcpAuthMethodSummary))) &&
      isOptionalString(value.error)
    );
  }

  if (value.type === 'machine/acp-authentication-progress') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.requestId === 'string' &&
      value.requestId.trim().length > 0 &&
      typeof value.agentType === 'string' &&
      value.agentType.trim().length > 0 &&
      (value.status === 'starting' ||
        value.status === 'auth-methods' ||
        value.status === 'authorization' ||
        value.status === 'input-required' ||
        value.status === 'output' ||
        value.status === 'authenticated' ||
        value.status === 'cancelled' ||
        value.status === 'error') &&
      (typeof value.stream === 'undefined' ||
        value.stream === 'stdout' ||
        value.stream === 'stderr') &&
      (typeof value.authorizationUrl === 'undefined' ||
        (typeof value.authorizationUrl === 'string' && value.authorizationUrl.length <= 8192)) &&
      (value.status !== 'authorization' ||
        (typeof value.authorizationUrl === 'string' && value.authorizationUrl.length > 0)) &&
      (typeof value.userCode === 'undefined' ||
        (typeof value.userCode === 'string' &&
          value.userCode.length > 0 &&
          value.userCode.length <= 128)) &&
      (typeof value.acceptsAuthorizationCode === 'undefined' ||
        typeof value.acceptsAuthorizationCode === 'boolean') &&
      (typeof value.authMethods === 'undefined' ||
        (Array.isArray(value.authMethods) && value.authMethods.every(isAcpAuthMethodSummary))) &&
      isOptionalString(value.interactionId) &&
      isOptionalString(value.message) &&
      (typeof value.form === 'undefined' || isAcpAuthenticationForm(value.form)) &&
      (typeof value.expiresInSeconds === 'undefined' ||
        (typeof value.expiresInSeconds === 'number' &&
          Number.isInteger(value.expiresInSeconds) &&
          value.expiresInSeconds > 0)) &&
      isOptionalString(value.output) &&
      isOptionalString(value.error)
    );
  }

  if (value.type === 'machine/acp-binary-status_response') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.agentType === 'string' &&
      value.agentType.trim().length > 0 &&
      typeof value.success === 'boolean' &&
      (value.status === 'installed' ||
        value.status === 'not-applicable' ||
        value.status === 'not-installed' ||
        value.status === 'unsupported-platform' ||
        value.status === 'incompatible-host' ||
        value.status === 'error') &&
      isOptionalString(value.command) &&
      isOptionalString(value.platformArch) &&
      isOptionalString(value.installPath) &&
      isOptionalString(value.version) &&
      isOptionalString(value.current) &&
      isOptionalString(value.required) &&
      isOptionalString(value.error)
    );
  }

  if (value.type === 'machine/acp-binary-install_response') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.agentType === 'string' &&
      value.agentType.trim().length > 0 &&
      typeof value.success === 'boolean' &&
      isOptionalString(value.command) &&
      isOptionalString(value.installPath) &&
      isOptionalString(value.version) &&
      isOptionalString(value.error)
    );
  }

  if (value.type === 'machine/acp-binary-progress') {
    return (
      typeof value.machineId === 'string' &&
      typeof value.agentType === 'string' &&
      value.agentType.trim().length > 0 &&
      (value.status === 'checking' ||
        value.status === 'not-installed' ||
        value.status === 'downloading' ||
        value.status === 'verifying' ||
        value.status === 'extracting' ||
        value.status === 'publishing' ||
        value.status === 'installed' ||
        value.status === 'unsupported-platform' ||
        value.status === 'incompatible-host' ||
        value.status === 'error') &&
      (typeof value.downloadedBytes === 'undefined' ||
        (typeof value.downloadedBytes === 'number' &&
          Number.isInteger(value.downloadedBytes) &&
          value.downloadedBytes >= 0)) &&
      (typeof value.totalBytes === 'undefined' ||
        (typeof value.totalBytes === 'number' &&
          Number.isInteger(value.totalBytes) &&
          value.totalBytes >= 0)) &&
      (typeof value.percent === 'undefined' ||
        (typeof value.percent === 'number' && value.percent >= 0 && value.percent <= 100)) &&
      isOptionalString(value.platformArch) &&
      isOptionalString(value.version) &&
      isOptionalString(value.current) &&
      isOptionalString(value.required) &&
      isOptionalString(value.command) &&
      isOptionalString(value.error)
    );
  }

  if (value.type === 'session/code-collab-host-start_response') {
    return (
      typeof value.sessionId === 'string' &&
      typeof value.success === 'boolean' &&
      (typeof value.status === 'undefined' ||
        value.status === 'started' ||
        value.status === 'already-running' ||
        value.status === 'disabled' ||
        value.status === 'failed' ||
        value.status === 'stopped') &&
      isOptionalString(value.error) &&
      isOptionalString(value.message)
    );
  }

  if (value.type === 'session/image-upload_response') {
    return (
      typeof value.sessionId === 'string' &&
      isOptionalString(value.workspaceId) &&
      typeof value.success === 'boolean' &&
      isOptionalString(value.error) &&
      isOptionalString(value.message) &&
      (typeof value.historyEntryId === 'undefined' || typeof value.historyEntryId === 'string') &&
      (typeof value.attachedTo === 'undefined' ||
        value.attachedTo === 'active_turn' ||
        value.attachedTo === 'new_entry') &&
      (typeof value.content === 'undefined' || isSessionImageGroupContent(value.content)) &&
      (typeof value.images === 'undefined' ||
        (Array.isArray(value.images) &&
          value.images.length > 0 &&
          value.images.length <= SESSION_IMAGE_MAX_COUNT &&
          value.images.every(
            (item) =>
              isObjectRecord(item) &&
              isSessionImagePayload(item) &&
              typeof item.downloadUrl === 'string'
          )))
    );
  }

  if (value.type === 'session/file-upload_response') {
    return (
      typeof value.sessionId === 'string' &&
      isOptionalString(value.workspaceId) &&
      typeof value.success === 'boolean' &&
      isOptionalString(value.error) &&
      isOptionalString(value.message) &&
      (typeof value.historyEntryId === 'undefined' || typeof value.historyEntryId === 'string') &&
      (typeof value.attachedTo === 'undefined' ||
        value.attachedTo === 'active_turn' ||
        value.attachedTo === 'new_entry') &&
      (typeof value.files === 'undefined' ||
        (Array.isArray(value.files) &&
          value.files.length > 0 &&
          value.files.length <= SESSION_FILE_MAX_COUNT &&
          value.files.every(
            (item) =>
              isObjectRecord(item) &&
              isSessionFilePayload(item) &&
              typeof item.downloadUrl === 'string'
          )))
    );
  }

  if (value.type === 'session/file-send-local_response') {
    return (
      typeof value.sessionId === 'string' &&
      isOptionalString(value.workspaceId) &&
      typeof value.success === 'boolean' &&
      isOptionalString(value.error) &&
      isOptionalString(value.message) &&
      // Local-transport blocks carry no downloadUrl; `isSessionFilePayload`
      // enforces transport='local' ⇒ machineId.
      (typeof value.files === 'undefined' ||
        (Array.isArray(value.files) &&
          value.files.length > 0 &&
          value.files.length <= SESSION_FILE_MAX_COUNT &&
          value.files.every((item) => isObjectRecord(item) && isSessionFilePayload(item))))
    );
  }

  if (value.type === 'session/preview-candidate-report_response') {
    return (
      typeof value.sessionId === 'string' &&
      typeof value.success === 'boolean' &&
      (typeof value.candidate === 'undefined' || isPreviewCandidate(value.candidate)) &&
      isOptionalString(value.error) &&
      isOptionalString(value.message)
    );
  }

  if (
    value.type === 'session/preview-create_response' ||
    value.type === 'session/preview-revoke_response'
  ) {
    return (
      typeof value.sessionId === 'string' &&
      typeof value.success === 'boolean' &&
      (typeof value.connection === 'undefined' || isPreviewConnection(value.connection)) &&
      isOptionalString(value.error) &&
      isOptionalString(value.message)
    );
  }

  return false;
}

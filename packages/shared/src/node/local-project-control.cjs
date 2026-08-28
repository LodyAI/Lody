const LOCAL_PROJECT_CONTROL_PATH = '/project-control';

function isObjectRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalBoolean(value) {
  return typeof value === 'undefined' || typeof value === 'boolean';
}

function isOptionalInteger(value) {
  return typeof value === 'undefined' || (Number.isInteger(value) && value > 0);
}

function isOptionalString(value) {
  return typeof value === 'undefined' || typeof value === 'string';
}

function isWorktreeSetupConfig(value) {
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

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isLocalProjectHistoryProvider(value) {
  return (
    isObjectRecord(value) &&
    (value.cliType === 'builtin' || value.cliType === 'registry') &&
    typeof value.agentType === 'string' &&
    value.agentType.trim().length > 0
  );
}

function isLocalProjectFileListResult(value) {
  return (
    isObjectRecord(value) && isStringArray(value.paths) && typeof value.truncated === 'boolean'
  );
}

function isLocalProjectFileReadResult(value) {
  return (
    isObjectRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.content === 'string' &&
    typeof value.truncated === 'boolean'
  );
}

function isLocalProjectDirectoryListResult(value) {
  return (
    isObjectRecord(value) &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        isObjectRecord(entry) &&
        typeof entry.name === 'string' &&
        (entry.type === 'file' || entry.type === 'directory')
    ) &&
    typeof value.truncated === 'boolean'
  );
}

function isProjectSkillsResult(value) {
  return (
    isObjectRecord(value) &&
    Array.isArray(value.groups) &&
    value.groups.every(
      (group) =>
        isObjectRecord(group) &&
        (group.scope === 'project' || group.scope === 'global' || group.scope === 'system') &&
        typeof group.dir === 'string' &&
        Array.isArray(group.skills) &&
        group.skills.every(
          (skill) =>
            isObjectRecord(skill) &&
            typeof skill.id === 'string' &&
            typeof skill.name === 'string' &&
            (typeof skill.description === 'undefined' || typeof skill.description === 'string') &&
            (typeof skill.version === 'undefined' || typeof skill.version === 'string') &&
            (typeof skill.author === 'undefined' || typeof skill.author === 'string') &&
            typeof skill.relativePath === 'string' &&
            (typeof skill.absolutePath === 'undefined' || typeof skill.absolutePath === 'string') &&
            typeof skill.isSymlink === 'boolean' &&
            (typeof skill.symlinkTarget === 'undefined' ||
              typeof skill.symlinkTarget === 'string') &&
            (typeof skill.content === 'undefined' || typeof skill.content === 'string')
        ) &&
        typeof group.truncated === 'boolean' &&
        (typeof group.skippedExternalSymlinks === 'undefined' ||
          (Number.isInteger(group.skippedExternalSymlinks) &&
            group.skippedExternalSymlinks >= 0)) &&
        (typeof group.error === 'undefined' || typeof group.error === 'string')
    ) &&
    (typeof value.contentFingerprint === 'undefined' ||
      typeof value.contentFingerprint === 'string')
  );
}

function isLocalProjectBrowseRootsResult(value) {
  return (
    isObjectRecord(value) &&
    (value.platform === 'darwin' || value.platform === 'linux' || value.platform === 'win32') &&
    (value.pathSeparator === '/' || value.pathSeparator === '\\') &&
    typeof value.homeDir === 'string' &&
    (typeof value.drives === 'undefined' || isStringArray(value.drives))
  );
}

function isLocalProjectBrowseDirectoryResult(value) {
  return (
    isObjectRecord(value) &&
    typeof value.path === 'string' &&
    (value.parentPath === null || typeof value.parentPath === 'string') &&
    Array.isArray(value.entries) &&
    value.entries.every((entry) => {
      if (
        !isObjectRecord(entry) ||
        typeof entry.name !== 'string' ||
        typeof entry.absolutePath !== 'string' ||
        typeof entry.isSymlink !== 'boolean' ||
        typeof entry.hidden !== 'boolean'
      ) {
        return false;
      }
      const hints = entry.hints;
      return (
        (typeof hints === 'undefined' ||
          (isObjectRecord(hints) &&
            (typeof hints.git === 'undefined' || typeof hints.git === 'boolean'))) &&
        (typeof entry.registeredProjectId === 'undefined' ||
          typeof entry.registeredProjectId === 'string') &&
        (typeof entry.error === 'undefined' || entry.error === 'unreadable')
      );
    }) &&
    typeof value.truncated === 'boolean' &&
    (typeof value.nextCursor === 'undefined' || typeof value.nextCursor === 'string')
  );
}

function isLocalProjectGitState(value) {
  if (!isObjectRecord(value)) {
    return false;
  }

  if (value.git === false) {
    return true;
  }

  return (
    value.git === true &&
    isStringArray(value.branches) &&
    (value.currentBranch === null || typeof value.currentBranch === 'string') &&
    (value.defaultBranch === null || typeof value.defaultBranch === 'string') &&
    (value.githubRepoFullName === null || typeof value.githubRepoFullName === 'string') &&
    isObjectRecord(value.workingTree) &&
    typeof value.workingTree.clean === 'boolean' &&
    typeof value.workingTree.staged === 'boolean' &&
    typeof value.workingTree.unstaged === 'boolean' &&
    typeof value.workingTree.untracked === 'boolean' &&
    typeof value.workingTree.conflicted === 'boolean'
  );
}

function isLocalProjectCheckoutBranchResult(value) {
  if (!isObjectRecord(value) || typeof value.success !== 'boolean') {
    return false;
  }

  if (value.success) {
    return typeof value.currentBranch === 'string';
  }

  return typeof value.error === 'string';
}

function isLocalProjectHistorySyncSummary(value) {
  return (
    isObjectRecord(value) &&
    typeof value.listed === 'number' &&
    Number.isInteger(value.listed) &&
    value.listed >= 0 &&
    typeof value.imported === 'number' &&
    Number.isInteger(value.imported) &&
    value.imported >= 0 &&
    typeof value.refreshed === 'number' &&
    Number.isInteger(value.refreshed) &&
    value.refreshed >= 0 &&
    typeof value.skipped === 'number' &&
    Number.isInteger(value.skipped) &&
    value.skipped >= 0 &&
    typeof value.conflicted === 'number' &&
    Number.isInteger(value.conflicted) &&
    value.conflicted >= 0 &&
    typeof value.failed === 'number' &&
    Number.isInteger(value.failed) &&
    value.failed >= 0 &&
    Array.isArray(value.failures) &&
    value.failures.every(
      (failure) =>
        isObjectRecord(failure) &&
        typeof failure.acpSessionId === 'string' &&
        typeof failure.message === 'string'
    )
  );
}

function isLocalProjectHistoryCatalogItem(value) {
  return (
    isObjectRecord(value) &&
    typeof value.acpSessionId === 'string' &&
    typeof value.title === 'string' &&
    (typeof value.updatedAt === 'undefined' || typeof value.updatedAt === 'string') &&
    (typeof value.importedSessionId === 'undefined' ||
      typeof value.importedSessionId === 'string') &&
    (typeof value.status === 'undefined' ||
      value.status === 'available' ||
      value.status === 'imported' ||
      value.status === 'sync_conflict')
  );
}

function isLocalProjectHistoryCatalogResult(value) {
  return (
    isObjectRecord(value) &&
    typeof value.listed === 'number' &&
    Number.isInteger(value.listed) &&
    value.listed >= 0 &&
    typeof value.lastListedAt === 'number' &&
    Number.isInteger(value.lastListedAt) &&
    value.lastListedAt >= 0 &&
    Array.isArray(value.sessions) &&
    value.sessions.every(isLocalProjectHistoryCatalogItem)
  );
}

function isLocalProjectHistoryImportResult(value) {
  return (
    isObjectRecord(value) &&
    isLocalProjectHistorySyncSummary(value.summary) &&
    isLocalProjectHistoryCatalogResult(value.catalog)
  );
}

function isLocalProjectHistoryConflictResolveResult(value) {
  return (
    isObjectRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.acpSessionId === 'string' &&
    value.status === 'resolved' &&
    isLocalProjectHistoryCatalogResult(value.catalog)
  );
}

function isWorkspaceIds(value) {
  return isStringArray(value);
}

function isLocalProjectWorktreeCleanupItem(value, failure = false) {
  return (
    isObjectRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.path === 'string' &&
    (!failure || typeof value.message === 'string')
  );
}

function isLocalProjectWorktreeCleanupPreflightResult(value) {
  return (
    isObjectRecord(value) &&
    Array.isArray(value.clean) &&
    value.clean.every((item) => isLocalProjectWorktreeCleanupItem(item)) &&
    Array.isArray(value.dirty) &&
    value.dirty.every((item) => isLocalProjectWorktreeCleanupItem(item)) &&
    Array.isArray(value.failed) &&
    value.failed.every((item) => isLocalProjectWorktreeCleanupItem(item, true))
  );
}

function isLocalProjectControlRequest(value) {
  if (
    !isObjectRecord(value) ||
    typeof value.type !== 'string' ||
    typeof value.machineId !== 'string'
  ) {
    return false;
  }

  if (value.type === 'local-project/add') {
    return (
      typeof value.rootPath === 'string' &&
      (typeof value.workspace === 'undefined' || typeof value.workspace === 'string') &&
      isOptionalBoolean(value.allWorkspaces)
    );
  }

  if (value.type === 'local-project/list-roots') {
    return true;
  }

  if (value.type === 'local-project/browse-dir') {
    return (
      isOptionalString(value.workspaceId) &&
      isOptionalString(value.absolutePath) &&
      isOptionalBoolean(value.showHidden) &&
      isOptionalInteger(value.limit) &&
      isOptionalString(value.cursor)
    );
  }

  if (value.type === 'local-project/delete') {
    return typeof value.workspaceId === 'string' && typeof value.localProjectId === 'string';
  }

  if (value.type === 'local-project/removal-preflight') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/list') {
    return true;
  }

  if (value.type === 'local-project/git-state') {
    return typeof value.workspaceId === 'string' && typeof value.localProjectId === 'string';
  }

  if (value.type === 'local-project/list-files') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isOptionalInteger(value.maxFiles) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/list-dir') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      typeof value.relativePath === 'string' &&
      isOptionalInteger(value.limit) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/list-skills') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isStringArray(value.skillDirs) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/list-global-skills') {
    return typeof value.workspaceId === 'string' && isOptionalString(value.requestedByUserId);
  }

  if (value.type === 'local-project/read-file') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      typeof value.relativePath === 'string' &&
      isOptionalInteger(value.maxBytes) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/checkout-branch') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      typeof value.branchName === 'string'
    );
  }

  if (value.type === 'local-project/get-worktree-setup') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/set-worktree-setup') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isWorktreeSetupConfig(value.config) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/get-worktree-cleanup') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/set-worktree-cleanup') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isWorktreeSetupConfig(value.config) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/sync-history') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isLocalProjectHistoryProvider(value.provider) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/import-history') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isLocalProjectHistoryProvider(value.provider) &&
      isStringArray(value.acpSessionIds) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/resolve-history-conflict') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isLocalProjectHistoryProvider(value.provider) &&
      typeof value.sessionId === 'string' &&
      typeof value.acpSessionId === 'string' &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'worktree/list-files') {
    return (
      typeof value.repoFullName === 'string' &&
      typeof value.sessionId === 'string' &&
      isOptionalInteger(value.maxFiles)
    );
  }

  if (value.type === 'worktree/read-file') {
    return (
      typeof value.repoFullName === 'string' &&
      typeof value.sessionId === 'string' &&
      typeof value.relativePath === 'string' &&
      isOptionalInteger(value.maxBytes)
    );
  }

  return false;
}

function isLocalProjectControlResponse(value) {
  if (!isObjectRecord(value) || typeof value.type !== 'string' || typeof value.ok !== 'boolean') {
    return false;
  }

  if (!value.ok) {
    return typeof value.error === 'string' && typeof value.message === 'string';
  }

  if (value.type === 'local-project/add') {
    return (
      isObjectRecord(value.result) &&
      typeof value.result.localProjectId === 'string' &&
      typeof value.result.name === 'string' &&
      typeof value.result.rootPath === 'string' &&
      isWorkspaceIds(value.result.workspaceIds)
    );
  }

  if (value.type === 'local-project/list-roots') {
    return isLocalProjectBrowseRootsResult(value.result);
  }

  if (value.type === 'local-project/browse-dir') {
    return isLocalProjectBrowseDirectoryResult(value.result);
  }

  if (value.type === 'local-project/delete') {
    return (
      isObjectRecord(value.result) &&
      typeof value.result.localProjectId === 'string' &&
      typeof value.result.name === 'string' &&
      typeof value.result.rootPath === 'string' &&
      isWorkspaceIds(value.result.workspaceIds)
    );
  }

  if (value.type === 'local-project/removal-preflight') {
    return isLocalProjectWorktreeCleanupPreflightResult(value.result);
  }

  if (value.type === 'local-project/list') {
    return (
      isObjectRecord(value.result) &&
      Array.isArray(value.result.workspaces) &&
      value.result.workspaces.every(
        (workspace) =>
          isObjectRecord(workspace) &&
          typeof workspace.workspaceId === 'string' &&
          typeof workspace.workspaceName === 'string' &&
          Array.isArray(workspace.projects) &&
          workspace.projects.every(
            (project) =>
              isObjectRecord(project) &&
              typeof project.localProjectId === 'string' &&
              typeof project.name === 'string' &&
              typeof project.rootPath === 'string'
          )
      )
    );
  }

  if (value.type === 'local-project/list-files' || value.type === 'worktree/list-files') {
    return isLocalProjectFileListResult(value.result);
  }

  if (value.type === 'local-project/list-dir') {
    return isLocalProjectDirectoryListResult(value.result);
  }

  if (value.type === 'local-project/list-skills') {
    return isProjectSkillsResult(value.result);
  }

  if (value.type === 'local-project/list-global-skills') {
    return isProjectSkillsResult(value.result);
  }

  if (value.type === 'local-project/read-file' || value.type === 'worktree/read-file') {
    return value.result === null || isLocalProjectFileReadResult(value.result);
  }

  if (value.type === 'local-project/git-state') {
    return isLocalProjectGitState(value.result);
  }

  if (value.type === 'local-project/checkout-branch') {
    return isLocalProjectCheckoutBranchResult(value.result);
  }

  if (value.type === 'local-project/get-worktree-setup') {
    return value.result === null || isWorktreeSetupConfig(value.result);
  }

  if (value.type === 'local-project/set-worktree-setup') {
    return isWorktreeSetupConfig(value.result);
  }

  if (value.type === 'local-project/get-worktree-cleanup') {
    return value.result === null || isWorktreeSetupConfig(value.result);
  }

  if (value.type === 'local-project/set-worktree-cleanup') {
    return isWorktreeSetupConfig(value.result);
  }

  if (value.type === 'local-project/sync-history') {
    return isLocalProjectHistoryCatalogResult(value.result);
  }

  if (value.type === 'local-project/import-history') {
    return isLocalProjectHistoryImportResult(value.result);
  }

  if (value.type === 'local-project/resolve-history-conflict') {
    return isLocalProjectHistoryConflictResolveResult(value.result);
  }

  return false;
}

module.exports = {
  LOCAL_PROJECT_CONTROL_PATH,
  isLocalProjectControlRequest,
  isLocalProjectControlResponse,
};

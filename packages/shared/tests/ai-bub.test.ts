import { describe, expect, it } from 'vitest';

import {
  BUB_ACP_INSTALL_DOCS_URL,
  acpOwnsSessionTitleGeneration,
  getBuiltinAgentByAgentType,
  getBuiltinAgentInstallDocsUrl,
  getBuiltinDefaultModeId,
  getManagedBuiltinRuntimeByAgentType,
  getStaticBuiltinAcpCapabilities,
  isBuiltinAgentType,
  isManagedBuiltinAgentType,
  supportsBuiltinProviderSetup,
} from '../src/ai';
import { supportsBuiltinAuthentication } from '../src/agent-authentication';

describe('builtin Bub shared contract', () => {
  it('is builtin without being a managed-download runtime', () => {
    expect(isBuiltinAgentType('bub')).toBe(true);
    expect(isManagedBuiltinAgentType('bub')).toBe(false);
    expect(supportsBuiltinProviderSetup('bub')).toBe(true);
    expect(getManagedBuiltinRuntimeByAgentType('bub')).toBeUndefined();
    expect(getBuiltinAgentByAgentType('bub')).toEqual({
      agentType: 'bub',
      displayName: 'Bub',
    });
  });

  it('stays outside startup auto-registration while using deferred verification', () => {
    expect(isManagedBuiltinAgentType('bub')).toBe(false);
    expect(supportsBuiltinProviderSetup('bub')).toBe(true);
  });

  it('points install failures at the ACP server tutorial', () => {
    expect(getBuiltinAgentInstallDocsUrl('bub')).toBe(BUB_ACP_INSTALL_DOCS_URL);
    expect(getBuiltinAgentInstallDocsUrl('claude')).toBeUndefined();
    expect(getBuiltinAgentInstallDocsUrl('not-an-agent')).toBeUndefined();
  });

  it('offers no interactive sign-in of its own', () => {
    expect(supportsBuiltinAuthentication({ cliType: 'builtin', agentType: 'bub' })).toBe(false);
  });

  it('keeps the isolated title generator because Bub pushes no title', () => {
    expect(acpOwnsSessionTitleGeneration('builtin', 'bub')).toBe(false);
  });

  it('waits for a live probe before advertising modes, models, or config options', () => {
    const capabilities = getStaticBuiltinAcpCapabilities('builtin', 'bub');
    expect(capabilities).toEqual({ modes: [], models: [], configOptions: [] });
    // A non-empty fallback id is harmless: the selector only uses it when the
    // probed capability actually offers that mode.
    expect(getBuiltinDefaultModeId('builtin', 'bub')).toBe('default');
  });
});

import { describe, expect, it } from 'vitest';

import {
  readAcpApprovalPolicyValue,
  readAcpPermissionModeValue,
  shouldAutoApproveAcpToolPermission,
  type AcpPermissionPolicyConfigOption,
} from '../src/acp-auto-approve-policy';

const permissionOption = (
  currentValue: string,
  category = '_permission'
): AcpPermissionPolicyConfigOption => ({
  id: 'permission_mode',
  category,
  type: 'select',
  currentValue,
});

const modeOption = (currentValue: string): AcpPermissionPolicyConfigOption => ({
  id: 'mode',
  category: 'mode',
  type: 'select',
  currentValue,
});

describe('acp auto-approve policy', () => {
  it('reads Grok permission mode from _permission category', () => {
    expect(readAcpPermissionModeValue([permissionOption('always-approve')])).toBe('always-approve');
  });

  it('reads Codex mode from mode category', () => {
    expect(readAcpPermissionModeValue([modeOption('agent-full-access')])).toBe('agent-full-access');
  });

  it('reads Codex approval_policy when present', () => {
    expect(
      readAcpApprovalPolicyValue([
        { id: 'approval_policy', category: 'mode', type: 'select', currentValue: 'never' },
      ])
    ).toBe('never');
  });

  it('auto-approves Grok always-approve tool permissions', () => {
    expect(
      shouldAutoApproveAcpToolPermission({
        configOptions: [permissionOption('always-approve')],
        requestKind: 'permission',
      })
    ).toBe(true);
  });

  it('does not auto-approve Grok auto classifier mode', () => {
    expect(
      shouldAutoApproveAcpToolPermission({
        configOptions: [permissionOption('auto')],
        requestKind: 'permission',
      })
    ).toBe(false);
  });

  it('auto-approves Codex full-access and approval_policy never', () => {
    expect(
      shouldAutoApproveAcpToolPermission({
        configOptions: [modeOption('agent-full-access')],
        requestKind: 'permission',
      })
    ).toBe(true);
    expect(
      shouldAutoApproveAcpToolPermission({
        configOptions: [
          modeOption('agent'),
          { id: 'approval_policy', category: 'mode', type: 'select', currentValue: 'never' },
        ],
        requestKind: 'permission',
      })
    ).toBe(true);
  });

  it('auto-approves Claude dontAsk and yolo', () => {
    expect(
      shouldAutoApproveAcpToolPermission({
        configOptions: [modeOption('dontAsk')],
        requestKind: 'permission',
      })
    ).toBe(true);
    expect(
      shouldAutoApproveAcpToolPermission({
        configOptions: [modeOption('yolo')],
        requestKind: 'permission',
      })
    ).toBe(true);
  });

  it('does not auto-approve classifier modes or ask-user-question prompts', () => {
    expect(
      shouldAutoApproveAcpToolPermission({
        configOptions: [modeOption('agent-auto-review')],
        requestKind: 'permission',
      })
    ).toBe(false);
    expect(
      shouldAutoApproveAcpToolPermission({
        configOptions: [modeOption('auto')],
        requestKind: 'permission',
      })
    ).toBe(false);
    expect(
      shouldAutoApproveAcpToolPermission({
        configOptions: [permissionOption('always-approve')],
        requestKind: 'ask_user_question',
      })
    ).toBe(false);
  });
});

import type { ChatFailedCode } from '@lody/shared';

export type ChatFailedDiagnosticCopy = {
  titleKey: string;
  title: string;
  actionKey: string;
  action: string;
  installUrl?: string;
};

export function getChatFailedDiagnosticCopy(
  code: ChatFailedCode | undefined,
  message?: string
): ChatFailedDiagnosticCopy | null {
  const nodeFailure = message?.match(
    /\[(DSH_NODE_NOT_FOUND|DSH_NODE_UNSUPPORTED|DSH_NODE_EXEC_FAILED)\]/
  )?.[1];
  if (nodeFailure) {
    const titles = {
      DSH_NODE_NOT_FOUND: [
        'deepseekNodeNotFound',
        'DeepSeek Harness needs Node.js on the target machine',
      ],
      DSH_NODE_UNSUPPORTED: [
        'deepseekNodeUnsupported',
        'DeepSeek Harness needs a supported standalone Node.js version',
      ],
      DSH_NODE_EXEC_FAILED: [
        'deepseekNodeExecFailed',
        'DeepSeek Harness could not run Node.js on the target machine',
      ],
    } as const;
    const [key, title] = titles[nodeFailure as keyof typeof titles];
    return {
      titleKey: `sessions.systemNotices.chatFailed.${key}`,
      title,
      installUrl: 'https://nodejs.org/en/download',
      actionKey: 'sessions.systemNotices.chatFailed.deepseekNodeAction',
      action:
        'Install a supported Node.js with npm/npx on the machine running this Agent, add node to PATH, fully restart Lody/CLI, then retry. Supported: 22.23.4+ (22.x), 24.22.1+ (24.x), or 26.12.1+ (26.x). Download: https://nodejs.org/en/download',
    };
  }
  if (code !== 'git_executable_not_found') {
    return null;
  }

  return {
    titleKey: 'sessions.systemNotices.chatFailed.gitExecutableNotFound',
    title: 'Git executable was not found on the target machine',
    actionKey: 'sessions.systemNotices.chatFailed.gitExecutableNotFoundAction',
    action:
      'Install Git for Windows or add git.exe to PATH, fully restart Lody/CLI, verify “git --version” in a new terminal, then try again.',
  };
}

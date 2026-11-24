/** Private mobile copy; shared recovery messages stay owned by the public locales. */
export const mobileRecoveryCopy = {
  en: {
    'mobileRecovery.verifyFile': 'Verify your saved recovery file',
    'mobileRecovery.verifyFileDescription':
      'Select the .lodyrecovery file you just saved in Files. Your backup is created only after this check.',
    'mobileRecovery.selectSavedFile': 'Select saved file…',
    'mobileRecovery.title': 'Recovery vault',
    'mobileRecovery.openFile': 'Open with recovery file…',
    'mobileRecovery.openPasskey': 'Open with passkey…',
    'mobileRecovery.opened': 'Recovery vault opened ({{count}} workspaces).',
    'mobileRecovery.removeFile': 'Remove with recovery file…',
    'mobileRecovery.removePasskey': 'Remove with passkey…',
    'mobileRecovery.refreshNeeded': 'Refresh the passkey list to see the current entries.',
    'mobileRecovery.refreshFailed':
      'List refresh failed. Your completed change is saved; retry refreshing the list.',
    'mobileRecovery.refreshFile': 'Refresh list with recovery file…',
    'mobileRecovery.refreshPasskey': 'Refresh list with passkey…',
    'mobileRecovery.removeFailed':
      'Removal was not confirmed. Keep the recovery file and retry; the passkey may still unlock the vault.',
  },
  zh_CN: {
    'mobileRecovery.verifyFile': '验证已保存的恢复文件',
    'mobileRecovery.verifyFileDescription':
      '请选择刚保存到“文件”的 .lodyrecovery 文件。验证通过后才会创建备份。',
    'mobileRecovery.selectSavedFile': '选择已保存的文件…',
    'mobileRecovery.title': '恢复库',
    'mobileRecovery.openFile': '用恢复文件打开…',
    'mobileRecovery.openPasskey': '用 passkey 打开…',
    'mobileRecovery.opened': '恢复库已打开（{{count}} 个工作区）。',
    'mobileRecovery.removeFile': '用恢复文件移除…',
    'mobileRecovery.removePasskey': '用 passkey 移除…',
    'mobileRecovery.refreshNeeded': '请刷新 passkey 列表以查看当前条目。',
    'mobileRecovery.refreshFailed': '列表刷新失败。已完成的更改已保存，请重试刷新列表。',
    'mobileRecovery.refreshFile': '用恢复文件刷新列表…',
    'mobileRecovery.refreshPasskey': '用 passkey 刷新列表…',
    'mobileRecovery.removeFailed':
      '尚未确认移除成功。请保留恢复文件后重试；该 passkey 可能仍能打开恢复库。',
  },
} as const;

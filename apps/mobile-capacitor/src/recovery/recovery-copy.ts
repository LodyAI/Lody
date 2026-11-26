/** Private mobile copy; shared recovery messages stay owned by the public locales. */
export const mobileRecoveryCopy = {
  en: {
    'mobileRecovery.verifyFile': 'Verify your saved recovery file',
    'mobileRecovery.verifyFileDescription':
      'Select the .lodyrecovery file you just saved in Files. Your backup is created only after this check.',
    'mobileRecovery.selectSavedFile': 'Select saved file…',
    'mobileRecovery.title': 'Recovery backup',
    'mobileRecovery.openFile': 'Open with recovery file…',
    'mobileRecovery.openPasskey': 'Open with passkey…',
    'mobileRecovery.opened': 'Recovery backup unlocked ({{count}} workspaces).',
    'mobileRecovery.removeFile': 'Remove with recovery file…',
    'mobileRecovery.removePasskey': 'Remove with passkey…',
    'mobileRecovery.refreshNeeded': 'Refresh the passkey list to see the current entries.',
    'mobileRecovery.refreshFailed':
      'List refresh failed. Your completed change is saved; retry refreshing the list.',
    'mobileRecovery.refreshFile': 'Refresh list with recovery file…',
    'mobileRecovery.refreshPasskey': 'Refresh list with passkey…',
    'mobileRecovery.removeFailed':
      'Removal was not confirmed. Keep your recovery file and retry; this passkey may still unlock your recovery backup.',
  },
  zh_CN: {
    'mobileRecovery.verifyFile': '验证已保存的恢复文件',
    'mobileRecovery.verifyFileDescription':
      '请选择刚保存到“文件”的 .lodyrecovery 文件。验证通过后才会创建备份。',
    'mobileRecovery.selectSavedFile': '选择已保存的文件…',
    'mobileRecovery.title': '恢复备份',
    'mobileRecovery.openFile': '用恢复文件打开…',
    'mobileRecovery.openPasskey': '用 Passkey 打开…',
    'mobileRecovery.opened': '恢复备份已解锁（{{count}} 个工作区）。',
    'mobileRecovery.removeFile': '用恢复文件移除…',
    'mobileRecovery.removePasskey': '用 Passkey 移除…',
    'mobileRecovery.refreshNeeded': '请刷新 Passkey 列表以查看当前条目。',
    'mobileRecovery.refreshFailed': '列表刷新失败。已完成的更改已保存，请重试刷新列表。',
    'mobileRecovery.refreshFile': '用恢复文件刷新列表…',
    'mobileRecovery.refreshPasskey': '用 Passkey 刷新列表…',
    'mobileRecovery.removeFailed':
      '尚未确认移除成功。请保留恢复文件后重试；此 Passkey 可能仍能解锁恢复备份。',
  },
} as const;

import { clientRecoveryJournal } from '@lody/client-e2ee/recovery';
export const mobileRecoveryJournal = (accountId: string, check: () => void) =>
  clientRecoveryJournal(accountId, check, 'mobile');

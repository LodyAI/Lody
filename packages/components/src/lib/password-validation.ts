import type { TFunction } from 'i18next';
import { PASSWORD_MIN_LENGTH, type PasswordValidationFailure } from '@lody/shared';

export {
  PASSWORD_MIN_LENGTH,
  validateNewPassword,
  type PasswordValidationFailure,
  type PasswordValidationResult,
} from '@lody/shared';

export type PasswordErrorNamespace = 'login' | 'resetPassword';

export function formatPasswordValidationFailure(
  failure: PasswordValidationFailure,
  t: TFunction,
  namespace: PasswordErrorNamespace
): string {
  if (failure.reason === 'too-short') {
    return t(`${namespace}.passwordTooShort`, 'Password must be at least {{count}} characters.', {
      count: PASSWORD_MIN_LENGTH,
    });
  }
  return t(`${namespace}.passwordComplexity`, 'Password must include both letters and numbers.');
}

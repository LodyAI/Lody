import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { validateNewPassword } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Label } from '@/ui/label';
import { PasswordInput } from '@/ui/password-input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { formatPasswordValidationFailure } from '@/lib/password-validation';

interface ChangePasswordButtonProps {
  /** Whether the account already has an email/password credential. */
  hasPassword: boolean;
  /**
   * Change the existing password. On success the caller signs the user out
   * (changing the password revokes other sessions), so this dialog just closes.
   */
  onChangePassword: (args: { currentPassword: string; newPassword: string }) => Promise<void>;
  /**
   * Verify the current password server-side before advancing to the new-password
   * step. Resolves true when correct. If omitted, step one advances without a
   * server check (the change is still verified at final submit).
   */
  onVerifyCurrentPassword?: (password: string) => Promise<boolean>;
  /** Send a "set up password" email for accounts that have no password yet. */
  onSetupPassword: () => Promise<void>;
  disabled?: boolean;
}

const slideVariants = {
  enter: (direction: number) => ({ x: direction > 0 ? 28 : -28, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: direction > 0 ? -28 : 28, opacity: 0 }),
};

export function ChangePasswordButton({
  hasPassword,
  onChangePassword,
  onVerifyCurrentPassword,
  onSetupPassword,
  disabled,
}: ChangePasswordButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Two-step change flow: 0 = verify current password, 1 = enter new password.
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const reset = () => {
    setStep(0);
    setDirection(1);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (isSubmitting || isVerifying) return;
    setOpen(next);
    if (!next) reset();
  };

  const handleSetup = async () => {
    setIsSubmitting(true);
    try {
      await onSetupPassword();
      toast.success(t('settings.profile.password.setupSent'));
      setOpen(false);
    } catch (err) {
      toast.error(t('settings.profile.password.setupFailed'), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const goToNewStep = async () => {
    if (isVerifying) return;
    if (!currentPassword) {
      setError(t('settings.profile.password.currentRequired'));
      return;
    }
    if (onVerifyCurrentPassword) {
      setIsVerifying(true);
      setError(null);
      try {
        const valid = await onVerifyCurrentPassword(currentPassword);
        if (!valid) {
          setError(t('settings.profile.password.currentIncorrect'));
          return;
        }
      } catch {
        setError(t('settings.profile.password.verifyFailed'));
        return;
      } finally {
        setIsVerifying(false);
      }
    }
    setError(null);
    setDirection(1);
    setStep(1);
  };

  const goBack = () => {
    if (isSubmitting) return;
    setError(null);
    setDirection(-1);
    setStep(0);
  };

  const handleSubmit = async () => {
    const validation = validateNewPassword(newPassword);
    if (validation.ok === false) {
      setError(formatPasswordValidationFailure(validation, t, 'resetPassword'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('settings.profile.password.mismatch'));
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      await onChangePassword({ currentPassword, newPassword });
      // Success: the account is signing out; just close the dialog.
      setOpen(false);
    } catch {
      // The new password passed client validation, so the most likely failure is
      // an incorrect current password. Slide back to step 1 and surface it there.
      setError(t('settings.profile.password.currentIncorrect'));
      setDirection(-1);
      setStep(0);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <Button variant="ghost" size="small" disabled={disabled} onClick={() => setOpen(true)}>
        {hasPassword
          ? t('settings.profile.password.changeButton')
          : t('settings.profile.password.setupButton')}
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          {hasPassword ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('settings.profile.password.dialogTitle')}</DialogTitle>
                <DialogDescription>
                  {step === 0
                    ? t('settings.profile.password.currentStepHint')
                    : t('settings.profile.password.newStepHint')}
                </DialogDescription>
              </DialogHeader>
              <div className="relative overflow-hidden py-2">
                <AnimatePresence mode="wait" custom={direction} initial={false}>
                  {step === 0 ? (
                    <motion.div
                      key="step-current"
                      custom={direction}
                      variants={slideVariants}
                      initial="enter"
                      animate="center"
                      exit="exit"
                      transition={{ duration: 0.2, ease: 'easeInOut' }}
                      className="space-y-1.5"
                    >
                      <Label htmlFor="current-password">
                        {t('settings.profile.password.currentLabel')}
                      </Label>
                      <PasswordInput
                        id="current-password"
                        autoComplete="current-password"
                        value={currentPassword}
                        onChange={(event) => setCurrentPassword(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void goToNewStep();
                          }
                        }}
                        autoFocus
                      />
                      {error ? (
                        <p role="alert" className="text-[11px] text-destructive">
                          {error}
                        </p>
                      ) : null}
                    </motion.div>
                  ) : (
                    <motion.div
                      key="step-new"
                      custom={direction}
                      variants={slideVariants}
                      initial="enter"
                      animate="center"
                      exit="exit"
                      transition={{ duration: 0.2, ease: 'easeInOut' }}
                      className="space-y-3"
                    >
                      <div className="space-y-1.5">
                        <Label htmlFor="new-password">
                          {t('settings.profile.password.newLabel')}
                        </Label>
                        <PasswordInput
                          id="new-password"
                          autoComplete="new-password"
                          value={newPassword}
                          onChange={(event) => setNewPassword(event.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="confirm-password">
                          {t('settings.profile.password.confirmLabel')}
                        </Label>
                        <PasswordInput
                          id="confirm-password"
                          autoComplete="new-password"
                          value={confirmPassword}
                          onChange={(event) => setConfirmPassword(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void handleSubmit();
                            }
                          }}
                        />
                      </div>
                      {error ? (
                        <p role="alert" className="text-[11px] text-destructive">
                          {error}
                        </p>
                      ) : null}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <DialogFooter>
                {step === 0 ? (
                  <>
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => handleOpenChange(false)}
                      disabled={isVerifying}
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      size="small"
                      onClick={() => {
                        void goToNewStep();
                      }}
                      disabled={!currentPassword || isVerifying}
                    >
                      {isVerifying ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                      {t('settings.profile.password.continueButton')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={goBack}
                      disabled={isSubmitting}
                    >
                      <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                      {t('common.back')}
                    </Button>
                    <Button
                      size="small"
                      onClick={() => {
                        void handleSubmit();
                      }}
                      disabled={isSubmitting || !newPassword || !confirmPassword}
                    >
                      {isSubmitting ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      {t('settings.profile.password.submitButton')}
                    </Button>
                  </>
                )}
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t('settings.profile.password.setupDialogTitle')}</DialogTitle>
                <DialogDescription>
                  {t('settings.profile.password.setupDialogDescription')}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => handleOpenChange(false)}
                  disabled={isSubmitting}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    void handleSetup();
                  }}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  {t('settings.profile.password.setupSubmitButton')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

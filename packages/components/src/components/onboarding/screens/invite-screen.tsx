import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Loader2, Mail, Plus, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { cn } from '@/lib/utils';
import { useOrganization } from '@/hooks/useOrganization';
import { useAuthClient } from '../../../providers/convex-provider';
import { OnboardingShell, OnboardingBackButton } from '../onboarding-shell';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InviteEntry {
  /** Stable client-side id for animations + dedupe. */
  id: string;
  email: string;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  errorMessage?: string;
}

export interface InviteScreenViewProps {
  email: string;
  onEmailChange: (next: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  invites: InviteEntry[];
  /** True while at least one row is in `sending` state. */
  sending: boolean;
  inputError: string | null;
  onSkip: () => void;
  onBack: () => void;
  onSendAndContinue: () => void;
}

export function InviteScreenView({
  email,
  onEmailChange,
  onAdd,
  onRemove,
  invites,
  sending,
  inputError,
  onSkip,
  onBack,
  onSendAndContinue,
}: InviteScreenViewProps) {
  const { t } = useTranslation();
  const pendingCount = invites.filter((i) => i.status === 'pending').length;
  const hasAnything = invites.length > 0;

  return (
    <OnboardingShell
      stepKey="invite"
      title={t('onboarding.invite.title', 'Invite your team')}
      description={t(
        'onboarding.invite.description',
        'Optional — collaborators can also be invited later from settings.'
      )}
      secondaryAction={<OnboardingBackButton onClick={onBack} disabled={sending} />}
      primaryAction={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="lg" onClick={onSkip} disabled={sending}>
            {t('onboarding.invite.skip', 'Skip')}
          </Button>
          <Button
            size="lg"
            onClick={onSendAndContinue}
            className="gap-2"
            disabled={!hasAnything || sending || pendingCount === 0}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {pendingCount > 0
              ? t('onboarding.invite.sendCount', 'Send {{count}} & continue', {
                  count: pendingCount,
                })
              : t('onboarding.invite.send', 'Send & continue')}
            {!sending ? <ArrowRight className="h-4 w-4" /> : null}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <form
          className="flex items-stretch gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onAdd();
          }}
        >
          <div className="relative flex-1">
            <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="email"
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              placeholder={t('onboarding.invite.placeholder', 'name@company.com')}
              className={cn('pl-9', inputError ? 'border-destructive' : '')}
              disabled={sending}
            />
          </div>
          <Button type="submit" variant="outline" disabled={!email.trim() || sending}>
            <Plus className="h-4 w-4" />
            {t('onboarding.invite.add', 'Add')}
          </Button>
        </form>
        {inputError ? <p className="text-xs text-destructive">{inputError}</p> : null}

        {hasAnything ? (
          // Cap at ~5 rows; long lists scroll inside the card.
          <ul className="scrollbar-pro -mx-1 max-h-[260px] divide-y divide-border/50 overflow-y-auto overscroll-contain rounded-xl border border-border/60 bg-card/40 px-1">
            <AnimatePresence initial={false}>
              {invites.map((invite) => (
                <motion.li
                  key={invite.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.2 }}
                  className="flex items-center gap-3 px-3 py-2.5"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">{invite.email}</div>
                    <InviteStatusLine status={invite.status} errorMessage={invite.errorMessage} />
                  </div>
                  {invite.status === 'sending' ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      aria-label={t('common.remove', 'Remove')}
                      onClick={() => onRemove(invite.id)}
                      disabled={sending}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-4 py-6 text-center text-xs text-muted-foreground">
            {t(
              'onboarding.invite.emptyHint',
              'Add a teammate by email — or skip and invite them later.'
            )}
          </div>
        )}
      </div>
    </OnboardingShell>
  );
}

function InviteStatusLine({
  status,
  errorMessage,
}: {
  status: InviteEntry['status'];
  errorMessage?: string;
}) {
  const { t } = useTranslation();
  if (status === 'sent') {
    return <div className="text-xs text-primary">{t('onboarding.invite.statusSent', 'Sent')}</div>;
  }
  if (status === 'failed') {
    return (
      <div className="truncate text-xs text-destructive">
        {errorMessage ?? t('onboarding.invite.statusFailed', 'Failed to send')}
      </div>
    );
  }
  if (status === 'sending') {
    return (
      <div className="text-xs text-muted-foreground">
        {t('onboarding.invite.statusSending', 'Sending…')}
      </div>
    );
  }
  return (
    <div className="text-xs text-muted-foreground">
      {t('onboarding.invite.statusPending', 'Will be sent')}
    </div>
  );
}

interface InviteScreenProps {
  onBack: () => void;
  onSkip: () => void;
  onCompleted: () => void;
}

/**
 * Container that owns invite list state + dispatches `inviteMember` calls.
 * Each row tracks its own send status so the user can retry individual rows
 * without re-sending succeeded ones. Advances to `onCompleted` after all
 * rows have settled (sent or failed) — the user can also Skip at any time.
 */
export function InviteScreen({ onBack, onSkip, onCompleted }: InviteScreenProps) {
  const { t } = useTranslation();
  const { activeOrganization } = useOrganization();
  const authClient = useAuthClient();
  const [email, setEmail] = useState('');
  const [invites, setInvites] = useState<InviteEntry[]>([]);
  const [sending, setSending] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);

  const handleAdd = useCallback(() => {
    const candidate = email.trim();
    if (!candidate) {
      setInputError(t('onboarding.invite.errorEmpty', 'Enter an email address'));
      return;
    }
    if (!EMAIL_RE.test(candidate)) {
      setInputError(t('onboarding.invite.errorInvalid', 'Enter a valid email address'));
      return;
    }
    if (invites.some((i) => i.email.toLowerCase() === candidate.toLowerCase())) {
      setInputError(t('onboarding.invite.errorDuplicate', 'Already on the list'));
      return;
    }
    setInputError(null);
    setInvites((prev) => [
      ...prev,
      {
        id: `invite-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        email: candidate,
        status: 'pending',
      },
    ]);
    setEmail('');
  }, [email, invites, t]);

  const handleRemove = useCallback((id: string) => {
    setInvites((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const handleSendAndContinue = useCallback(() => {
    if (!activeOrganization) {
      console.error('[onboarding] Cannot send invitations without an active workspace');
      toast.error(t('onboarding.invite.errorNoWorkspace', 'No workspace to invite to'));
      return;
    }
    const pending = invites.filter((i) => i.status === 'pending');
    if (pending.length === 0) {
      onCompleted();
      return;
    }
    setSending(true);
    void (async () => {
      // Mark all pending as sending up-front so the user sees progress.
      setInvites((prev) =>
        prev.map((entry) => (entry.status === 'pending' ? { ...entry, status: 'sending' } : entry))
      );
      // Run sequentially — better-auth's organization plugin tends to surface
      // clearer per-call errors than a single batched call would, and we want
      // each row's status to reflect its own outcome.
      for (const entry of pending) {
        try {
          const result = await authClient.organization.inviteMember({
            organizationId: activeOrganization.id,
            email: entry.email,
            role: 'member',
          });
          const failed = result?.error;
          if (failed) {
            const message = failed.message || String(failed);
            console.error(`[onboarding] Failed to invite ${entry.email}:`, failed);
            setInvites((prev) =>
              prev.map((e) =>
                e.id === entry.id ? { ...e, status: 'failed', errorMessage: message } : e
              )
            );
          } else {
            setInvites((prev) =>
              prev.map((e) =>
                e.id === entry.id ? { ...e, status: 'sent', errorMessage: undefined } : e
              )
            );
          }
        } catch (error) {
          console.error(`[onboarding] Failed to invite ${entry.email}:`, error);
          const message = error instanceof Error ? error.message : String(error);
          setInvites((prev) =>
            prev.map((e) =>
              e.id === entry.id ? { ...e, status: 'failed', errorMessage: message } : e
            )
          );
        }
      }
      setSending(false);
      // Advance once anything succeeded; if everything failed, leave the user
      // on the screen so they can retry without losing their list.
      setInvites((current) => {
        const anySent = current.some((e) => e.status === 'sent');
        if (anySent) onCompleted();
        return current;
      });
    })();
  }, [activeOrganization, authClient, invites, onCompleted, t]);

  return (
    <InviteScreenView
      email={email}
      onEmailChange={(next) => {
        setEmail(next);
        if (inputError !== null) setInputError(null);
      }}
      onAdd={handleAdd}
      onRemove={handleRemove}
      invites={invites}
      sending={sending}
      inputError={inputError}
      onSkip={onSkip}
      onBack={onBack}
      onSendAndContinue={handleSendAndContinue}
    />
  );
}

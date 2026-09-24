import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import * as stylex from '@stylexjs/stylex';
import { ArrowRight, Mail, Plus, Send, X } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { toast } from '@/lib/toast';
import { withClassName } from '@/lib/stylex';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { useOrganization } from '@/hooks/useOrganization';
import { useAuthClient } from '../../../providers/convex-provider';
import { OnboardingShell, OnboardingBackButton } from '../onboarding-shell';
import { onboardingSurface as surface } from './surface';

const styles = stylex.create({
  form: { display: 'flex', alignItems: 'center', gap: space[2] },
  emailField: { flexGrow: 1, minWidth: 0 },
  email: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.label,
  },
  sending: { display: 'flex', flexShrink: 0, color: colors.secondaryLabel },
  statusSent: { color: colors.success },
  statusFailed: { color: colors.destructive },
  empty: {
    alignItems: 'center',
    paddingInline: space[4],
    paddingBlock: space[6],
    textAlign: 'center',
  },
});

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
        <div {...stylex.props(surface.actions)}>
          <Button variant="ghost" size="large" onClick={onSkip} disabled={sending}>
            {t('onboarding.invite.skip', 'Skip')}
          </Button>
          <Button
            size="large"
            onClick={onSendAndContinue}
            disabled={!hasAnything || sending || pendingCount === 0}
          >
            {sending ? <Spinner size="small" /> : <Send {...stylex.props(surface.icon16)} />}
            {pendingCount > 0
              ? t('onboarding.invite.sendCount', 'Send {{count}} & continue', {
                  count: pendingCount,
                })
              : t('onboarding.invite.send', 'Send & continue')}
            {!sending ? <ArrowRight {...stylex.props(surface.icon16)} /> : null}
          </Button>
        </div>
      }
    >
      <div {...stylex.props(surface.stack)}>
        <form
          {...stylex.props(styles.form)}
          onSubmit={(event) => {
            event.preventDefault();
            onAdd();
          }}
        >
          <div {...stylex.props(styles.emailField)}>
            <Input
              type="email"
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              placeholder={t('onboarding.invite.placeholder', 'name@company.com')}
              leading={<Mail aria-hidden {...stylex.props(surface.icon16)} />}
              aria-invalid={inputError ? true : undefined}
              disabled={sending}
            />
          </div>
          <Button type="submit" variant="secondary" disabled={!email.trim() || sending}>
            <Plus {...stylex.props(surface.icon16)} />
            {t('onboarding.invite.add', 'Add')}
          </Button>
        </form>
        {inputError ? <UiField.Error render={<p />}>{inputError}</UiField.Error> : null}

        {hasAnything ? (
          // Cap at ~5 rows; long lists scroll inside the card.
          <div {...stylex.props(surface.card)}>
            <ul {...withClassName(stylex.props(surface.list), 'scrollbar-pro')}>
              <AnimatePresence initial={false}>
                {invites.map((invite, index) => (
                  <motion.li
                    key={invite.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.2 }}
                    {...stylex.props(surface.row, index > 0 && surface.ruled)}
                  >
                    <div {...stylex.props(surface.glyphBox, surface.glyphBoxSmall)}>
                      <Mail {...stylex.props(surface.icon16)} />
                    </div>
                    <div {...stylex.props(surface.textColumn)}>
                      <div {...stylex.props(styles.email)}>{invite.email}</div>
                      <InviteStatusLine status={invite.status} errorMessage={invite.errorMessage} />
                    </div>
                    {invite.status === 'sending' ? (
                      <span {...stylex.props(styles.sending)}>
                        <Spinner size="small" />
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        aria-label={t('common.remove', 'Remove')}
                        size="small"
                        icon
                        tone="destructive"
                        onClick={() => onRemove(invite.id)}
                        disabled={sending}
                      >
                        <X {...stylex.props(surface.icon16)} />
                      </Button>
                    )}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </div>
        ) : (
          <div {...stylex.props(surface.message, surface.messageNeutral, styles.empty)}>
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
    return (
      <div {...stylex.props(surface.detail, styles.statusSent)}>
        {t('onboarding.invite.statusSent', 'Sent')}
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div {...stylex.props(surface.detail, styles.statusFailed)}>
        {errorMessage ?? t('onboarding.invite.statusFailed', 'Failed to send')}
      </div>
    );
  }
  if (status === 'sending') {
    return (
      <div {...stylex.props(surface.detail)}>
        {t('onboarding.invite.statusSending', 'Sending…')}
      </div>
    );
  }
  return (
    <div {...stylex.props(surface.detail)}>
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

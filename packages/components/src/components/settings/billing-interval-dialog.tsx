import type { CloudApi } from '@lody/cloud-api';
import type { FunctionReturnType } from 'convex/server';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { Dialog } from '@/ui/dialog';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { settingsSurface } from './surface';

export type IntervalPreview = FunctionReturnType<
  CloudApi['billing']['previewSubscriptionIntervalChange']
>;
export type IntervalResult = FunctionReturnType<CloudApi['billing']['setSubscriptionInterval']>;
const styles = stylex.create({
  stack: { display: 'flex', flexDirection: 'column', gap: space[2] },
  line: { display: 'flex', justifyContent: 'space-between', gap: space[4], fontSize: '13px' },
  amount: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  note: { margin: 0, fontSize: '13px', lineHeight: 1.5, color: colors.secondaryLabel },
  error: { color: colors.destructive },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
});
const errorKeys: Record<string, string> = {
  payment_status_unavailable: 'billing.switchPaymentRefreshError',
  interval_preview_required: 'billing.switchQuoteChanged',
  billing_timeline_in_progress: 'billing.switchProcessing',
  billing_transfer_in_progress: 'billing.switchProcessing',
  managed_subscription_interval: 'billing.switchManaged',
  no_active_subscription: 'billing.switchNoSubscription',
  billing_payment_required: 'billing.switchPaymentRequired',
  billing_payment_method_required: 'billing.switchPaymentMethodRequired',
  billing_settlement_history_required: 'billing.switchSettlementHistoryRequired',
  billing_seat_settlement_required: 'billing.switchSeatSettlementRequired',
};

export function BillingIntervalDialog({
  open,
  onOpenChange,
  interval,
  preview,
  pending,
  result,
  errorCode,
  onConfirm,
  onRetry,
  onPaymentMethod,
  onViewInvoices,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  interval: 'month' | 'year';
  preview?: IntervalPreview;
  pending: boolean;
  result?: IntervalResult | null;
  errorCode?: string | null;
  onConfirm: () => void;
  onRetry: () => void;
  onPaymentMethod: () => void;
  onViewInvoices: () => void;
}) {
  const { t, i18n } = useTranslation();
  const money = (value: number, currency = preview?.currency ?? 'usd') =>
    new Intl.NumberFormat(i18n.language.replace('_', '-'), { style: 'currency', currency }).format(
      value / 100
    );
  const date = (value: number) =>
    new Intl.DateTimeFormat(i18n.language.replace('_', '-'), { dateStyle: 'medium' }).format(value);
  const payment = result?.payment;
  const outstanding = payment?.outstandingInvoices ?? [];
  const paymentUrl =
    payment?.invoiceUrl ?? outstanding.find((invoice) => invoice.invoiceUrl)?.invoiceUrl;
  const terminalError =
    errorCode === 'managed_subscription_interval' || errorCode === 'no_active_subscription';
  const paymentRequired =
    payment?.status === 'required' || errorCode === 'billing_payment_required';
  const methodRequired = !result && errorCode === 'billing_payment_method_required';
  const needsRecovery = !result && Boolean(errorCode || preview === null);
  const checking = payment?.status === 'checking';
  const confirmDisabled = pending || !preview || Boolean(errorCode);

  const rows: Array<[string, number]> = [];
  if (preview) {
    rows.push([
      t(interval === 'year' ? 'billing.switchLineSeatsYearly' : 'billing.switchLineSeatsMonthly', {
        count: preview.quantity,
        price: money(preview.unitAmount),
      }),
      preview.subtotalAmount,
    ]);
    if (preview.promoDiscountAmount)
      rows.push([t('billing.upcomingDiscount'), preview.promoDiscountAmount]);
    if (preview.accruedSeatAmount)
      rows.push([t('billing.switchAccruedSeats'), preview.accruedSeatAmount]);
    if (preview.creditAmount) rows.push([t('billing.switchLineCredit'), preview.creditAmount]);
    if (preview.deferredToBalanceAmount)
      rows.push([t('billing.switchLineDeferredCredit'), preview.deferredToBalanceAmount]);
    if (preview.taxAmount) rows.push([t('billing.switchTax'), preview.taxAmount]);
    if (preview.balanceAmount) rows.push([t('billing.switchBalance'), preview.balanceAmount]);
    if (preview.adjustmentAmount)
      rows.push([t('billing.switchAdjustments'), preview.adjustmentAmount]);
    rows.push([t('billing.switchLineDueNow'), preview.amountDueNow]);
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!pending) onOpenChange(value);
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>
            {t(result ? 'billing.switchCompletedTitle' : 'billing.switchIntervalDialogTitle')}
          </Dialog.Title>
          <Dialog.Description>
            {result
              ? t(
                  result.billingInterval === 'month'
                    ? 'billing.switchCompletedMonth'
                    : 'billing.switchCompletedYear'
                )
              : t('billing.switchReviewDescription')}
          </Dialog.Description>
        </Dialog.Header>
        <div {...stylex.props(styles.stack)}>
          {result ? (
            <>
              <p role="status" {...stylex.props(styles.note)}>
                {payment?.status === 'required'
                  ? payment.amountRemaining === undefined
                    ? t('billing.switchOutstandingUncombined')
                    : t('billing.switchOutstanding', {
                        amount: money(payment.amountRemaining, payment.currency),
                      })
                  : t(
                      payment?.status === 'checking'
                        ? 'billing.switchPaymentChecking'
                        : 'billing.switchPaymentSettled'
                    )}
              </p>
              {errorCode && (
                <p role="alert" {...stylex.props(styles.note, styles.error)}>
                  {t(errorKeys[errorCode] ?? 'billing.switchPaymentRefreshError')}
                </p>
              )}
              {paymentRequired && !paymentUrl && (
                <p role="status" {...stylex.props(styles.note)}>
                  {t('billing.switchPaymentLinkUnavailable')}
                </p>
              )}
              {(outstanding.length > 1 || payment?.hasMore) && (
                <div {...stylex.props(styles.stack)}>
                  <p {...stylex.props(styles.note)}>
                    {t(
                      payment?.hasMore
                        ? 'billing.switchMoreInvoices'
                        : 'billing.switchMultipleInvoices',
                      { count: outstanding.length }
                    )}
                  </p>
                  {outstanding.map((invoice, index) => (
                    <div key={invoice.id} {...stylex.props(styles.line)}>
                      <span>{t('billing.switchInvoiceNumber', { number: index + 1 })}</span>
                      {invoice.invoiceUrl ? (
                        <a href={invoice.invoiceUrl} target="_blank" rel="noopener noreferrer">
                          {money(invoice.amountRemaining, invoice.currency)}
                        </a>
                      ) : (
                        <span>{money(invoice.amountRemaining, invoice.currency)}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {payment?.status !== 'settled' && (
                <div {...stylex.props(styles.actions)}>
                  <Button variant="ghost" size="small" disabled={pending} onClick={onViewInvoices}>
                    {t('billing.switchViewInvoices')}
                  </Button>
                  {paymentRequired && (
                    <>
                      <Button
                        variant="ghost"
                        size="small"
                        disabled={pending}
                        onClick={onPaymentMethod}
                      >
                        {t('billing.switchUpdatePaymentMethod')}
                      </Button>
                      <Button variant="ghost" size="small" disabled={pending} onClick={onRetry}>
                        {t('billing.switchCheckPayment')}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              {preview === undefined ? (
                <p {...stylex.props(styles.note)}>
                  <Spinner size="small" /> {t('billing.historyLoading')}
                </p>
              ) : preview === null && !errorCode ? (
                <p {...stylex.props(styles.note, styles.error)}>
                  {t('billing.switchPreviewError')}
                </p>
              ) : !preview ? null : preview.continuation ? (
                <p role="status" {...stylex.props(styles.note)}>
                  {t('billing.switchResumeDescription')}
                </p>
              ) : (
                <div {...stylex.props(settingsSurface.formBlock, styles.stack)}>
                  {rows.map(([label, amount]) => (
                    <div key={label} {...stylex.props(styles.line)}>
                      <span>{label}</span>
                      <span {...stylex.props(styles.amount)}>{money(Number(amount))}</span>
                    </div>
                  ))}
                  {preview.nextRenewalAt && (
                    <p {...stylex.props(styles.note)}>
                      {t('billing.switchRenewalDate', { date: date(preview.nextRenewalAt) })}
                    </p>
                  )}
                  {preview.remainingCredit > 0 && (
                    <p {...stylex.props(styles.note)}>
                      {t('billing.switchCreditGenericNote', {
                        amount: money(preview.remainingCredit),
                      })}
                    </p>
                  )}
                </div>
              )}
              {errorCode && (
                <p role="alert" {...stylex.props(styles.note, styles.error)}>
                  {t(errorKeys[errorCode] ?? 'billing.switchRetryError')}
                </p>
              )}
              {needsRecovery && !terminalError && (
                <div {...stylex.props(styles.actions)}>
                  <Button variant="ghost" size="small" disabled={pending} onClick={onViewInvoices}>
                    {t('billing.switchViewInvoices')}
                  </Button>
                  {(paymentRequired || methodRequired) && (
                    <Button variant="ghost" size="small" disabled={pending} onClick={onRetry}>
                      {t('billing.switchRecheck')}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <Dialog.Footer>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            {t(result ? 'common.close' : 'common.cancel')}
          </Button>
          {!result && needsRecovery && !terminalError && (
            <Button variant="secondary" disabled>
              {t('billing.switchIntervalConfirm')}
            </Button>
          )}
          {paymentRequired ? (
            paymentUrl ? (
              <Button
                disabled={pending}
                nativeButton={false}
                render={<a href={paymentUrl} target="_blank" rel="noopener noreferrer" />}
              >
                {t(
                  outstanding.length > 1
                    ? 'billing.switchPayNextInvoice'
                    : 'billing.switchPayInvoice'
                )}
              </Button>
            ) : (
              <Button disabled={pending} onClick={onViewInvoices}>
                {t('billing.switchViewOutstanding')}
              </Button>
            )
          ) : methodRequired ? (
            <Button disabled={pending} onClick={onPaymentMethod}>
              {t('billing.switchUpdatePaymentMethod')}
            </Button>
          ) : checking ? (
            <Button disabled={pending} onClick={onRetry}>
              {pending && <Spinner size="small" />}
              {t('billing.switchCheckPayment')}
            </Button>
          ) : needsRecovery && !terminalError ? (
            <Button disabled={pending} onClick={onRetry}>
              {t('billing.switchRecalculate')}
            </Button>
          ) : !result && !terminalError ? (
            <Button
              disabled={confirmDisabled}
              onClick={() => {
                if (!confirmDisabled) onConfirm();
              }}
            >
              {pending && <Spinner size="small" />}
              {t(preview?.continuation ? 'billing.switchResume' : 'billing.switchIntervalConfirm')}
            </Button>
          ) : null}
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

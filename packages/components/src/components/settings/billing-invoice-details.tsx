import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import type { BillingInvoiceDetail } from '@lody/cloud-api';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { Dialog } from '@/ui/dialog';
import {
  formatDate,
  formatMoney,
  invoiceReasonKey,
  invoiceStatusKey,
  type BillingInvoice,
} from './billing-setting-pure';

const styles = stylex.create({
  content: { display: 'flex', flexDirection: 'column', gap: space[4], minWidth: 0 },
  row: { display: 'flex', justifyContent: 'space-between', gap: space[4], alignItems: 'baseline' },
  list: {
    margin: 0,
    padding: 0,
    listStyleType: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
  },
  muted: { color: colors.secondaryLabel, margin: 0 },
  amount: { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  error: { color: colors.destructive, margin: 0 },
  link: { color: colors.accent },
});

export interface BillingInvoiceDetailsProps {
  invoice: BillingInvoice;
  detail: BillingInvoiceDetail | null;
  loading: boolean;
  error: boolean;
  cancelPending: boolean;
  cancelError: boolean;
  onClose: () => void;
  onRetry: () => void;
  onCancel: () => void;
}

export function BillingInvoiceDetails(props: BillingInvoiceDetailsProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const invoice = props.detail?.invoice ?? props.invoice;
  const money = (amount: number | null | undefined) =>
    amount == null ? t('billing.invoiceAmountUnavailable') : formatMoney(amount, invoice.currency);
  const canCancel = props.detail?.canCancel === true && !props.loading && !props.error;
  const canRetryCancellation =
    props.detail?.cancellationPending === true && !props.loading && !props.error;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !props.cancelPending) props.onClose();
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>{t('billing.invoiceDetails')}</Dialog.Title>
          <Dialog.Description>
            {t(invoiceReasonKey(invoice))} · {invoice.number ?? invoice.id}
          </Dialog.Description>
        </Dialog.Header>
        <div {...stylex.props(styles.content)} aria-busy={props.loading || props.cancelPending}>
          <div {...stylex.props(styles.row)}>
            <span>
              {invoice.status === 'draft'
                ? t('billing.invoiceScheduledCollection', { date: formatDate(invoice.createdAt) })
                : formatDate(invoice.createdAt)}
            </span>
            <span>{t(invoiceStatusKey(invoice.status))}</span>
          </div>
          {invoice.seatChange ? (
            <p {...stylex.props(styles.muted)}>
              {t('billing.invoiceSeatChange', invoice.seatChange)}
            </p>
          ) : null}
          {props.loading ? <Spinner size="small" /> : null}
          {props.error ? (
            <div role="alert">
              <p>{t('billing.invoiceDetailsError')}</p>
              <Button variant="secondary" onClick={props.onRetry}>
                {t('billing.historyRetry')}
              </Button>
            </div>
          ) : null}
          {props.detail && !props.loading && !props.error ? (
            <>
              <ul {...stylex.props(styles.list)}>
                {props.detail.lines.map((line, index) => (
                  <li key={line.id || index}>
                    <div {...stylex.props(styles.row)}>
                      <span>{line.description || t('billing.invoiceLineItem')}</span>
                      <span {...stylex.props(styles.amount)}>{money(line.amount)}</span>
                    </div>
                    {line.periodStart != null && line.periodEnd != null ? (
                      <p {...stylex.props(styles.muted)}>
                        {formatDate(line.periodStart)} – {formatDate(line.periodEnd)}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div>
                <div {...stylex.props(styles.row)}>
                  <span>{t('billing.invoiceTotal')}</span>
                  <span>{money(invoice.total)}</span>
                </div>
                <div {...stylex.props(styles.row)}>
                  <span>{t('billing.invoicePaid')}</span>
                  <span>{money(invoice.amountPaid)}</span>
                </div>
                <div {...stylex.props(styles.row)}>
                  <span>{t('billing.invoiceRemaining')}</span>
                  <span>{money(invoice.amountRemaining)}</span>
                </div>
              </div>
              {invoice.status === 'open' && !canCancel ? (
                <p {...stylex.props(styles.muted)}>{t('billing.invoiceCannotCancel')}</p>
              ) : null}
            </>
          ) : null}
          {confirming && canCancel ? <p>{t('billing.invoiceCancelConfirm')}</p> : null}
          {props.cancelError ? (
            <p role="alert" {...stylex.props(styles.error)}>
              {t('billing.invoiceCancelError')}
            </p>
          ) : null}
        </div>
        <Dialog.Footer>
          <Button variant="secondary" disabled={props.cancelPending} onClick={props.onClose}>
            {t('common.close')}
          </Button>
          {invoice.hostedInvoiceUrl?.startsWith('https://') ? (
            <a
              href={invoice.hostedInvoiceUrl}
              target="_blank"
              rel="noopener noreferrer"
              {...stylex.props(styles.link)}
            >
              {t(invoice.status === 'open' ? 'billing.invoicePay' : 'billing.invoiceReceipt')}
            </a>
          ) : null}
          {canRetryCancellation ? (
            <Button variant="secondary" disabled={props.cancelPending} onClick={props.onCancel}>
              {t('billing.invoiceRetryCancellation')}
            </Button>
          ) : canCancel ? (
            <Button
              variant="destructive"
              disabled={props.cancelPending}
              onClick={() => (confirming ? props.onCancel() : setConfirming(true))}
            >
              {t(
                props.cancelPending
                  ? 'billing.invoiceCanceling'
                  : confirming
                    ? 'billing.invoiceConfirmCancel'
                    : 'billing.invoiceCancel'
              )}
            </Button>
          ) : null}
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

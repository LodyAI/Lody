import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import type { BillingInvoiceDetail } from '@lody/cloud-api';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Dialog } from '@/ui/dialog';
import {
  formatDate,
  formatInvoiceAmount,
  invoiceReasonKey,
  invoiceStatusKey,
  type BillingInvoice,
} from './billing-setting-pure';

/** The receipt: one line per charge, the total under a rule. */
const styles = stylex.create({
  body: { display: 'flex', flexDirection: 'column', gap: space[3], minWidth: 0 },
  lines: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    margin: 0,
    padding: 0,
    listStyleType: 'none',
  },
  line: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space[4],
  },
  total: {
    paddingTop: space[3],
    borderTopWidth: '0.5px',
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    fontWeight: 500,
  },
  amount: { flexShrink: 0, fontVariantNumeric: 'tabular-nums', color: colors.label },
  note: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  error: { color: colors.destructive },
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
    formatInvoiceAmount(amount, invoice.currency);
  const ready = props.detail !== null && !props.loading && !props.error;
  const canCancel = ready && props.detail?.canCancel === true;
  const canRetryCancellation = ready && props.detail?.cancellationPending === true;
  const due = invoice.status === 'open' ? invoice.amountRemaining : null;
  const url = invoice.hostedInvoiceUrl?.startsWith('https://') ? invoice.hostedInvoiceUrl : null;
  const summary = [
    formatDate(invoice.createdAt),
    invoice.seatChange ? t('billing.invoiceSeatChange', invoice.seatChange) : null,
    t(invoiceStatusKey(invoice.status)),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !props.cancelPending) props.onClose();
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>{t(invoiceReasonKey(invoice))}</Dialog.Title>
          <Dialog.Description>{summary}</Dialog.Description>
        </Dialog.Header>
        <div {...stylex.props(styles.body)} aria-busy={props.loading || props.cancelPending}>
          {props.loading ? <Spinner size="small" /> : null}
          {props.error ? (
            <div role="alert" {...stylex.props(styles.line)}>
              <p {...stylex.props(styles.note)}>{t('billing.invoiceDetailsError')}</p>
              <Button variant="secondary" size="small" onClick={props.onRetry}>
                {t('billing.historyRetry')}
              </Button>
            </div>
          ) : null}
          {ready && props.detail ? (
            <ul {...stylex.props(styles.lines)}>
              {props.detail.lines.map((line, index) => (
                <li key={line.id || index}>
                  <div {...stylex.props(styles.line)}>
                    <span>{line.description || t('billing.invoiceLineItem')}</span>
                    <span {...stylex.props(styles.amount)}>{money(line.amount)}</span>
                  </div>
                  {line.periodStart != null && line.periodEnd != null ? (
                    <p {...stylex.props(styles.note)}>
                      {formatDate(line.periodStart)} – {formatDate(line.periodEnd)}
                    </p>
                  ) : null}
                </li>
              ))}
              <li {...stylex.props(styles.line, styles.total)}>
                <span>{t('billing.invoiceTotal')}</span>
                <span {...stylex.props(styles.amount)}>{money(invoice.total)}</span>
              </li>
              {due != null && due !== invoice.total ? (
                <li {...stylex.props(styles.line)}>
                  <span>{t('billing.invoiceRemaining')}</span>
                  <span {...stylex.props(styles.amount)}>{money(due)}</span>
                </li>
              ) : null}
            </ul>
          ) : null}
          {confirming && canCancel ? (
            <p {...stylex.props(styles.note)}>{t('billing.invoiceCancelConfirm')}</p>
          ) : null}
          {props.cancelError ? (
            <p role="alert" {...stylex.props(styles.note, styles.error)}>
              {t('billing.invoiceCancelError')}
            </p>
          ) : null}
        </div>
        {url || canCancel || canRetryCancellation ? (
          <Dialog.Footer>
            {canRetryCancellation ? (
              <Button variant="secondary" disabled={props.cancelPending} onClick={props.onCancel}>
                {t('billing.invoiceRetryCancellation')}
              </Button>
            ) : canCancel ? (
              <Button
                variant={confirming ? 'destructive' : 'secondary'}
                disabled={props.cancelPending}
                onClick={() => (confirming ? props.onCancel() : setConfirming(true))}
              >
                {props.cancelPending ? <Spinner size="small" /> : null}
                {t(confirming ? 'billing.invoiceConfirmCancel' : 'billing.invoiceCancel')}
              </Button>
            ) : null}
            {url ? (
              <Button
                variant={invoice.status === 'open' ? 'primary' : 'secondary'}
                nativeButton={false}
                render={<a href={url} target="_blank" rel="noopener noreferrer" />}
              >
                {t(invoice.status === 'open' ? 'billing.invoicePay' : 'billing.invoiceReceipt')}
              </Button>
            ) : null}
          </Dialog.Footer>
        ) : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}

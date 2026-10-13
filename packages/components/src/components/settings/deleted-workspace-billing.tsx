import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCloudAction, useCloudQuery } from '@lody/platform/react';
import type { BillingInvoiceDetail } from '@lody/cloud-api';
import { Button } from '@lody/ui/button';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { CompactRow, CompactSection } from './compact-layout';
import { BillingInvoiceDetails } from './billing-invoice-details';
import {
  formatDate,
  formatMoney,
  invoiceDisplayAmount,
  invoiceReasonKey,
  invoiceStatusKey,
  type BillingInvoice,
} from './billing-setting-pure';

/** Billing identity survives workspace access and content deletion. Owner only. */
export function DeletedWorkspaceBilling() {
  const { t } = useTranslation();
  const accounts = useCloudQuery(cloudOperations.billing.listDeletedWorkspaceBillingAccounts, {});
  if (!accounts?.length) return null;
  return (
    <CompactSection
      title={t('billing.deletedWorkspaces')}
      description={t('billing.workspaceDeletionCharges')}
    >
      {accounts.map((account) => (
        <DeletedWorkspaceInvoices key={account.workspaceId} {...account} />
      ))}
    </CompactSection>
  );
}

function DeletedWorkspaceInvoices({ workspaceId, name }: { workspaceId: string; name: string }) {
  const { t } = useTranslation();
  const list = useCloudAction(cloudOperations.billing.listBillingInvoices);
  const read = useCloudAction(cloudOperations.billing.getBillingInvoice);
  const [invoices, setInvoices] = useState<BillingInvoice[] | null>(null);
  const [selected, setSelected] = useState<BillingInvoice | null>(null);
  const [detail, setDetail] = useState<BillingInvoiceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const show = async (invoice: BillingInvoice) => {
    setSelected(invoice);
    setDetail(null);
    setLoading(true);
    setError(false);
    try {
      setDetail(await read({ workspaceId, invoiceId: invoice.id }));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <CompactRow
        label={name}
        helper={error && !selected ? t('billing.invoiceDetailsError') : undefined}
      >
        <Button
          variant="secondary"
          size="small"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setError(false);
            void list({ workspaceId })
              .then((result) => setInvoices(result.invoices))
              .catch(() => setError(true))
              .finally(() => setLoading(false));
          }}
        >
          {t('billing.historyTitle')}
        </Button>
      </CompactRow>
      {invoices?.map((invoice) => (
        <CompactRow
          key={invoice.id}
          label={`${t(invoiceReasonKey(invoice))} · ${formatDate(invoice.createdAt)}`}
          helper={`${t(invoiceStatusKey(invoice.status))} · ${invoiceDisplayAmount(invoice) == null ? t('billing.invoiceAmountUnavailable') : formatMoney(invoiceDisplayAmount(invoice)!, invoice.currency)}`}
        >
          <Button
            variant="secondary"
            size="small"
            disabled={loading}
            onClick={() => void show(invoice)}
          >
            {t('billing.invoiceDetails')}
          </Button>
        </CompactRow>
      ))}
      {selected ? (
        <BillingInvoiceDetails
          invoice={selected}
          detail={detail}
          loading={loading}
          error={error}
          cancelPending={false}
          cancelError={false}
          onClose={() => setSelected(null)}
          onRetry={() => void show(selected)}
          onCancel={() => {}}
        />
      ) : null}
    </>
  );
}

import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { DesktopCheckoutReturnPage } from '@/components/pages/desktop-checkout-return-page';

export const Route = createFileRoute('/desktop/checkout-return')({
  component: DesktopCheckoutReturnCallback,
});

function DesktopCheckoutReturnCallback() {
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [checkoutResult, setCheckoutResult] = useState<'success' | 'canceled' | null>(null);

  useEffect(() => {
    const checkout = new URLSearchParams(window.location.search).get('checkout');
    setCheckoutResult(
      checkout === 'success' ? 'success' : checkout === 'canceled' ? 'canceled' : null
    );
    const url = `lody://checkout-return${window.location.search}`;
    setDeepLink(url);
    window.location.href = url;
  }, []);

  return <DesktopCheckoutReturnPage deepLink={deepLink} checkoutResult={checkoutResult} />;
}

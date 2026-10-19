import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { usePostHog } from '@posthog/react';
import { RouteMessage } from '@/components/route-message';
import { DeviceAuthPage as DeviceAuthPageView } from '@/components/pages/device-auth-page';
import { useStableSession } from '@/hooks/useStableSession';
import { getAppCurrentPathWithSearch, getAppWindowSearchParams } from '@/lib/app-location';
import { capturePostHogEvent, capturePostHogOutcome } from '@/lib/posthog-analytics';
import { useAppCapability } from '@/lib/app-platform';
import { requireCloudAuthBaseUrl } from '@/lib/cloud-http-port';

export const Route = createFileRoute('/device')({
  component: DeviceAuthRoute,
});

/**
 * 设备授权验证页面
 * 用户在此页面输入CLI显示的验证码完成授权
 */
function DeviceAuthRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: session, isPending, isRetrying, error } = useStableSession();
  const isAuthenticated = Boolean(session?.user);
  const cloudAccountAvailable = useAppCapability('cloudAccount');
  const [sessionSettled, setSessionSettled] = useState(!isPending);

  useEffect(() => {
    if (!isPending) setSessionSettled(true);
  }, [isPending]);

  // 如果未登录，重定向到登录页
  useEffect(() => {
    if (!cloudAccountAvailable) {
      void navigate({ to: '/', replace: true });
      return;
    }
    if (!isAuthenticated && !isPending) {
      void navigate({
        to: '/login',
        search: { redirect: getAppCurrentPathWithSearch() },
      });
    }
  }, [cloudAccountAvailable, isAuthenticated, isPending, navigate]);

  if (!cloudAccountAvailable) {
    return null;
  }

  if (!sessionSettled) {
    return null;
  }

  if (isPending || isRetrying) {
    return null;
  }

  if (error) {
    return (
      <RouteMessage
        gate="session_load_error"
        title={t('workspace.route.sessionLoadErrorTitle')}
        description={t('workspace.route.sessionLoadErrorDescription')}
      />
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <DeviceAuthInner />;
}

function DeviceAuthInner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const postHog = usePostHog();
  const { data: session } = useStableSession();
  const [hasPrefilledCode] = useState(() => {
    const params = getAppWindowSearchParams();
    return Boolean(params.get('user_code') ?? params.get('code'));
  });
  const [userCode, setUserCode] = useState(() => {
    const params = getAppWindowSearchParams();
    const code = params.get('user_code') ?? params.get('code');
    return code ? code.toUpperCase() : '';
  });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [countdown, setCountdown] = useState(10);

  const normalizedUserCode = userCode.replace(/-/g, '').toUpperCase();

  const viewedRef = useRef(false);
  useEffect(() => {
    if (viewedRef.current) {
      return;
    }
    viewedRef.current = true;
    capturePostHogEvent(postHog, 'auth/device_auth_viewed', {
      has_prefilled_code: hasPrefilledCode,
    });
  }, [hasPrefilledCode, postHog]);

  // 授权成功后倒计时跳转到主页
  useEffect(() => {
    if (!success) return undefined;

    if (countdown <= 0) {
      void navigate({ to: '/' });
      return undefined;
    }

    const timer = setTimeout(() => {
      setCountdown((prev) => prev - 1);
    }, 1000);

    return () => clearTimeout(timer);
  }, [success, countdown, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsVerifying(true);
    capturePostHogEvent(postHog, 'auth/device_auth_submitted', {
      has_prefilled_code: hasPrefilledCode,
    });

    try {
      const sessionToken = session?.session?.token;
      if (!sessionToken) {
        capturePostHogOutcome(postHog, 'auth/device_auth_failed', 'failed', {
          error_status: 'missing_session_token',
        });
        throw new Error('Missing session token. Please refresh and try again.');
      }

      const authBaseUrl = requireCloudAuthBaseUrl('cloudAccount');
      const verificationUrl = new URL('/api/auth/device', authBaseUrl);
      verificationUrl.searchParams.set('user_code', normalizedUserCode);
      const verificationRes = await fetch(verificationUrl.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });
      if (!verificationRes.ok) {
        capturePostHogOutcome(postHog, 'auth/device_auth_failed', 'failed', {
          error_status: `verify_${verificationRes.status}`,
        });
        const text = await verificationRes.text().catch(() => '');
        throw new Error(text || `Device verification failed (HTTP ${verificationRes.status})`);
      }

      const approveUrl = new URL('/api/cli/device/approve', authBaseUrl);
      const res = await fetch(approveUrl.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          userCode: normalizedUserCode,
        }),
      });
      if (!res.ok) {
        capturePostHogOutcome(postHog, 'auth/device_auth_failed', 'failed', {
          error_status: res.status,
        });
        const text = await res.text().catch(() => '');
        throw new Error(text || `Request failed (HTTP ${res.status})`);
      }
      capturePostHogOutcome(postHog, 'auth/device_auth_succeeded', 'success', {
        has_prefilled_code: hasPrefilledCode,
      });
      setSuccess(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <DeviceAuthPageView
      userLabel={`${t('device.loginAs')} ${session?.user?.name} (${session?.user?.email})`}
      userCode={userCode}
      error={error}
      success={success}
      countdown={countdown}
      isVerifying={isVerifying}
      canSubmit={normalizedUserCode.length === 8}
      onUserCodeChange={(value) => setUserCode(value.toUpperCase())}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    />
  );
}

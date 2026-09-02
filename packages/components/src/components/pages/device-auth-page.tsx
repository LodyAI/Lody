import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

import { Alert, AlertDescription } from '@/ui/alert';
import { Button } from '@lody/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { Input } from '@/ui/input';

export interface DeviceAuthPageProps {
  userLabel: string;
  userCode: string;
  error?: string | null;
  success?: boolean;
  countdown?: number;
  isVerifying?: boolean;
  canSubmit?: boolean;
  onUserCodeChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function DeviceAuthPage({
  userLabel,
  userCode,
  error = null,
  success = false,
  countdown = 10,
  isVerifying = false,
  canSubmit = false,
  onUserCodeChange,
  onSubmit,
}: DeviceAuthPageProps) {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle id="device-auth-title" as="h1" className="text-2xl">
            {t('device.title')}
          </CardTitle>
          <CardDescription>{t('device.description')}</CardDescription>
        </CardHeader>

        <CardContent>
          {success ? (
            <div className="space-y-4">
              <Alert className="border-status-success/30 bg-status-success/[0.08] text-status-success">
                <CheckCircle2 className="h-4 w-4 text-status-success" aria-hidden="true" />
                <AlertDescription className="text-status-success">
                  {t('device.success')}
                </AlertDescription>
              </Alert>

              <div className="text-center text-sm text-muted-foreground">
                {t('device.windowHint')}
              </div>

              <div className="mt-2 text-center text-sm text-muted-foreground">
                {t('device.redirectCountdown', { seconds: countdown })}
              </div>
            </div>
          ) : (
            <>
              <p className="mb-4 text-center text-sm text-foreground">{userLabel}</p>
              <form
                onSubmit={onSubmit}
                className="space-y-4"
                aria-labelledby="device-auth-title"
                aria-describedby={error ? 'device-auth-error' : 'device-auth-code-hint'}
                aria-busy={isVerifying}
              >
                <div className="space-y-2">
                  <label htmlFor="code" className="text-sm font-medium">
                    {t('device.verificationCode')}
                  </label>
                  <Input
                    id="code"
                    type="text"
                    placeholder={t('device.codePlaceholder')}
                    value={userCode}
                    onChange={(event) => onUserCodeChange(event.target.value)}
                    required
                    className="text-center text-2xl font-mono tracking-widest"
                    maxLength={9}
                    disabled={isVerifying}
                    autoFocus
                  />
                  <p id="device-auth-code-hint" className="text-xs text-muted-foreground">
                    {t('device.codeHint')}
                  </p>
                </div>

                {error ? (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" aria-hidden="true" />
                    <AlertDescription id="device-auth-error">{error}</AlertDescription>
                  </Alert>
                ) : null}

                <Button type="submit" className="w-full" disabled={!canSubmit || isVerifying}>
                  {isVerifying ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t('device.verifying')}
                    </>
                  ) : (
                    t('device.verifyButton')
                  )}
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

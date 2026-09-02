/**
 * 404 页面组件
 * 当用户访问不存在的页面时显示
 */
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@lody/ui/button';
import { Home, ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function NotFound() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  /**
   * 返回上一页
   */
  const handleGoBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      void navigate({ to: '/' });
    }
  };

  /**
   * 返回首页
   */
  const handleGoHome = () => {
    void navigate({ to: '/' });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="max-w-md px-4 text-center">
        <div className="mb-8">
          <h1 className="text-9xl font-bold text-muted-foreground">404</h1>
        </div>

        <h2 className="mb-4 text-2xl font-semibold text-foreground">
          {t('notFound.title', 'Page Not Found')}
        </h2>

        <p className="mb-8 text-muted-foreground">
          {t(
            'notFound.description',
            'Sorry, the page you are looking for does not exist or has been moved.'
          )}
        </p>

        <div className="flex justify-center gap-4">
          <Button variant="secondary" onClick={handleGoBack} className="flex">
            <ArrowLeft className="h-4 w-4" />
            {t('notFound.goBack', 'Go Back')}
          </Button>

          <Button onClick={handleGoHome} className="flex">
            <Home className="h-4 w-4" />
            {t('notFound.goHome', 'Go Home')}
          </Button>
        </div>
      </div>
    </div>
  );
}

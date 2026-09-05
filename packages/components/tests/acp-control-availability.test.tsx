import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AcpControlAvailability } from '../src/components/shared/acp-control-availability';
import { initI18n } from '../src/i18n';

const selector = {
  configId: 'reasoning_effort',
  label: 'Reasoning',
  type: 'select' as const,
  currentValue: '',
  options: [],
  perModel: true,
};

describe('model capability explanations', () => {
  it('distinguishes unknown from explicitly unsupported in Chinese', async () => {
    await initI18n('zh_CN');
    const unknown = renderToStaticMarkup(
      <AcpControlAvailability selector={{ ...selector, availability: 'unknown' }} value="high" />
    );
    expect(unknown).toContain('推理档位未确认');
    expect(unknown).toContain('high');
    expect(unknown).not.toContain('不支持');
    const unsupported = renderToStaticMarkup(
      <AcpControlAvailability selector={{ ...selector, availability: 'unsupported' }} />
    );
    expect(unsupported).toContain('此模型未提供可选推理档位');
    expect(unsupported).not.toContain('刷新');
  });
});

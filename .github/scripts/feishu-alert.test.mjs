import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFeishuCardPayload,
  classifyWorkflowNotification,
  sendFeishuAlert,
  signFeishuWebhook,
  validateFeishuWebhookUrl,
} from './feishu-alert.mjs';

await test('signs Feishu webhook payloads using timestamp + newline + secret HMAC-SHA256', () => {
  const sig = signFeishuWebhook(1700000000, 'demo-secret');
  assert.match(sig, /^[A-Za-z0-9+/]{43}=$/u);
  assert.equal(sig, signFeishuWebhook('1700000000', 'demo-secret'));
  assert.notEqual(sig, signFeishuWebhook(1700000001, 'demo-secret'));
});

await test('rejects non-HTTPS webhook URLs except localhost', () => {
  assert.throws(() => validateFeishuWebhookUrl(''), /not configured/u);
  assert.throws(() => validateFeishuWebhookUrl('http://open.feishu.cn/hook/abc'), /must use https/u);
  assert.equal(
    validateFeishuWebhookUrl('https://open.feishu.cn/open-apis/bot/v2/hook/test'),
    'https://open.feishu.cn/open-apis/bot/v2/hook/test'
  );
});

await test('classifies failed jobs into red alert cards and emergency passes into orange notices', () => {
  const failed = classifyWorkflowNotification({
    channel: 'nightly',
    mode: 'verified',
    sha: 'a'.repeat(40),
    runUrl: 'https://github.com/LodyAI/Lody/actions/runs/999',
    jobResults: {
      validate: { result: 'success' },
      'e2e-gate': { result: 'failure' },
      publish: { result: 'skipped' },
    },
  });
  assert.equal(failed.shouldSend, true);
  assert.equal(failed.card.template, 'red');
  assert.match(failed.card.details.join('\n'), /e2e-gate/u);

  const emergency = classifyWorkflowNotification({
    channel: 'stable',
    mode: 'emergency',
    reason: 'hotfix startup crash',
    sha: 'b'.repeat(40),
    jobResults: {
      'validate-app-redirects': { result: 'skipped' },
      'e2e-gate': { result: 'skipped' },
      'upload-electron-to-r2': { result: 'success' },
    },
  });
  assert.equal(emergency.shouldSend, true);
  assert.equal(emergency.card.template, 'orange');
  assert.match(emergency.card.details.join('\n'), /hotfix startup crash/u);

  const quietPass = classifyWorkflowNotification({
    channel: 'nightly',
    mode: 'verified',
    sha: 'c'.repeat(40),
    jobResults: { 'e2e-gate': { result: 'success' }, publish: { result: 'success' } },
  });
  assert.equal(quietPass.shouldSend, false);
});

await test('delivers signed interactive card and fails on non-zero Feishu business code', async () => {
  const payload = buildFeishuCardPayload({
    title: 'Lody Nightly 发布失败',
    template: 'red',
    fields: [{ label: 'SHA', value: 'abcdef123' }],
    timestamp: 1700000000,
    secret: 'top-secret',
  });

  let captured = null;
  await sendFeishuAlert({
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo',
    payload,
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ code: 0, msg: 'ok' }), { status: 200 });
    },
  });
  assert.equal(captured.sign, signFeishuWebhook(1700000000, 'top-secret'));

  await assert.rejects(
    sendFeishuAlert({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo',
      payload,
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 19021, msg: 'sign match fail' }), { status: 200 }),
    }),
    /code=19021/u
  );
});

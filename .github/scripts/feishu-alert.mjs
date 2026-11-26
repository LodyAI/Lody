import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Computes Feishu custom bot webhook v2 signature.
 * Spec: HMAC-SHA256 with key `${timestamp}\n${secret}` and empty message, base64-encoded.
 */
export function signFeishuWebhook(timestampSeconds, secret) {
  const ts = String(timestampSeconds);
  if (!/^\d+$/u.test(ts)) {
    throw new Error(`Invalid Feishu timestamp: ${ts}`);
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('Feishu webhook secret must be a non-empty string');
  }
  return createHmac('sha256', `${ts}\n${secret}`).update('').digest('base64');
}

export function validateFeishuWebhookUrl(webhookUrl) {
  if (typeof webhookUrl !== 'string' || webhookUrl.trim().length === 0) {
    throw new Error('FEISHU_ALERT_WEBHOOK_URL is not configured');
  }
  let parsed;
  try {
    parsed = new URL(webhookUrl.trim());
  } catch {
    throw new Error('FEISHU_ALERT_WEBHOOK_URL is not a valid URL');
  }
  const isLocalTestHost =
    parsed.protocol === 'http:' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if (parsed.protocol !== 'https:' && !isLocalTestHost) {
    throw new Error('FEISHU_ALERT_WEBHOOK_URL must use https://');
  }
  return parsed.toString();
}

export function buildFeishuCardPayload({
  title,
  template = 'red',
  fields = [],
  details = [],
  note = '',
  timestamp,
  secret,
}) {
  const elements = [];

  if (fields.length > 0) {
    elements.push({
      tag: 'div',
      fields: fields.map(({ label, value, isShort = true }) => ({
        is_short: isShort,
        text: {
          tag: 'lark_md',
          content: `**${label}**\n${value}`,
        },
      })),
    });
  }

  for (const block of details) {
    if (typeof block !== 'string' || block.trim().length === 0) continue;
    elements.push({
      tag: 'markdown',
      content: block,
    });
  }

  if (note) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: note }],
    });
  }

  const payload = {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: title },
        template,
      },
      elements,
    },
  };

  if (secret) {
    const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
    payload.timestamp = ts;
    payload.sign = signFeishuWebhook(ts, secret);
  }

  return payload;
}

export function classifyWorkflowNotification({
  channel,
  mode = 'verified',
  reason = '',
  sha = '',
  runUrl = '',
  jobResults = {},
  notifyOnSuccess = false,
}) {
  const failedJobs = Object.entries(jobResults)
    .filter(([, info]) => {
      const result = info?.result;
      return result && result !== 'success' && result !== 'skipped';
    })
    .map(([name, info]) => `- \`${name}\`: ${info.result}`);

  const label = channel === 'stable' ? 'Stable' : 'Nightly';
  const shortSha = sha ? `\`${sha.slice(0, 9)}\`` : 'unknown';

  if (failedJobs.length > 0) {
    const emergencyHint =
      channel === 'stable'
        ? '如需紧急跳过测试发布，合并 Release PR 时保留标题不变，在 commit body 写入 `[emergency-release]`。'
        : '如需紧急跳过测试发布，请在 GitHub Actions 手动触发 `Nightly cloud clients` 并选择 `mode=emergency`。';
    return {
      shouldSend: true,
      card: {
        title: `🚨 Lody ${label} 发布失败`,
        template: 'red',
        fields: [
          { label: '发布通道', value: label },
          { label: '发布模式', value: mode },
          { label: '提交 SHA', value: shortSha },
          ...(runUrl ? [{ label: 'Actions Run', value: `[查看详情](${runUrl})` }] : []),
        ],
        details: [
          ...(reason ? [`**备注/原因**：${reason}`] : []),
          `**失败环节**：\n${failedJobs.join('\n')}`,
          emergencyHint,
        ],
      },
    };
  }

  if (mode === 'emergency') {
    return {
      shouldSend: true,
      card: {
        title: `⚠️ Lody ${label} 紧急发布完成（已跳过测试）`,
        template: 'orange',
        fields: [
          { label: '发布通道', value: label },
          { label: '提交 SHA', value: shortSha },
          ...(runUrl ? [{ label: 'Actions Run', value: `[查看详情](${runUrl})` }] : []),
        ],
        details: [reason ? `**紧急发布原因**：${reason}` : '**紧急发布**：已跳过 E2E 与静态校验'],
      },
    };
  }

  if (notifyOnSuccess) {
    return {
      shouldSend: true,
      card: {
        title: `✅ Lody ${label} 发布成功`,
        template: 'green',
        fields: [
          { label: '发布通道', value: label },
          { label: '提交 SHA', value: shortSha },
          ...(runUrl ? [{ label: 'Actions Run', value: `[查看详情](${runUrl})` }] : []),
        ],
      },
    };
  }

  return { shouldSend: false, card: null };
}

export async function sendFeishuAlert({
  webhookUrl,
  secret,
  payload,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const url = validateFeishuWebhookUrl(webhookUrl);
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable');
  }

  const body =
    secret && !payload.sign
      ? { ...payload, timestamp: String(Math.floor(Date.now() / 1000)) }
      : payload;
  if (secret && !body.sign) {
    body.sign = signFeishuWebhook(body.timestamp, secret);
  }

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Feishu webhook HTTP ${response.status}: ${text.slice(0, 400)}`);
  }

  let parsed = null;
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Feishu webhook returned non-JSON response: ${text.slice(0, 200)}`);
    }
  }

  const code = parsed?.code ?? parsed?.StatusCode ?? 0;
  if (code !== 0) {
    const msg = parsed?.msg ?? parsed?.StatusMessage ?? 'unknown error';
    throw new Error(`Feishu webhook rejected payload (code=${code}): ${msg}`);
  }

  return parsed ?? { code: 0 };
}

async function runFromActionsEnv() {
  const env = process.env;
  const webhookUrl = env.FEISHU_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('[feishu-alert] FEISHU_ALERT_WEBHOOK_URL is not set; skipping notification');
    return;
  }

  const jobResults = env.JOB_RESULTS_JSON ? JSON.parse(env.JOB_RESULTS_JSON) : {};
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : '';

  const decision = classifyWorkflowNotification({
    channel: env.RELEASE_CHANNEL === 'stable' ? 'stable' : 'nightly',
    mode: env.RELEASE_MODE || 'verified',
    reason: env.RELEASE_REASON || '',
    sha: env.SOURCE_SHA || env.GITHUB_SHA || '',
    runUrl,
    jobResults,
    notifyOnSuccess: env.FEISHU_NOTIFY_ON_SUCCESS === '1',
  });

  if (!decision.shouldSend) {
    console.log('[feishu-alert] workflow succeeded in verified mode; no alert needed');
    return;
  }

  const secret = env.FEISHU_ALERT_WEBHOOK_SECRET || undefined;
  const payload = buildFeishuCardPayload({ ...decision.card, secret });
  await sendFeishuAlert({ webhookUrl, secret, payload });
  console.log(`[feishu-alert] delivered: ${decision.card.title}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromActionsEnv().catch((error) => {
    console.error(`[feishu-alert] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

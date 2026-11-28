import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildFeishuCardPayload, sendFeishuAlert } from './feishu-alert.mjs';

export function findLatestVerifySummary(selfhostDir) {
  const baseDir = join(selfhostDir, 'local-stack', '.state', 'verify-release');
  if (!existsSync(baseDir)) return null;
  const entries = readdirSync(baseDir)
    .map((name) => {
      const summaryPath = join(baseDir, name, 'summary.json');
      if (!existsSync(summaryPath)) return null;
      return { summaryPath, mtimeMs: statSync(summaryPath).mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries[0]?.summaryPath ?? null;
}

/**
 * Formats a public-safe one-line summary for public GitHub Actions logs.
 * Deliberately omits private file paths, stack traces, and backend internals.
 */
export function formatPublicStatusLine(report, exitCode) {
  if (!report || typeof report !== 'object' || !report.suites) {
    return `[selfhost-e2e] status=failed exitCode=${exitCode} suites=unavailable`;
  }
  const suiteSummary = Object.entries(report.suites)
    .map(([name, info]) => `${name}:${info?.status ?? 'unknown'}`)
    .join(',');
  const passed = exitCode === 0 && report.status === 'passed';
  return `[selfhost-e2e] status=${passed ? 'passed' : 'failed'} exitCode=${exitCode} suites=${suiteSummary || 'none'}`;
}

export function extractPrivateFailureDetails(report) {
  if (!report || typeof report !== 'object' || !report.suites) {
    return [
      '- 未生成有效的 `verify:release` `summary.json` 报告（可能是依赖安装或本地栈启动失败）',
    ];
  }
  const lines = [];
  for (const [suiteName, suite] of Object.entries(report.suites)) {
    if (!suite || suite.status === 'passed') continue;
    const reason = suite.reason ? ` (${String(suite.reason).slice(0, 200)})` : '';
    lines.push(`- **${suiteName}**: ${suite.status}${reason}`);
    if (Array.isArray(suite.journeys)) {
      for (const j of suite.journeys) {
        if (j.status !== 'passed') {
          lines.push(`  - journey \`${j.id}\` (${j.name}): ${j.status}`);
        }
      }
    }
    if (Array.isArray(suite.shards)) {
      for (const s of suite.shards) {
        if (s.status !== 'passed') {
          lines.push(`  - shard \`${s.id}\`: ${s.status}`);
        }
      }
    }
  }
  if (lines.length === 0 && report.status !== 'passed') {
    lines.push(`- 总体状态为 \`${report.status ?? 'unknown'}\``);
  }
  return lines;
}

export function readLogTail(logPath, { maxLines = 40, maxChars = 3500 } = {}) {
  if (!logPath || !existsSync(logPath)) return '';
  const raw = readFileSync(logPath, 'utf8');
  // Strip ANSI escape sequences before trimming for Feishu markdown.
  const cleaned = raw.replace(/\u001B\[[0-9;]*[A-Za-z]/gu, '');
  const lines = cleaned
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return '';
  const tail = lines.slice(-maxLines).join('\n');
  if (tail.length <= maxChars) return tail;
  return `…${tail.slice(-(maxChars - 1))}`;
}

export function readNativeStartupLogTail(mainLogTail, { maxLines = 40, maxChars = 3500 } = {}) {
  const match = /Native startup failed; see (\S+)/u.exec(mainLogTail || '');
  if (!match) return '';
  const harnessLog = match[1];
  const allLog = join(dirname(harnessLog), 'all.log');
  if (existsSync(allLog)) {
    const tail = readLogTail(allLog, { maxLines, maxChars });
    if (tail) return tail;
  }
  return readLogTail(harnessLog, { maxLines, maxChars });
}

async function main() {
  const [selfhostDir, exitCodeRaw, logPath] = process.argv.slice(2);
  const exitCode = Number(exitCodeRaw ?? 1);
  const summaryPath = selfhostDir ? findLatestVerifySummary(selfhostDir) : null;
  const report = summaryPath ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null;
  const passed = exitCode === 0 && report?.status === 'passed';

  // Public log: sanitized status only.
  console.log(formatPublicStatusLine(report, exitCode));

  if (passed) return;

  const webhookUrl = process.env.FEISHU_ALERT_WEBHOOK_URL;
  if (webhookUrl) {
    const secret = process.env.FEISHU_ALERT_WEBHOOK_SECRET || undefined;
    const runUrl =
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : '';
    const sha = process.env.CANDIDATE_SHA || process.env.GITHUB_SHA || '';
    const suiteLabel = process.env.SELFHOST_SUITE_LABEL || '';
    const details = extractPrivateFailureDetails(report);
    const logTail = readLogTail(logPath);
    const startupLogTail = readNativeStartupLogTail(logTail);
    const detailBlocks = [`**失败明细（仅内部群可见）**：\n${details.join('\n')}`];
    if (startupLogTail) {
      detailBlocks.push(
        `**Native 启动日志末尾（仅内部群可见）**：\n\`\`\`\n${startupLogTail}\n\`\`\``
      );
    }
    if (logTail) {
      detailBlocks.push(`**日志末尾（仅内部群可见）**：\n\`\`\`\n${logTail}\n\`\`\``);
    }
    const payload = buildFeishuCardPayload({
      title: suiteLabel
        ? `🚨 Lody 发布门禁：Self-Host E2E 失败 (${suiteLabel})`
        : '🚨 Lody 发布门禁：Self-Host E2E 失败详情',
      template: 'red',
      fields: [
        { label: '候选 SHA', value: sha ? `\`${sha.slice(0, 9)}\`` : 'unknown' },
        { label: '退出码', value: String(exitCode) },
        ...(suiteLabel ? [{ label: '套件', value: `\`${suiteLabel}\`` }] : []),
        ...(runUrl ? [{ label: 'Actions Run', value: `[查看详情](${runUrl})` }] : []),
      ],
      details: detailBlocks,
      secret,
    });
    try {
      await sendFeishuAlert({ webhookUrl, secret, payload });
      console.log('[selfhost-e2e] detailed failure summary delivered to Feishu');
    } catch {
      console.log('[selfhost-e2e] warning: failed to deliver Feishu failure details');
    }
  }

  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.log('[selfhost-e2e] status=failed reason=reporter-error');
    process.exit(1);
  });
}

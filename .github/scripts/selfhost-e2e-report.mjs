import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
    return ['- 未生成有效的 `verify:release` `summary.json` 报告（可能是依赖安装或本地栈启动失败）'];
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

async function main() {
  const [selfhostDir, exitCodeRaw] = process.argv.slice(2);
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
    const details = extractPrivateFailureDetails(report);
    const payload = buildFeishuCardPayload({
      title: '🚨 Lody 发布门禁：Self-Host E2E 失败详情',
      template: 'red',
      fields: [
        { label: '候选 SHA', value: sha ? `\`${sha.slice(0, 9)}\`` : 'unknown' },
        { label: '退出码', value: String(exitCode) },
        ...(runUrl ? [{ label: 'Actions Run', value: `[查看详情](${runUrl})` }] : []),
      ],
      details: [`**失败明细（仅内部群可见）**：\n${details.join('\n')}`],
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

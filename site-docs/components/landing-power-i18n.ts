/** Copy for the landing power demos (usage replica + PR replica), per locale. */

import type { PowerPrLabels } from './landing-replica/power-pr';
import type { PowerUsageLabels } from './landing-replica/power-usage';

export type PowerDemoLocale = 'en' | 'zh';

export type PowerDemoCopy = {
  /** BCP 47 locale for Intl number/date formatting (compact units follow the product language). */
  intlLocale: string;
  usage: PowerUsageLabels;
  pr: PowerPrLabels;
  /** Short weekday names Mon…Sun for the stacked-area x axis. */
  weekdays: readonly [string, string, string, string, string, string, string];
  today: string;
};

const en: PowerDemoCopy = {
  intlLocale: 'en',
  weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  today: 'Today',
  usage: {
    title: 'Usage',
    range: 'Range',
    windowShort: { day: '24h', week: '7d', month: '30d', total: 'All' },
    windowLong: {
      day: 'Last 24 hours',
      week: 'Last 7 days',
      month: 'Last 30 days',
      total: 'All time',
    },
    tokens: 'Tokens',
    cost: 'Cost (USD)',
    byModel: 'By model',
    byUser: 'By member',
    empty: 'No usage data in this range',
    other: 'Other',
    breakdown: {
      title: 'Token breakdown',
      cache: 'Cache',
      input: 'Input',
      output: 'Output',
      reasoning: 'Reasoning output',
    },
    skyline: {
      title: 'Usage skyline',
      subtitle: 'Last 53 weeks of daily usage',
      windowSubtitle: 'Last 30 days, lit inside the last 53 weeks',
      metric: 'Usage metric',
      heatmap: 'Usage heatmap',
      less: 'Less',
      more: 'More',
      clickHint: 'Click a day to open its breakdown',
      clickForDetails: 'Click for details',
      future: 'Future',
      dayDetail: 'Day detail',
      close: 'Close',
      peakShare: (percent) => `${percent}% of peak day`,
      webSearches: (count) => (count === 1 ? '1 web search' : `${count} web searches`),
      otherRows: (count, tokens) => `+${count} more · ${tokens}`,
      activeIntervals: 'Active intervals',
      peakInterval: 'Peak interval',
      averagePerInterval: 'Average per interval',
      total: 'Total',
      dailyAverage: 'Daily average',
      peakDay: 'Peak day',
      activeDays: 'Active days',
      longestStreak: 'Longest streak',
      noUsage: 'No usage',
      currentStreakDetail: (days) => `${days}-day current streak`,
      currentIntervalStreakDetail: (count) => `${count} active intervals in a row`,
    },
  },
  pr: {
    mergeShortSquash: 'Squash',
    moreActions: 'More actions',
    opened: (when) => `opened ${when}`,
    commits: (count) => `${count} commits`,
    files: (count) => `${count} files`,
    checksPassed: 'All checks passed',
    checksCount: (count) => (count === 1 ? '1 check' : `${count} checks`),
    commented: 'commented',
    reviewApproved: 'approved',
    composerPlaceholder: 'Leave a comment',
    composerSubmit: 'Comment',
  },
};

const zh: PowerDemoCopy = {
  intlLocale: 'zh-CN',
  weekdays: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
  today: '今天',
  usage: {
    title: '用量',
    range: '范围',
    windowShort: { day: '24 小时', week: '7 天', month: '30 天', total: '全部' },
    windowLong: {
      day: '最近 24 小时',
      week: '最近 7 天',
      month: '最近 30 天',
      total: '全部时间',
    },
    tokens: 'Token',
    cost: '花费（USD）',
    byModel: '按模型',
    byUser: '按成员',
    empty: '当前范围内暂无用量数据',
    other: '其他',
    breakdown: {
      title: 'Token 明细',
      cache: '缓存',
      input: '输入',
      output: '输出',
      reasoning: '推理输出',
    },
    skyline: {
      title: '用量天际线',
      subtitle: '最近 53 周的每日用量',
      windowSubtitle: '最近 30 天，在最近 53 周中高亮',
      metric: '用量指标',
      heatmap: '用量热力图',
      less: '少',
      more: '多',
      clickHint: '点击某一天查看当日明细',
      clickForDetails: '点击查看明细',
      future: '未来',
      dayDetail: '当日明细',
      close: '关闭',
      peakShare: (percent) => `为峰值日的 ${percent}%`,
      webSearches: (count) => `${count} 次联网搜索`,
      otherRows: (count, tokens) => `另外 ${count} 项 · ${tokens}`,
      activeIntervals: '活跃时段',
      peakInterval: '峰值时段',
      averagePerInterval: '每段平均',
      total: '总计',
      dailyAverage: '日均用量',
      peakDay: '峰值日期',
      activeDays: '活跃天数',
      longestStreak: '最长连续',
      noUsage: '无用量',
      currentStreakDetail: (days) => `当前连续 ${days} 天`,
      currentIntervalStreakDetail: (count) => `连续 ${count} 个活跃时段`,
    },
  },
  pr: {
    mergeShortSquash: '压缩',
    moreActions: '更多操作',
    opened: (when) => `创建于 ${when}`,
    commits: (count) => `${count} 个提交`,
    files: (count) => `${count} 个文件`,
    checksPassed: '全部检查通过',
    checksCount: (count) => `${count} 项检查`,
    commented: '已评论',
    reviewApproved: '已批准',
    composerPlaceholder: '留下评论',
    composerSubmit: '评论',
  },
};

export const POWER_DEMO_COPY: Record<PowerDemoLocale, PowerDemoCopy> = { en, zh };

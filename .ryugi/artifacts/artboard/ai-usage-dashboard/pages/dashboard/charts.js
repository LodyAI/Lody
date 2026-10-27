// Deterministic mock data for the single-page AI usage design.
// Token totals are in millions and sum to the headline numbers on the page.

const USAGE_DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const USAGE_BUCKETS_PER_DAY = 8;

const USAGE_SERIES = [
  {
    id: 'claude',
    label: 'Claude',
    color: '#2563eb',
    daily: [4.2, 4.8, 5.6, 6.4, 5.9, 4.4, 3.4],
    pattern: [0.055, 0.085, 0.12, 0.15, 0.17, 0.155, 0.135, 0.125],
  },
  {
    id: 'codex',
    label: 'Codex',
    color: '#0ea5e9',
    daily: [2.6, 3.0, 3.4, 3.9, 3.6, 2.7, 2.1],
    pattern: [0.05, 0.08, 0.115, 0.155, 0.18, 0.165, 0.14, 0.115],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    color: '#8b5cf6',
    daily: [0.7, 0.8, 0.9, 1.0, 0.9, 0.7, 0.5],
    pattern: [0.06, 0.09, 0.13, 0.16, 0.17, 0.15, 0.13, 0.11],
  },
  {
    id: 'kimi',
    label: 'Kimi',
    color: '#10b981',
    daily: [0.4, 0.4, 0.5, 0.6, 0.5, 0.4, 0.3],
    pattern: [0.05, 0.08, 0.12, 0.16, 0.18, 0.16, 0.14, 0.11],
  },
];

function smoothPath(points) {
  if (points.length < 2) return '';
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

function areaPath(upper, lower) {
  const reversed = [...lower].reverse();
  const reversedPath = smoothPath(reversed).replace(/^M\s*[-\d.]+\s+[-\d.]+/, '');
  return `${smoothPath(upper)} L ${reversed[0].x.toFixed(2)} ${reversed[0].y.toFixed(2)} ${reversedPath.trim()} Z`;
}

function formatMillions(value) {
  if (value === 0) return '0';
  if (value < 1) return `${Math.round(value * 1000)}K`;
  return `${value.toFixed(1)}M`;
}

function renderUsageChart() {
  const svg = document.getElementById('usage-chart');
  if (!svg) return;

  const W = 1000;
  const H = 224;
  const left = 42;
  const right = 2;
  const top = 10;
  const bottom = 24;
  const innerW = W - left - right;
  const innerH = H - top - bottom;

  const values = USAGE_SERIES.map((series) =>
    series.daily.flatMap((total) => series.pattern.map((fraction) => total * fraction))
  );

  const count = values[0].length;
  const totals = Array.from({ length: count }, (_, i) =>
    values.reduce((sum, series) => sum + series[i], 0)
  );
  const maxTotal = Math.max(...totals);
  const yMax = Math.ceil(maxTotal * 2) / 2;

  const xAt = (i) => left + (i * innerW) / (count - 1);
  const yAt = (v) => top + innerH - (v / yMax) * innerH;

  const parts = [`<defs>`];
  for (const series of USAGE_SERIES) {
    parts.push(
      `<linearGradient id="fill-${series.id}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0%" stop-color="${series.color}" stop-opacity="0.24"/>` +
        `<stop offset="100%" stop-color="${series.color}" stop-opacity="0.04"/>` +
        `</linearGradient>`
    );
  }
  parts.push(`</defs>`);

  const ticks = [];
  for (let v = 0; v <= yMax + 0.001; v += 1) ticks.push(Number(v.toFixed(2)));

  for (const v of ticks) {
    const y = yAt(v);
    parts.push(
      `<line x1="${left}" y1="${y.toFixed(2)}" x2="${W - right}" y2="${y.toFixed(2)}" stroke="#2b2b2b" stroke-width="0.5"/>`
    );
    parts.push(
      `<text x="${left - 9}" y="${(y + 4).toFixed(2)}" text-anchor="end" fill="#737373" font-family="Inter, PingFang SC, sans-serif" font-size="12">${formatMillions(v)}</text>`
    );
  }

  for (let day = 0; day < 7; day++) {
    const idx = day * USAGE_BUCKETS_PER_DAY;
    const x = xAt(idx);
    if (day > 0) {
      parts.push(
        `<line x1="${x.toFixed(2)}" y1="${top}" x2="${x.toFixed(2)}" y2="${top + innerH}" stroke="#232323" stroke-width="0.5"/>`
      );
    }
    parts.push(
      `<text x="${(x + 4).toFixed(2)}" y="${H - 6}" fill="#737373" font-family="Inter, PingFang SC, sans-serif" font-size="12">${USAGE_DAYS[day]}</text>`
    );
  }

  const lower = new Array(count).fill(0);
  for (let si = 0; si < USAGE_SERIES.length; si++) {
    const series = USAGE_SERIES[si];
    const upperPoints = values[si].map((v, i) => ({ x: xAt(i), y: yAt(lower[i] + v) }));
    const lowerPoints = lower.map((v, i) => ({ x: xAt(i), y: yAt(v) }));
    parts.push(`<path d="${areaPath(upperPoints, lowerPoints)}" fill="url(#fill-${series.id})"/>`);
    parts.push(
      `<path d="${smoothPath(upperPoints)}" fill="none" stroke="${series.color}" stroke-width="1" stroke-opacity="0.85"/>`
    );
    for (let i = 0; i < count; i++) lower[i] += values[si][i];
  }

  svg.innerHTML = parts.join('');
}


function linePath(points) {
  return points
    .map((point, i) => `${i === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
}

function renderQuotaCharts() {
  drawQuotaChart('quota-5h-chart', {
    hours: 24,
    labels: ['00:00', '06:00', '12:00', '18:00', '24:00'],
    series: [
      { color: '#2563eb', start: 88, end: 62 },
      { color: '#0ea5e9', start: 62, end: 8 },
    ],
    sawtooth: 5,
  });

  drawQuotaChart('quota-7d-chart', {
    hours: 7 * 24,
    labels: USAGE_DAYS,
    series: [
      { color: '#2563eb', start: 82, preResetEnd: 35, postResetStart: 90, end: 44 },
      { color: '#0ea5e9', start: 90, preResetEnd: 45, postResetStart: 95, end: 71 },
    ],
    sawtooth: null,
  });
}

function drawQuotaChart(id, options) {
  const svg = document.getElementById(id);
  if (!svg) return;

  const W = 420;
  const H = 140;
  const left = 36;
  const right = 2;
  const top = 8;
  const bottom = 20;
  const innerW = W - left - right;
  const innerH = H - top - bottom;
  const count = options.hours + 1;
  const yMax = 100;

  const xAt = (i) => left + (i * innerW) / (count - 1);
  const yAt = (v) => top + innerH - (v / yMax) * innerH;

  const values = options.series.map((entry) =>
    Array.from({ length: count }, (_, i) => {
      if (!options.sawtooth) {
        const t = i / (count - 1);
        const resetAt = 0.6;
        if (t < resetAt) {
          return entry.start - (entry.start - entry.preResetEnd) * (t / resetAt);
        }
        const after = (t - resetAt) / (1 - resetAt);
        return entry.postResetStart - (entry.postResetStart - entry.end) * after;
      }
      const position = i % options.sawtooth;
      const base =
        entry.start - ((entry.start - entry.end) / (options.sawtooth - 1)) * position;
      const noise = Math.sin(i * 0.9) * 0.6;
      return i === count - 1 ? entry.end : Math.max(0, Math.min(100, base + noise));
    })
  );

  const parts = [];

  for (const v of [0, 50, 100]) {
    const y = yAt(v);
    parts.push(
      `<line x1="${left}" y1="${y.toFixed(2)}" x2="${W - right}" y2="${y.toFixed(2)}" stroke="#2b2b2b" stroke-width="0.5"/>`
    );
    parts.push(
      `<text x="${left - 7}" y="${(y + 3).toFixed(2)}" text-anchor="end" fill="#737373" font-family="Inter, PingFang SC, sans-serif" font-size="12">${v}%</text>`
    );
  }

  const labelCount = options.labels.length;
  for (let i = 0; i < labelCount; i++) {
    const x = left + (i * innerW) / (labelCount - 1);
    if (i > 0 && options.sawtooth) {
      parts.push(
        `<line x1="${x.toFixed(2)}" y1="${top}" x2="${x.toFixed(2)}" y2="${top + innerH}" stroke="#232323" stroke-width="0.5"/>`
      );
    }
    parts.push(
      `<text x="${x.toFixed(2)}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : i === labelCount - 1 ? 'end' : 'middle'}" fill="#737373" font-family="Inter, PingFang SC, sans-serif" font-size="12">${options.labels[i]}</text>`
    );
  }

  for (let si = 0; si < options.series.length; si++) {
    const entry = options.series[si];
    const points = values[si].map((value, i) => ({ x: xAt(i), y: yAt(value) }));
    parts.push(
      `<path d="${linePath(points)}" fill="none" stroke="${entry.color}" stroke-width="2" stroke-opacity="0.95" stroke-linejoin="round"/>`
    );
    const last = points[points.length - 1];
    parts.push(
      `<circle cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="2.5" fill="${entry.color}"/>`
    );
  }

  svg.innerHTML = parts.join('');
}

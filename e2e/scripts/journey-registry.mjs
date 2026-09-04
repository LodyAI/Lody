import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const defaultRegistryPath = resolve(scriptDirectory, '..', 'journeys', 'registry.json');

const states = new Set(['active', 'backlog', 'quarantined']);
const priorities = new Set(['P0', 'P1']);
const runtimes = new Set(['none', 'simulator', 'codex']);
const coverageKeys = ['renderer', 'electronIpc', 'bundledCli', 'durableState', 'externalWire'];
const signalKeys = ['criticality', 'boundaryRisk', 'changeFrequency'];
const scoringKeys = [
  'criticality',
  'boundaryRisk',
  'changeFrequency',
  'freshness',
  'escapedDefect',
  'scoutSignal',
  'changedPath',
  'estimatedMinutePenalty',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, path, failures) {
  if (typeof value !== 'string' || value.trim() === '') failures.push(`${path} must be a string`);
}

function requireStringArray(value, path, failures, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    failures.push(`${path} must be ${allowEmpty ? 'a' : 'a non-empty'} string array`);
    return;
  }
  for (const [index, entry] of value.entries()) {
    requireString(entry, `${path}[${index}]`, failures);
  }
}

export function normalizeSemanticContract(journey) {
  return {
    runtime: journey.runtime,
    fixture: journey.fixture,
    actions: journey.actions?.map((action) => ({
      id: action.id,
      ...(action.args === undefined ? {} : { args: action.args }),
    })),
    checkpoints: journey.checkpoints,
    cleanup: journey.cleanup,
  };
}

export function journeyFingerprint(journey) {
  return createHash('sha256')
    .update(JSON.stringify(normalizeSemanticContract(journey)))
    .digest('hex');
}

export function validateRegistry(registry) {
  const failures = [];
  if (!isRecord(registry)) return ['registry must be an object'];
  if (registry.schemaVersion !== 1) failures.push('schemaVersion must equal 1');
  if (!isRecord(registry.scoring)) {
    failures.push('scoring must be an object');
  } else {
    for (const key of scoringKeys) {
      if (!Number.isSafeInteger(registry.scoring[key]) || registry.scoring[key] < 0) {
        failures.push(`scoring.${key} must be a non-negative integer`);
      }
    }
  }
  if (!Array.isArray(registry.journeys) || registry.journeys.length === 0) {
    failures.push('journeys must be a non-empty array');
    return failures;
  }

  const ids = new Map();
  const fingerprints = new Map();
  for (const [index, journey] of registry.journeys.entries()) {
    const path = `journeys[${index}]`;
    if (!isRecord(journey)) {
      failures.push(`${path} must be an object`);
      continue;
    }
    requireString(journey.id, `${path}.id`, failures);
    if (typeof journey.id === 'string' && !/^LODY-[A-Z0-9-]+-\d{3}$/u.test(journey.id)) {
      failures.push(`${path}.id must match LODY-AREA-NNN`);
    }
    if (ids.has(journey.id)) failures.push(`${path}.id duplicates ${ids.get(journey.id)}`);
    else ids.set(journey.id, path);
    if (!states.has(journey.state)) failures.push(`${path}.state is unsupported`);
    if (!priorities.has(journey.priority)) failures.push(`${path}.priority is unsupported`);
    if (!runtimes.has(journey.runtime)) failures.push(`${path}.runtime is unsupported`);
    requireString(journey.title, `${path}.title`, failures);
    requireString(journey.owner, `${path}.owner`, failures);
    requireString(journey.fixture, `${path}.fixture`, failures);
    requireStringArray(journey.ownerPaths, `${path}.ownerPaths`, failures);
    requireStringArray(journey.checkpoints, `${path}.checkpoints`, failures);
    requireStringArray(journey.cleanup, `${path}.cleanup`, failures);

    if (!Array.isArray(journey.actions) || journey.actions.length === 0) {
      failures.push(`${path}.actions must be a non-empty array`);
    } else {
      for (const [actionIndex, action] of journey.actions.entries()) {
        if (!isRecord(action)) {
          failures.push(`${path}.actions[${actionIndex}] must be an object`);
          continue;
        }
        requireString(action.id, `${path}.actions[${actionIndex}].id`, failures);
      }
    }

    if (!isRecord(journey.coverage)) {
      failures.push(`${path}.coverage must be an object`);
    } else {
      for (const key of coverageKeys) {
        requireString(journey.coverage[key], `${path}.coverage.${key}`, failures);
      }
    }
    if (!isRecord(journey.signals)) {
      failures.push(`${path}.signals must be an object`);
    } else {
      for (const key of signalKeys) {
        if (
          !Number.isSafeInteger(journey.signals[key]) ||
          journey.signals[key] < 1 ||
          journey.signals[key] > 5
        ) {
          failures.push(`${path}.signals.${key} must be an integer from 1 through 5`);
        }
      }
      if (typeof journey.signals.escapedDefect !== 'boolean') {
        failures.push(`${path}.signals.escapedDefect must be a boolean`);
      }
    }
    if (!Number.isSafeInteger(journey.estimatedMinutes) || journey.estimatedMinutes < 1) {
      failures.push(`${path}.estimatedMinutes must be a positive integer`);
    }
    if (
      !Number.isSafeInteger(journey.freshness) ||
      journey.freshness < 1 ||
      journey.freshness > 5
    ) {
      failures.push(`${path}.freshness must be an integer from 1 through 5`);
    }
    requireStringArray(journey.scoutJourneys, `${path}.scoutJourneys`, failures, true);
    if (journey.blockedReason !== null && typeof journey.blockedReason !== 'string') {
      failures.push(`${path}.blockedReason must be null or a string`);
    }

    if (journey.state === 'active') {
      requireString(journey.feature, `${path}.feature`, failures);
    } else {
      requireString(journey.gap, `${path}.gap`, failures);
      requireStringArray(journey.evidence, `${path}.evidence`, failures);
    }

    if (Array.isArray(journey.actions) && journey.actions.length > 0) {
      const fingerprint = journeyFingerprint(journey);
      if (journey.fingerprint !== fingerprint) {
        failures.push(
          `${path}.fingerprint must equal the computed semantic fingerprint ${fingerprint}`
        );
      }
      const duplicate = fingerprints.get(fingerprint);
      if (duplicate) failures.push(`${path} duplicates the semantic contract of ${duplicate}`);
      else fingerprints.set(fingerprint, `${path} (${journey.id})`);
    }
  }
  return failures;
}

export function loadJourneyRegistry(path = defaultRegistryPath) {
  const registry = JSON.parse(readFileSync(path, 'utf8'));
  const failures = validateRegistry(registry);
  if (failures.length > 0) {
    throw new Error(`Journey registry is invalid:\n- ${failures.join('\n- ')}`);
  }
  return registry;
}

function markdownCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');
}

function markdownTable(headers, rows, rightAligned = new Set()) {
  const cells = [headers, ...rows].map((row) => row.map(markdownCell));
  const widths = headers.map((_, column) => Math.max(3, ...cells.map((row) => row[column].length)));
  const row = (values) =>
    `| ${values
      .map((value, column) =>
        rightAligned.has(column) ? value.padStart(widths[column]) : value.padEnd(widths[column])
      )
      .join(' | ')} |`;
  const separator = widths.map((width, column) =>
    rightAligned.has(column) ? `${'-'.repeat(width - 1)}:` : '-'.repeat(width)
  );
  return [row(cells[0]), row(separator), ...cells.slice(1).map(row)];
}

export function renderCoverage(registry) {
  const active = registry.journeys
    .filter((journey) => journey.state === 'active')
    .sort(
      (left, right) =>
        left.priority.localeCompare(right.priority) || left.id.localeCompare(right.id)
    );
  const backlog = registry.journeys
    .filter((journey) => journey.state === 'backlog')
    .sort((left, right) => left.id.localeCompare(right.id));
  const lines = [
    '# Desktop journey coverage',
    '',
    'This file is generated from [`journeys/registry.json`](./journeys/registry.json).',
    'Run `pnpm --filter @lody/e2e journey:coverage` after changing the registry.',
    '',
    'The active matrix records product boundaries exercised by implemented scenarios.',
    'Backlog rows are evidence-backed gaps, not executable or promised scenarios.',
    '',
  ];

  for (const priority of ['P0', 'P1']) {
    const journeys = active.filter((journey) => journey.priority === priority);
    lines.push(`## Active ${priority} journeys`, '');
    lines.push(
      ...markdownTable(
        [
          'Stable id',
          'Journey',
          'Renderer',
          'Electron / IPC',
          'Bundled CLI',
          'Durable state',
          'External wire',
        ],
        journeys.map((journey) => [
          `\`${journey.id}\``,
          journey.title,
          journey.coverage.renderer,
          journey.coverage.electronIpc,
          journey.coverage.bundledCli,
          journey.coverage.durableState,
          journey.coverage.externalWire,
        ])
      )
    );
    lines.push('');
  }

  lines.push(
    '## Evidence-backed backlog',
    '',
    ...markdownTable(
      [
        'Stable id',
        'Priority',
        'Owner',
        'Freshness',
        'Proposed journey',
        'Estimated minutes',
        'Status',
        'Gap',
      ],
      backlog.map((journey) => [
        `\`${journey.id}\``,
        journey.priority,
        journey.owner,
        `${journey.freshness}/5`,
        journey.title,
        journey.estimatedMinutes,
        journey.blockedReason ? `Blocked: ${journey.blockedReason}` : 'Eligible',
        journey.gap,
      ]),
      new Set([3, 5])
    )
  );
  lines.push(
    '',
    'Candidate selection is deterministic and returns at most one backlog row per run.',
    'Scout may provide evidence for a narrow candidate, but it does not maintain a second journey implementation.',
    ''
  );
  return lines.join('\n');
}

function normalizePath(path) {
  return path.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
}

export function ownerPathMatches(ownerPath, changedPath) {
  const owner = normalizePath(ownerPath);
  const changed = normalizePath(changedPath);
  return owner.endsWith('/') ? changed.startsWith(owner) : changed === owner;
}

function normalizeSelectionInputs(inputs) {
  if (Array.isArray(inputs)) {
    return { changedFiles: inputs, escapedDefectIds: [], scoutJourneys: [] };
  }
  return {
    changedFiles: inputs.changedFiles ?? [],
    escapedDefectIds: inputs.escapedDefectIds ?? [],
    scoutJourneys: inputs.scoutJourneys ?? [],
  };
}

export function scoreJourney(journey, scoring, inputs = {}) {
  const normalizedInputs = normalizeSelectionInputs(inputs);
  const changedPathMatch = normalizedInputs.changedFiles.some((changedPath) =>
    journey.ownerPaths.some((ownerPath) => ownerPathMatches(ownerPath, changedPath))
  );
  const escapedDefectMatch =
    journey.signals.escapedDefect || normalizedInputs.escapedDefectIds.includes(journey.id);
  const scoutSignalMatch = normalizedInputs.scoutJourneys.some((scoutJourney) =>
    journey.scoutJourneys.includes(scoutJourney)
  );
  const breakdown = {
    criticality: journey.signals.criticality * scoring.criticality,
    boundaryRisk: journey.signals.boundaryRisk * scoring.boundaryRisk,
    changeFrequency: journey.signals.changeFrequency * scoring.changeFrequency,
    freshness: journey.freshness * scoring.freshness,
    escapedDefect: escapedDefectMatch ? scoring.escapedDefect : 0,
    scoutSignal: scoutSignalMatch ? scoring.scoutSignal : 0,
    changedPath: changedPathMatch ? scoring.changedPath : 0,
    estimatedMinutePenalty: -journey.estimatedMinutes * scoring.estimatedMinutePenalty,
  };
  return {
    score: Object.values(breakdown).reduce((total, value) => total + value, 0),
    changedPathMatch,
    escapedDefectMatch,
    scoutSignalMatch,
    breakdown,
  };
}

export function selectJourneyCandidate(registry, inputs = {}) {
  const activeFingerprints = new Set(
    registry.journeys
      .filter((journey) => journey.state === 'active')
      .map((journey) => journeyFingerprint(journey))
  );
  const seenBacklog = new Set();
  const skippedBlocked = [];
  const skippedDuplicates = [];
  const ranked = [];
  const backlog = registry.journeys
    .filter((journey) => journey.state === 'backlog')
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const journey of backlog) {
    if (journey.blockedReason) {
      skippedBlocked.push({ id: journey.id, reason: journey.blockedReason });
      continue;
    }
    const fingerprint = journeyFingerprint(journey);
    if (activeFingerprints.has(fingerprint) || seenBacklog.has(fingerprint)) {
      skippedDuplicates.push({ id: journey.id, fingerprint });
      continue;
    }
    seenBacklog.add(fingerprint);
    ranked.push({
      id: journey.id,
      title: journey.title,
      priority: journey.priority,
      fingerprint,
      owner: journey.owner,
      freshness: journey.freshness,
      ...scoreJourney(journey, registry.scoring, inputs),
    });
  }
  ranked.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return {
    selected: ranked[0] ?? null,
    considered: ranked.length,
    ranked,
    skippedBlocked,
    skippedDuplicates,
  };
}

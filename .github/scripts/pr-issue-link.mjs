const RELATED_ISSUE_HEADING = '## Related issue';
const CLOSING_KEYWORD = /^(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)$/i;
const REFERENCE_KEYWORD = /^(?:refs?|references?)$/i;
const KEYWORD_PREFIX = /^(?<keyword>[a-z]+)\s*:?\s+(?<reference>.+)$/i;
const FULL_ISSUE_URL = /^https:\/\/github\.com\/LodyAI\/Lody\/issues\/(?<number>[1-9]\d*)\/?$/i;
const SHORT_ISSUE_REFERENCE = /^(?:LodyAI\/Lody)?#(?<number>[1-9]\d*)$/i;

function relatedIssueSectionRange(lines) {
  const start = lines.findIndex((line) => line.trimEnd() === RELATED_ISSUE_HEADING);
  if (start === -1) {
    return null;
  }

  const next = lines.findIndex((line, index) => index > start && /^##(?:\s|$)/.test(line));
  return { start: start + 1, end: next === -1 ? lines.length : next };
}

function parseReference(value) {
  const match = value.match(FULL_ISSUE_URL) ?? value.match(SHORT_ISSUE_REFERENCE);
  return match ? Number(match.groups.number) : null;
}

function parseIssueLine(line) {
  const match = line.match(/^(?<prefix>\s*(?:[-*]\s+)?)(?<content>.*?)(?<suffix>\s*)$/);
  let content = match.groups.content;
  let keyword = null;
  const keywordMatch = content.match(KEYWORD_PREFIX);
  if (keywordMatch) {
    const candidate = keywordMatch.groups.keyword;
    if (CLOSING_KEYWORD.test(candidate) || REFERENCE_KEYWORD.test(candidate)) {
      keyword = candidate;
      content = keywordMatch.groups.reference;
    }
  }

  const issueNumber = parseReference(content);
  if (issueNumber == null) {
    return null;
  }
  return {
    prefix: match.groups.prefix,
    suffix: match.groups.suffix,
    keyword,
    issueNumber,
    isShortReference: SHORT_ISSUE_REFERENCE.test(content),
  };
}

export function hasRelatedIssueLink(body) {
  const lines = (body ?? '').split(/\r?\n/);
  const range = relatedIssueSectionRange(lines);
  return Boolean(range && lines.slice(range.start, range.end).some(parseIssueLine));
}

export function normalizeRelatedIssueLink(body) {
  const source = body ?? '';
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const range = relatedIssueSectionRange(lines);
  if (!range) {
    return source;
  }

  let changed = false;
  for (let index = range.start; index < range.end; index += 1) {
    const parsed = parseIssueLine(lines[index]);
    if (!parsed) {
      continue;
    }

    if (parsed.keyword && parsed.isShortReference) {
      continue;
    }
    const keyword = parsed.keyword ?? 'Closes';
    lines[index] = `${parsed.prefix}${keyword} #${parsed.issueNumber}${parsed.suffix}`;
    changed = true;
  }

  return changed ? lines.join(newline) : source;
}

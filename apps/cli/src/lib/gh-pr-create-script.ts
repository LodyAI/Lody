/** Standalone code embedded in the managed gh shim (no runtime dependencies). */
export const ghPrCreateScript = String.raw`
const createPrViaRest = async (ghCommand, target, parsed, env) => {
  const values = parsed.values;
  const flags = parsed.booleans;
  const supportedValues = new Set(['repo', 'title', 'body', 'body-file', 'base', 'head', 'label', 'assignee', 'reviewer', 'milestone', 'project']);
  const supportedFlags = new Set(['draft', 'no-maintainer-edit', 'dry-run', 'help']);
  if (Object.keys(values).some(key => !supportedValues.has(key)) ||
      Object.keys(flags).some(key => flags[key] && !supportedFlags.has(key))) return null;
  const last = key => values[key]?.at(-1);
  if (!last('title')?.trim() ||
      (values.body === undefined && values['body-file'] === undefined) ||
      (values.body !== undefined && values['body-file'] !== undefined)) return null;
  let head = last('head');
  let base = last('base');
  const read = async (command, args) => {
    const result = await runGhCommand(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    return !result.error && result.status === 0 ? result.stdout.trim() : null;
  };
  if (!head || !base) {
    const branch = await read('git', ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!head) {
      if (!branch) return null;
      const tip = await read('git', ['rev-parse', '--verify', 'HEAD']);
      const published = await read(ghCommand, ['api', '--hostname', 'github.com',
        'repos/' + target.repo + '/git/ref/heads/' + encodeURIComponent(branch), '--jq', '.object.sha']);
      // Only infer a head that is already published in this exact target repo.
      // Native gh owns push/fork/upstream inference for every other case.
      if (!tip || tip !== published) return null;
      head = branch;
    }
    if (!base) {
      base = (branch && await read('git', ['config', '--get', 'branch.' + branch + '.gh-merge-base'])) ||
        await read(ghCommand, ['api', '--hostname', 'github.com', 'repos/' + target.repo, '--jq', '.default_branch']);
      if (!base) return null;
    }
  }
  let body = last('body');
  if (values['body-file']) {
    try { body = fs.readFileSync(last('body-file') === '-' ? 0 : last('body-file'), 'utf8'); }
    catch { console.error('[Lody GitHub] Cannot read PR body file; no PR was created.'); return 1; }
  }
  const payload = { title: last('title'), body, head, base,
    draft: flags.draft === true, maintainer_can_modify: flags['no-maintainer-edit'] !== true };
  if (flags['dry-run']) {
    process.stdout.write(JSON.stringify({ repository: target.repo, ...payload }) + '\n');
    return 0;
  }
  // Native gh supplies transport/proxy configuration. Raw fields keep Markdown,
  // @file prefixes and {owner}/{repo} text literal. No token is written to disk.
  const createArgs = ['api', '--hostname', 'github.com', '--method', 'POST',
    'repos/' + target.repo + '/pulls', '--jq', '{number,html_url}'];
  for (const [key, value] of Object.entries(payload))
    createArgs.push(typeof value === 'boolean' ? '-F' : '-f', key + '=' + value);
  const created = await runGhCommand(ghCommand, createArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (created.stderr) process.stderr.write(created.stderr);
  if (created.error || created.status !== 0) {
    console.error('[Lody GitHub] PR creation failed or its outcome is unknown. Check existing PRs before retrying; no identity fallback was attempted.');
    return created.status || 1;
  }
  let pr;
  try { pr = JSON.parse(created.stdout); } catch { /* An uncertain response must never replay creation. */ }
  const expectedUrl = 'https://github.com/' + target.repo + '/pull/';
  if (!Number.isSafeInteger(pr?.number) || pr.number <= 0 ||
      typeof pr.html_url !== 'string' || pr.html_url.toLowerCase() !== (expectedUrl + pr.number).toLowerCase()) {
    console.error('[Lody GitHub] PR creation returned an unexpected response. Check existing PRs before retrying; no identity fallback was attempted.');
    return 1;
  }
  // Publish the durable result before any optional follow-up can fail.
  process.stdout.write(pr.html_url + '\n');
  const editArgs = ['pr', 'edit', String(pr.number), '--repo', target.repo];
  for (const [key, flag] of Object.entries({ label: '--add-label', assignee: '--add-assignee',
    reviewer: '--add-reviewer', milestone: '--milestone', project: '--add-project' }))
    for (const value of values[key] || []) editArgs.push(flag, value);
  if (editArgs.length === 5) return 0;
  // Use exactly the already-selected credential, never invoke the shim again.
  const edited = await runGhCommand(ghCommand, editArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (edited.stderr) process.stderr.write(edited.stderr);
  if (edited.error || edited.status !== 0) {
    console.error('[Lody GitHub] PR was created, but metadata update failed. Edit the existing PR above; do not run create again.');
    return edited.status || 1;
  }
  return 0;
};
`;

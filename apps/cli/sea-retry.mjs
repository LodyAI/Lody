import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SEA_FREEZE_STEP = 'Freeze signed platform artifact';

/** A retry may rebuild only a platform that has never crossed its freeze boundary. */
export function selectDaemonBuildArtifact({ artifacts, jobs, artifactName, jobName, runAttempt }) {
  if (
    !Array.isArray(artifacts) ||
    !Array.isArray(jobs) ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1
  ) {
    throw new Error('Invalid daemon retry evidence');
  }
  const matches = artifacts.filter((artifact) => artifact.name === artifactName);
  if (matches.length > 1 || matches.some((artifact) => artifact.expired))
    throw new Error('Ambiguous or expired SEA artifact');
  if (matches.length === 1) {
    if (!Number.isSafeInteger(matches[0].id) || matches[0].id < 1)
      throw new Error('Invalid frozen SEA artifact identity');
    return matches[0].id;
  }
  if (runAttempt === 1) return 0;
  const platformJobs = jobs.filter(
    (job) => job.name === jobName || job.name.endsWith(` / ${jobName}`)
  );
  for (let attempt = 1; attempt < runAttempt; attempt++) {
    if (!jobs.some((job) => job.run_attempt === attempt))
      throw new Error(
        'Prior run attempt unavailable; cannot prove that SEA bytes were never frozen'
      );
  }
  for (const job of platformJobs) {
    if (!Number.isSafeInteger(job.run_attempt) || !Array.isArray(job.steps))
      throw new Error('Incomplete daemon freeze history');
    if (job.run_attempt >= runAttempt) continue;
    if (
      job.conclusion === 'success' ||
      job.steps.some((step) => step.name === SEA_FREEZE_STEP && step.conclusion === 'success')
    ) {
      throw new Error(
        'Previously frozen SEA artifact is missing; require the original bytes or a fresh version'
      );
    }
    if (
      !['failure', 'cancelled', 'timed_out', 'startup_failure', 'skipped'].includes(job.conclusion)
    ) {
      throw new Error('Prior daemon build has no confirmed pre-freeze failure');
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const id = selectDaemonBuildArtifact({
    artifacts: JSON.parse(fs.readFileSync(process.argv[2], 'utf8')),
    jobs: JSON.parse(fs.readFileSync(process.argv[3], 'utf8')),
    artifactName: process.env.ARTIFACT_NAME,
    jobName: process.env.DAEMON_BUILD_JOB_NAME,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  });
  console.log(`id=${id}`);
}

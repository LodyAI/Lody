/* eslint-disable no-unused-expressions -- The CLI reads this function expression as a program. */
// Registration binds the current Session; the Host supplies trusted current-HEAD observations.
async ({ ctx }) => {
  const { value } = await ctx.read('github.workflowRuns');
  if (value.status !== 'observed') return false;
  const failed = value.pullRequests.flatMap((pr) =>
    pr.runs.filter((run) => run.status === 'completed' && run.conclusion === 'failure')
  );
  if (!failed.length) return false;
  return {
    resumeText: 'CI failed. Inspect these runs and continue fixing the current task.',
    payload: failed,
  };
};

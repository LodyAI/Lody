/* eslint-disable no-unused-expressions -- The CLI reads this function expression as a program. */
// Event names and the readiness predicate are ordinary JavaScript, not a Host condition enum.
async ({ ctx }) => {
  const { value: events } = await ctx.read('events', { limit: 50 });
  const result = events.find(
    (event) => event.type === 'build.result' && event.data.status === 'ready'
  );
  if (!result || result.data.failedTests > 0) return false;
  return { resumeText: 'Build result ready; continue the current task.', payload: result.data };
};

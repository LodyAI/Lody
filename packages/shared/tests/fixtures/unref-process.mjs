// A long-lived child is unrefed: merely awaiting its exit through the facade
// must not hold the launching Node process open. It stays in the launcher's
// process group so the test can always clean up the group.
const { startProcess } = await import(process.argv[2]);
const handle = startProcess({
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 10000)'],
  options: { stdio: 'ignore' },
  processGroup: false,
});
if (!handle.child.pid) throw new Error('Child did not start');
handle.child.unref();
process.stdout.write(`${handle.child.pid}\n`);

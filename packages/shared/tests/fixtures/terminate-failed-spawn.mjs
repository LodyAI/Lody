// Starts a command that cannot spawn and terminates it in the same tick, before
// Node reports the failure. Run in its own process group: a regression signals
// that whole group (pid 0), which this script observes as its own SIGTERM.
const { startProcessLegacy } = await import(process.argv[2]);

process.on('SIGTERM', () => {
  console.log('own-group-signalled');
  process.exit(3);
});
await Promise.resolve();
const handle = startProcessLegacy({
  command: '/nonexistent/lody-no-such-binary',
  args: [],
  options: { stdio: 'ignore' },
  processGroup: false,
});
handle.child.on('error', () => {});
await handle.terminate({ graceMs: 1000, killWaitMs: 1000 });
console.log('survived');

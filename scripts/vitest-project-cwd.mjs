// Recursive pnpm tests run inside each package. Preserve that working directory
// for fixtures spawning `node --import tsx` and for package-relative paths.
process.chdir(process.env.LODY_TEST_PROJECT_ROOT);

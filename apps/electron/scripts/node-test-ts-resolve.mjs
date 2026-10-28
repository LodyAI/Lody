// `node --test` loads TypeScript sources directly with type stripping, which
// resolves relative imports exactly as written. The shared package writes them
// without extensions, as the bundler that builds the app expects, so a module
// importing a sibling (`../project-path`) cannot load under the test runner.
// This hook resolves such an import the way the bundler does, and nothing else.
import { register } from 'node:module'

register('./node-test-ts-resolve-hooks.mjs', import.meta.url)

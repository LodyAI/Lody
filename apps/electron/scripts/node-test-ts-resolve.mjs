// Synchronous hooks avoid a loader worker and preserve native source loading.
import { registerHooks } from 'node:module'
import { resolve, load } from './node-test-ts-resolve-hooks.mjs'

registerHooks({ resolve, load })

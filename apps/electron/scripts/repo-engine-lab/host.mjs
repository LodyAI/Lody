// Synthetic P0 host only. Not imported by any product composition.
import { startEngine, engineVersion } from '@loro-dev/loro-repo-engine'

const engine = startEngine({ dataDir: process.argv[2] })
process.send?.({ type: 'ready', endpoint: engine.endpoint, version: engineVersion() })
const close = () => {
  engine.stop()
  process.disconnect?.()
}
process.on('message', (message) => {
  if (message?.type === 'stop') close()
})
process.once('disconnect', () => engine.stop())

import { useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import { languageAtom } from '@lody/components/atoms/settings'
import { resources } from '@lody/components/i18n'
import { Button } from '@lody/components/ui/button'
import { getIpcServices } from '@lody/components/lib/electron-ipc-client'
import { authClient } from './auth'

/** Local identity preparation only. No Org authorization or backup-complete claim. */
export function DeviceIdentityInitializer() {
  const { data } = authClient.useSession()
  const userId = data?.user?.id
  if (userId === undefined || userId === '') return null
  return <AccountDeviceInitialization key={userId} />
}

function AccountDeviceInitialization() {
  const language = useAtomValue(languageAtom)
  const text = resources[language]?.translation ?? resources.en.translation
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<'checking' | 'ready' | 'failed'>('checking')
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    let active = true
    void Promise.resolve()
      .then(() => {
        const services = getIpcServices()
        if (!services) throw new Error('device-identity-bridge-unavailable')
        return services.auth.initializeDeviceIdentity()
      })
      .then(() => {
        if (active) setPhase('ready')
      })
      .catch(() => {
        if (active) setPhase('failed')
      })
    return () => {
      active = false
    }
  }, [attempt])
  if (dismissed || phase === 'ready' || (phase === 'checking' && attempt === 0)) return null
  return (
    <aside
      className="fixed bottom-4 right-4 z-[100] w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-background p-4 text-foreground shadow-lg"
      aria-label={text['e2ee.device.unavailable']}
    >
      <div role="status" aria-live="polite">
        <p className="text-sm font-medium">
          {phase === 'checking' ? text['e2ee.device.preparing'] : text['e2ee.device.unavailable']}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{text['e2ee.device.retryHint']}</p>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
          {text['common.close']}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={phase === 'checking'}
          onClick={() => {
            setPhase('checking')
            setAttempt((value) => value + 1)
          }}
        >
          {text['common.retry']}
        </Button>
      </div>
    </aside>
  )
}

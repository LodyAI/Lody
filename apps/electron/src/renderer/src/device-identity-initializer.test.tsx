import { act } from 'react'
import { createStore, Provider } from 'jotai'
import { languageAtom } from '@lody/components/atoms/settings'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DeviceIdentityInitializer } from './device-identity-initializer'

const state = vi.hoisted(() => ({
  user: 'alice',
  pending: [] as Array<{ resolve(): void; reject(): void }>
}))
vi.mock('./auth', () => ({
  authClient: { useSession: () => ({ data: { user: { id: state.user } } }) }
}))
vi.mock('@lody/components/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({
    auth: {
      initializeDeviceIdentity: () =>
        new Promise<void>((resolve, reject) => {
          state.pending.push({
            resolve,
            reject: () => reject(new Error('synthetic private error'))
          })
        })
    }
  })
}))
vi.mock('@lody/components/i18n', async () => ({
  resources: {
    en: { translation: (await import('../../../../../locales/en.json')).default },
    zh_CN: { translation: (await import('../../../../../locales/zh_CN.json')).default }
  }
}))

let container: HTMLDivElement
let root: Root
let store: ReturnType<typeof createStore>
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  state.user = 'alice'
  state.pending = []
  store = createStore()
  store.set(languageAtom, 'en')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
async function render() {
  await act(async () =>
    root.render(
      <Provider store={store}>
        <DeviceIdentityInitializer />
      </Provider>
    )
  )
}
function button(label: string) {
  const result = Array.from(container.querySelectorAll('button')).find(
    (element) => element.textContent === label
  )
  expect(result).toBeDefined()
  return result!
}

it('shows a safe failure, disables duplicate retries, and hides on success', async () => {
  await render()
  expect(container.querySelector('aside')).toBeNull()
  await act(async () => state.pending[0]!.reject())
  expect(container.textContent).toContain('Device encryption is unavailable')
  expect(container.textContent).not.toContain('synthetic private error')
  await act(async () => button('Retry').click())
  expect(button('Retry').disabled).toBe(true)
  expect(container.textContent).toContain('Preparing device encryption')
  await act(async () => button('Retry').click())
  expect(state.pending).toHaveLength(2)
  await act(async () => state.pending[1]!.resolve())
  expect(container.querySelector('aside')).toBeNull()
})

it('dismisses the notice without retrying or reinitializing on an ordinary rerender', async () => {
  await render()
  await act(async () => state.pending[0]!.reject())
  await act(async () => button('Close').click())
  await render()
  expect(container.querySelector('aside')).toBeNull()
  expect(state.pending).toHaveLength(1)
})

it('changes failure and retry labels with the selected language without another initialization', async () => {
  await render()
  await act(async () => state.pending[0]!.reject())
  await act(async () => {
    store.set(languageAtom, 'zh_CN')
  })
  expect(container.querySelector('aside')?.getAttribute('aria-label')).toBe('本机加密功能暂不可用')
  expect(container.textContent).toContain('现有密钥不会被重置')
  expect(button('重试').disabled).toBe(false)
  expect(state.pending).toHaveLength(1)
  await act(async () => button('重试').click())
  expect(container.textContent).toContain('正在准备本机加密')
  expect(button('重试').disabled).toBe(true)
  await act(async () => state.pending[1]!.reject())
  expect(button('重试').disabled).toBe(false)
  await act(async () => button('关闭').click())
  expect(container.querySelector('aside')).toBeNull()
})

it('does not let an old account success hide the new account failure', async () => {
  await render()
  state.user = 'bob'
  await render()
  await act(async () => state.pending[1]!.reject())
  await act(async () => state.pending[0]!.resolve())
  expect(container.textContent).toContain('Device encryption is unavailable')
  state.user = ''
  await render()
  expect(container.querySelector('aside')).toBeNull()
})

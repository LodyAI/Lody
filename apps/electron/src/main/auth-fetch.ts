type DesktopAuthTransport = {
  whenReady: () => Promise<unknown>
  fetch: (input: string | Request, init?: RequestInit) => Promise<Response>
}

// Keep Better Auth's response/cookie hooks and AbortSignal intact while using
// Electron's Chromium transport, which honors system proxy and certificate trust.
export function createDesktopAuthFetch(transport: DesktopAuthTransport): typeof fetch {
  return async (input, init) => {
    await transport.whenReady()
    const signal =
      init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined
    signal?.throwIfAborted()
    return transport.fetch(input instanceof URL ? input.toString() : input, init)
  }
}

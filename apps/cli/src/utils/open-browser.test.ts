import { describe, expect, it } from 'vitest';

import { buildOpenBrowserCommand } from './open-browser';

describe('buildOpenBrowserCommand', () => {
  const url = 'https://example.com/device?code=A&b=(1)%20x';

  it('passes the URL as one untouched argument on every platform', () => {
    expect(buildOpenBrowserCommand(url, 'darwin')).toEqual({ command: 'open', args: [url] });
    expect(buildOpenBrowserCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] });
    // No cmd.exe in between, so `&`, `(` and `%` need no escaping.
    expect(buildOpenBrowserCommand(url, 'win32')).toEqual({
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', url],
    });
  });
});

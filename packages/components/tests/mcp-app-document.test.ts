// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  buildMcpAppContentSecurityPolicy,
  buildMcpAppDocument,
  selectMcpAppHtml,
} from '../src/components/ai-gui/mcp-app/mcp-app-document';

const directive = (policy: string, name: string) =>
  policy
    .split(';')
    .map((part) => part.trim().split(/\s+/u))
    .find(([directiveName]) => directiveName === name)
    ?.slice(1);

describe('MCP App content security policy', () => {
  it('grants nothing beyond inline code and data: media when the resource declares no CSP', () => {
    const policy = buildMcpAppContentSecurityPolicy(undefined);
    expect(directive(policy, 'default-src')).toEqual(["'none'"]);
    expect(directive(policy, 'script-src')).toEqual(["'unsafe-inline'"]);
    expect(directive(policy, 'style-src')).toEqual(["'unsafe-inline'"]);
    expect(directive(policy, 'img-src')).toEqual(['data:']);
    expect(directive(policy, 'font-src')).toEqual(['data:']);
    expect(directive(policy, 'connect-src')).toEqual(["'none'"]);
    expect(directive(policy, 'frame-src')).toEqual(["'none'"]);
    expect(directive(policy, 'base-uri')).toEqual(["'none'"]);
    expect(directive(policy, 'object-src')).toEqual(["'none'"]);
    expect(directive(policy, 'form-action')).toEqual(["'none'"]);
  });

  it('drops every declared source that could widen the policy beyond one https origin', () => {
    const policy = buildMcpAppContentSecurityPolicy({
      connectDomains: [
        "https://api.example.com; script-src 'unsafe-eval'",
        'http://api.example.com',
        'https://*',
        'https://*.com',
        "'self'",
        '*',
        'data:',
        'https://api.example.com/path',
        'https://user@api.example.com',
        'https://api.example.com:99999',
        'ws://socket.example.com',
        'wss://*.com',
        42,
      ],
      resourceDomains: 'https://cdn.example.com',
      frameDomains: [' https://frame.example.com'],
    });
    expect(directive(policy, 'connect-src')).toEqual(["'none'"]);
    expect(directive(policy, 'frame-src')).toEqual(["'none'"]);
    expect(directive(policy, 'script-src')).toEqual(["'unsafe-inline'"]);
    expect(policy).not.toContain('unsafe-eval');
  });

  it('adds valid declared origins to exactly their directives', () => {
    const policy = buildMcpAppContentSecurityPolicy({
      connectDomains: ['https://API.example.com:8443', 'https://api.example.com:8443'],
      resourceDomains: ['https://*.cdn.example.com/'],
      frameDomains: ['https://embed.example.com'],
      baseUriDomains: ['https://base.example.com'],
    });
    expect(directive(policy, 'connect-src')).toEqual(['https://api.example.com:8443']);
    for (const name of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src']) {
      expect(directive(policy, name)).toContain('https://*.cdn.example.com');
    }
    expect(directive(policy, 'frame-src')).toEqual(['https://embed.example.com']);
    expect(directive(policy, 'base-uri')).toEqual(['https://base.example.com']);
    expect(directive(policy, 'connect-src')).not.toContain('https://*.cdn.example.com');
  });

  it('admits secure WebSocket origins to connect-src only', () => {
    const policy = buildMcpAppContentSecurityPolicy({
      connectDomains: [
        'wss://rt.example.com',
        'wss://*.example.com:8443',
        'ws://rt.example.com',
        'wss://*.com',
        'https://api.example.com',
      ],
      resourceDomains: ['wss://cdn.example.com', 'https://cdn.example.com'],
      frameDomains: ['wss://frame.example.com'],
      baseUriDomains: ['wss://base.example.com'],
    });
    expect(directive(policy, 'connect-src')).toEqual([
      'wss://rt.example.com',
      'wss://*.example.com:8443',
      'https://api.example.com',
    ]);
    for (const name of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src']) {
      expect(directive(policy, name)).toContain('https://cdn.example.com');
      expect(directive(policy, name)).not.toContain('wss://cdn.example.com');
    }
    expect(directive(policy, 'frame-src')).toEqual(["'none'"]);
    expect(directive(policy, 'base-uri')).toEqual(["'none'"]);
  });
});

describe('MCP App document', () => {
  it('puts the host policy ahead of every app node and removes refresh navigation', () => {
    const built = buildMcpAppDocument(
      `<!doctype html><html><head>
        <meta http-equiv="refresh" content="0;url=https://example.com">
        <script>window.first = true</script>
      </head><body><p id="app">App</p></body></html>`,
      undefined
    );
    const document = new DOMParser().parseFromString(built, 'text/html');
    const [policy, referrer, firstAppNode] = [...document.head.children];
    expect(policy?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(policy?.getAttribute('content')).toBe(buildMcpAppContentSecurityPolicy(undefined));
    expect(referrer?.getAttribute('content')).toBe('no-referrer');
    expect(firstAppNode?.tagName).toBe('SCRIPT');
    expect(document.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(document.getElementById('app')?.textContent).toBe('App');
  });
});

describe('MCP App resource selection', () => {
  it('prefers the MCP App profile and decodes a base64 UTF-8 blob', () => {
    const html = '<p>Grüße</p>';
    const blob = btoa(String.fromCharCode(...new TextEncoder().encode(html)));
    expect(
      selectMcpAppHtml([
        { uri: 'ui://a', mimeType: 'text/plain', text: 'nope' },
        { uri: 'ui://a', mimeType: 'text/html', text: '<p>plain html</p>' },
        {
          uri: 'ui://a',
          mimeType: 'text/html;profile=mcp-app',
          blob,
          _meta: { ui: { csp: { connectDomains: ['https://api.example.com'] } } },
        },
      ])
    ).toEqual({ html, csp: { connectDomains: ['https://api.example.com'] } });
  });

  it('accepts plain text/html and rejects non-HTML or undecodable contents', () => {
    expect(selectMcpAppHtml([{ uri: 'ui://a', mimeType: 'text/html', text: '<p>x</p>' }])).toEqual({
      html: '<p>x</p>',
      csp: undefined,
    });
    expect(selectMcpAppHtml([{ uri: 'ui://a', mimeType: 'application/json', text: '{}' }])).toBe(
      null
    );
    expect(selectMcpAppHtml([{ uri: 'ui://a', mimeType: 'text/html', blob: '%%%' }])).toBe(null);
    expect(selectMcpAppHtml(['junk', null])).toBe(null);
  });
});

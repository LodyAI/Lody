export function releaseRendererPolicy(sources) {
  return {
    name: 'lody-release-renderer-policy',
    enforce: 'pre',
    transformIndexHtml(html, context) {
      if (context.path.endsWith('/recovery.html') || context.path.endsWith('/pr-image.html'))
        return html;
      if (!/<meta\b(?=[^>]*http-equiv="Content-Security-Policy")[^>]*\bcontent="[^"]*"/i.test(html))
        throw new Error('Missing renderer policy');
      return html.replace(
        /(<meta\b(?=[^>]*http-equiv="Content-Security-Policy")[^>]*\bcontent=")([^"]*)(")/i,
        (all, before, policy, after) => {
          const directives = policy
            .split(';')
            .map((s) => s.trim().split(/\s+/))
            .filter((s) => s[0]);
          for (const [name, additions] of Object.entries(sources)) {
            const matches = directives.filter((d) => d[0] === name);
            if (matches.length !== 1) throw new Error('Missing or duplicate renderer directive');
            for (const source of additions)
              if (!matches[0].includes(source)) matches[0].push(source);
          }
          return before + directives.map((d) => d.join(' ')).join('; ') + ';' + after;
        }
      );
    },
  };
}

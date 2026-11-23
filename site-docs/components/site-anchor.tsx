import type { ComponentProps } from 'react';
import { siteHref } from '../lib/site-url.mjs';

/** Keep native navigation and handlers; only canonicalize site-owned page hrefs. */
export function SiteAnchor({ href, ...props }: ComponentProps<'a'>) {
  return (
    <a
      {...props}
      href={
        href === undefined || (props.download !== undefined && props.download !== false)
          ? href
          : siteHref(href)
      }
    />
  );
}

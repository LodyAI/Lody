import type { ComponentProps } from 'react';
import { appOwnedRel, siteHref } from '../lib/site-url.mjs';

/** Keep native navigation and handlers; canonicalize site-owned page hrefs and mark app-owned auth entrypoints nofollow. */
export function SiteAnchor({ href, rel, ...props }: ComponentProps<'a'>) {
  return (
    <a
      {...props}
      rel={appOwnedRel(href, rel)}
      href={
        href === undefined || (props.download !== undefined && props.download !== false)
          ? href
          : siteHref(href)
      }
    />
  );
}

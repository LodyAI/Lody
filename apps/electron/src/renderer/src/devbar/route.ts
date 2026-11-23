// The Devbar entry always runs hash history, so the product route lives in
// location.hash; location.pathname only ever names the HTML entry file.
export function devbarSampleRoute(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>
): string {
  if (location.hash.startsWith('#/')) return location.hash.slice(1)
  return `${location.pathname}${location.search}`
}

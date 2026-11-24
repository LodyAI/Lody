import type { WebContents } from 'electron'
import { LocalFileResources } from './local-file-resource'
import { LocalHtmlPreviewSites } from './local-html-preview'
import { releasePluginModules } from './plugin-module-store'

export const localFileResources = new LocalFileResources()
export const localHtmlPreviewSites = new LocalHtmlPreviewSites()

// Each document gets a distinct owner, including reloads to the same URL. A late
// response from the old document must never revoke a new document's resources.
const resourceOwners = new Map<number, number>()
let nextResourceOwner = 0
export function isCurrentResourceOwner(owner: WebContents, generation: number) {
  return !owner.isDestroyed() && resourceOwners.get(owner.id) === generation
}
export function getResourceOwner(owner: WebContents): number {
  const current = resourceOwners.get(owner.id)
  if (current !== undefined) return current
  const generation = ++nextResourceOwner
  resourceOwners.set(owner.id, generation)
  owner.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return
    const previous = resourceOwners.get(owner.id)
    if (previous !== undefined) releaseResources(previous)
    resourceOwners.set(owner.id, ++nextResourceOwner)
  })
  owner.once('destroyed', () => {
    const previous = resourceOwners.get(owner.id)
    if (previous !== undefined) releaseResources(previous)
    resourceOwners.delete(owner.id)
  })
  return generation
}

function releaseResources(generation: number) {
  releasePluginModules(generation)
  localFileResources.releaseOwner(generation)
  localHtmlPreviewSites.releaseOwner(generation)
}

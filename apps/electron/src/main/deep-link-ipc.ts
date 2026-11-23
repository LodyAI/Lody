import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { desktopInstallationProfile } from './platform'

type DeepLinkIpcRecord = {
  pid: number
  timestamp: number
  url: string
}

const IPC_FILE = path.join(
  os.tmpdir(),
  `${desktopInstallationProfile.desktopIpcNamespace}-deeplink-ipc.jsonl`
)
const POLL_INTERVAL_MS = 300
const PROCESS_STARTED_AT = Date.now()

function parseRecordLine(line: string): DeepLinkIpcRecord | null {
  if (!line.trim()) {
    return null
  }
  try {
    const parsed = JSON.parse(line) as Partial<DeepLinkIpcRecord>
    if (
      typeof parsed.url !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.timestamp !== 'number'
    ) {
      return null
    }
    return {
      url: parsed.url,
      pid: parsed.pid,
      timestamp: parsed.timestamp
    }
  } catch {
    return null
  }
}

export function publishDeepLinkToPrimary(url: string): void {
  const payload: DeepLinkIpcRecord = {
    pid: process.pid,
    timestamp: Date.now(),
    url
  }
  try {
    fs.appendFileSync(IPC_FILE, `${JSON.stringify(payload)}\n`, 'utf8')
  } catch {
    // best effort
  }
}

export function startDeepLinkIpcListener(onUrl: (url: string) => void): () => void {
  let processedLineCount = 0

  const processNewLines = (content: string) => {
    const lines = content.split(/\r?\n/).filter((line) => line.length > 0)
    if (processedLineCount > lines.length) {
      processedLineCount = 0
    }
    if (processedLineCount === lines.length) {
      return
    }

    for (let index = processedLineCount; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line) {
        continue
      }
      const record = parseRecordLine(line)
      if (!record || record.timestamp < PROCESS_STARTED_AT) {
        continue
      }
      onUrl(record.url)
    }

    processedLineCount = lines.length
  }

  const poll = () => {
    let content = ''
    try {
      content = fs.readFileSync(IPC_FILE, 'utf8')
    } catch {
      return
    }
    if (!content) {
      return
    }
    processNewLines(content)
  }

  try {
    const initialContent = fs.readFileSync(IPC_FILE, 'utf8')
    processedLineCount = initialContent.split(/\r?\n/).filter((line) => line.length > 0).length
  } catch {
    processedLineCount = 0
  }

  const timer = setInterval(poll, POLL_INTERVAL_MS)
  return () => {
    clearInterval(timer)
  }
}

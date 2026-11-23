import { useEffect, useRef, useState, type JSX } from 'react'
import { writeTextToClipboard } from '@lody/components/lib/clipboard'
import { startConversationCapture, type ConversationCaptureReport } from './conversation-capture'

export function ConversationCaptureControl(): JSX.Element {
  const active = useRef<ReturnType<typeof startConversationCapture> | null>(null)
  const [recording, setRecording] = useState(false)
  const [report, setReport] = useState<ConversationCaptureReport | null>(null)
  const [copyState, setCopyState] = useState('Copy capture')
  useEffect(() => () => active.current?.stop('unmounted'), [])
  return (
    <span className="desktop-devbar-capture">
      <button
        className="desktop-devbar-label"
        type="button"
        aria-pressed={recording}
        title="Start before entering the session. Records up to 60 seconds of list visibility, row geometry and long tasks locally, without message text. Does not clear session caches."
        onClick={() => {
          if (recording) {
            active.current?.stop()
            return
          }
          setReport(null)
          setCopyState('Copy capture')
          setRecording(true)
          active.current = startConversationCapture((result) => {
            if (result.ended?.reason === 'unmounted') return
            setRecording(false)
            setReport(result)
          })
        }}
      >
        {recording ? 'Stop capture' : 'Capture chat'}
      </button>
      <span role="status" className="desktop-devbar-capture-status">
        {recording
          ? 'Recording · open session now'
          : report
            ? `${report.summary.observations.rehidden ?? 0} re-hides · ${report.summary.observations['rows-empty'] ?? 0} empty · ${report.ended?.reason}`
            : ''}
      </span>
      {report && (
        <button
          className="desktop-devbar-label"
          type="button"
          onClick={() => {
            void writeTextToClipboard(JSON.stringify(report, null, 2)).then(
              (copied) => setCopyState(copied ? 'Copied' : 'Copy failed · retry'),
              () => setCopyState('Copy failed · retry')
            )
          }}
        >
          {copyState}
        </button>
      )}
    </span>
  )
}

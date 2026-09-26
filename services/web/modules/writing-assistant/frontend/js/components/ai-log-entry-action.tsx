/**
 * "Explain with AI" action shown in the header of error/warning entries in
 * the compile log. Sends the log entry (message + nearby source lines,
 * never the whole project) to the AI assistant via the controller event.
 */
import { useEditorViewContext } from '@/features/ide-react/context/editor-view-context'
import { AI_EVENT } from '../extensions/ai-selector'

const MAX_SOURCE_LINES = 12

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function AILogEntryAction({ logEntry }: { logEntry: any; id: string }) {
  const { view } = useEditorViewContext()

  if (!view || (logEntry?.level !== 'error' && logEntry?.level !== 'warning')) {
    return null
  }

  const explain = () => {
    const error = [logEntry.message, logEntry.content]
      .filter(Boolean)
      .join('\n')
    let sourceLines = ''
    if (logEntry.file && logEntry.line != null) {
      try {
        const doc = view.state.doc
        const lineNo = Math.min(Math.max(1, logEntry.line), doc.lines)
        const from = Math.max(1, lineNo - MAX_SOURCE_LINES / 2)
        const to = Math.min(doc.lines, lineNo + MAX_SOURCE_LINES / 2)
        const parts = []
        for (let i = from; i <= to; i++) {
          parts.push(`${i}: ${doc.line(i).text}`)
        }
        sourceLines = parts.join('\n')
      } catch {
        sourceLines = ''
      }
    }
    const pos = view.state.selection.main.head
    window.dispatchEvent(
      new CustomEvent(AI_EVENT, {
        detail: {
          action: 'compile-error',
          from: pos,
          to: pos,
          text: error,
          error,
          sourceLines,
        },
      })
    )
  }

  return (
    <button
      className="btn btn-link btn-xs log-entry-action-link"
      onClick={explain}
      title="Explain this error with the AI assistant"
    >
      <span className="material-symbols" aria-hidden="true" translate="no">
        auto_awesome
      </span>
      &nbsp;Explain
    </button>
  )
}

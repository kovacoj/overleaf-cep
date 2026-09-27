/**
 * AI assistant: selection tooltip in the source editor.
 *
 * When the user selects text and releases the mouse, a compact "AI" menu
 * appears at the selection. Choosing an action dispatches the window event
 * "editor:ai-assistant" with { action, from, to }; the React controller
 * (registered via mainEditorLayoutModals) opens the assistant modal, which
 * sends the request through the Overleaf backend using the user's own
 * e-INFRA API token. Nothing is sent to any LLM without an explicit click.
 */
import {
  EditorView,
  showTooltip,
  Tooltip,
  TooltipView,
} from '@codemirror/view'
import { Extension, StateEffect, StateField, Transaction } from '@codemirror/state'

type Options = Record<string, any>

const AI_EVENT = 'editor:ai-assistant'

const mouseDownEffect = StateEffect.define()
const mouseUpEffect = StateEffect.define()

const mouseDownStateField = StateField.define<boolean>({
  create() {
    return false
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(mouseDownEffect)) return true
      if (effect.is(mouseUpEffect)) return false
    }
    return value
  },
})

const aiTooltipStateField = StateField.define<Tooltip | null>({
  create() {
    return null
  },
  update(field, tr) {
    if (tr.docChanged) return null

    if (
      !tr.effects.some(effect => effect.is(mouseUpEffect)) &&
      tr.annotation(Transaction.userEvent) !== 'select' &&
      tr.annotation(Transaction.userEvent) !== 'select.pointer'
    ) {
      if (tr.selection) return null
      return field
    }

    if (tr.state.selection.main.empty) return null
    return buildTooltip(tr.state, tr.state.field(mouseDownStateField))
  },
  provide: field => [
    showTooltip.compute([field], state => state.field(field)),
  ],
})

function buildTooltip(state, hidden: boolean): Tooltip | null {
  const { to, head } = state.selection.main
  return {
    pos: head,
    above: head !== to,
    create: () => createAISelectorView(state.selection.main.from, to, hidden),
  }
}

const AI_ACTIONS: Array<{ action: string; label: string; title: string }> = [
  { action: 'improve', label: '✦', title: 'Improve academic English' },
  { action: 'concise', label: '⤡', title: 'Make concise' },
  { action: 'grammar', label: '✓', title: 'Fix grammar and style' },
  { action: 'translate', label: '🌐', title: 'Translate' },
  { action: 'explain', label: '?', title: 'Explain' },
  { action: 'review', label: 'Rev', title: 'Review paragraph' },
  { action: 'latex-fix', label: 'LaTeX', title: 'Fix LaTeX' },
  { action: 'latex-explain', label: 'TeX?', title: 'Explain LaTeX' },
  { action: 'equation', label: '∑', title: 'Generate equation from description' },
  { action: 'table', label: '▦', title: 'Generate table from description/CSV' },
  { action: 'custom', label: '…', title: 'Custom instruction' },
  { action: 'library-support', label: '📚', title: 'Support from my library' },
  { action: 'literature-search', label: '🔍', title: 'Find related papers (Crossref)' },
  { action: 'missing-citations', label: '⚑', title: 'Missing citations check' },
  { action: 'verify-citations', label: '✓c', title: 'Verify citations against library' },
]

function createAISelectorView(from: number, to: number, hidden: boolean): TooltipView {
  const dom = document.createElement('div')
  dom.className = 'ai-assistant-selector'
  dom.style.display = hidden ? 'none' : 'block'

  const label = document.createElement('span')
  label.className = 'ai-assistant-selector-label'
  label.textContent = 'AI'
  dom.appendChild(label)

  for (const item of AI_ACTIONS) {
    const button = document.createElement('button')
    button.className = 'ai-assistant-selector-button'
    button.textContent = item.label
    button.title = item.title
    button.addEventListener('mousedown', event => {
      event.preventDefault()
      window.dispatchEvent(
        new CustomEvent(AI_EVENT, { detail: { action: item.action, from, to } })
      )
    })
    dom.appendChild(button)
  }
  return { dom, overlap: true, offset: { x: 0, y: 8 } }
}

const aiSelectorTheme = EditorView.baseTheme({
  '.ai-assistant-selector': {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    padding: '3px 6px',
    borderRadius: '6px',
    fontSize: '13px',
    zIndex: 5,
  },
  '&light .ai-assistant-selector': {
    backgroundColor: '#ffffff',
    border: '1px solid #d9d9d9',
    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.12)',
  },
  '&dark .ai-assistant-selector': {
    backgroundColor: '#1b222c',
    border: '1px solid #3b4a5c',
    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.4)',
  },
  '.ai-assistant-selector-label': {
    fontWeight: 700,
    fontSize: '11px',
    opacity: 0.6,
    marginRight: '2px',
  },
  '.ai-assistant-selector-button': {
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    borderRadius: '4px',
    padding: '1px 5px',
    fontSize: '12px',
  },
  '.ai-assistant-selector-button:hover': {
    backgroundColor: '#2f6fed22',
  },
})

export const extension = (options: Options): Extension => {
  let mouseUpListener: null | (() => void) = null
  const disableMouseUpListener = () => {
    if (mouseUpListener) document.removeEventListener('mouseup', mouseUpListener)
  }

  return [
    aiSelectorTheme,
    mouseDownStateField,
    aiTooltipStateField,
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        disableMouseUpListener()
        mouseUpListener = () => {
          disableMouseUpListener()
          view.dispatch({ effects: mouseUpEffect.of(null) })
        }
        view.dispatch({ effects: mouseDownEffect.of(null) })
        document.addEventListener('mouseup', mouseUpListener)
      },
    }),
  ]
}

export { AI_EVENT }

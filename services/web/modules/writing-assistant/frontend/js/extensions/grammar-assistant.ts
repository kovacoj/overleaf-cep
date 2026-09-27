/**
 * Grammar/style checking in the source editor via the internal LanguageTool
 * service (proxied by the web backend at POST /user/writing/grammar).
 *
 * LaTeX-aware projection ("prose" view):
 *  - ranges covered by Comment / *Math* / Verbatim* nodes are excluded
 *    using the CodeMirror Lezer LaTeX syntax tree (not regex)
 *  - in the remaining text, commands with non-prose arguments (citations,
 *    labels, refs, urls, ...), environments, URLs and bibliography entries
 *    are masked by a line scanner
 *  - escaped characters and separators (~, &) are transformed with a
 *    parallel offsets array, giving an exact mapping between the projected
 *    text and CodeMirror document positions
 *
 * Checks are debounced (~1s), incremental (only uncached segment texts are
 * sent) and cached per text+language+mode. Suggestions render as
 * decorations with a hover tooltip (Replace / Ignore once).
 */
import {
  Decoration,
  DecorationSet,
  EditorView,
  hoverTooltip,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view'
import { EditorState, Extension, Range, StateEffect, StateField } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { postJSON } from '@/infrastructure/fetch-json'
import type { Text } from '@codemirror/state'

type Mode = 'off' | 'grammar' | 'style'

type LaSettings = { mode?: Mode; language?: string }

type GrammarMatch = {
  offset: number
  length: number
  message: string
  shortMessage?: string
  replacements: string[]
  ruleId: string
  category: string
  isStyle: boolean
}

type LaMatch = {
  from: number
  to: number
  message: string
  shortMessage?: string
  replacements: string[]
  ruleId: string
  category: string
  isStyle: boolean
}

type Segment = {
  chars: string[]
  offsets: number[]
}

type Options = { spellCheckLanguage?: string }

const SETTINGS_KEY = 'ol-writing-assistance'
const IGNORED_KEY = 'ol-writing-assistance-ignored'
const IGNORE_LIMIT = 200
const CACHE_LIMIT = 1000
const MIN_SEGMENT_LENGTH = 15
const DEBOUNCE_MS = 1000
const SETTINGS_EVENT = 'editor:writing-assistance-settings'

const settings = (): LaSettings => {
  try {
    return JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}')
  } catch {
    return {}
  }
}

const ignoredRules = (): Set<string> => {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(IGNORED_KEY) || '[]'))
  } catch {
    return {}
  }
}

const ignoreKey = (ruleId: string, text: string) => `${ruleId}\u0000${text}`

// ---------------------------------------------------------------------------
// LaTeX-aware prose projection
// ---------------------------------------------------------------------------

const SKIP_ENVIRONMENTS = new Set([
  'verbatim',
  'lstlisting',
  'minted',
  'math',
  'displaymath',
  'equation',
  'equation*',
  'align',
  'align*',
  'alignat',
  'alignat*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'eqnarray',
  'eqnarray*',
  'flalign',
  'flalign*',
  'split',
  'array',
  'tikzpicture',
  'asy',
])

const NON_PROSE_COMMANDS = new Set([
  'label',
  'ref',
  'eqref',
  'pageref',
  'autoref',
  'cref',
  'Cref',
  'vref',
  'cite',
  'citep',
  'citet',
  'citealp',
  'citeauthor',
  'citeyear',
  'citeyearpar',
  'parencite',
  'textcite',
  'autocite',
  'footcite',
  'url',
  'href',
  'include',
  'includegraphics',
  'input',
  'import',
  'subimport',
  'usepackage',
  'documentclass',
  'bibliography',
  'bibliographystyle',
  'addbibresource',
  'lstinputlisting',
  'graphicspath',
  'setlength',
  'setcounter',
  'addtocounter',
  'renewcommand',
  'newcommand',
  'providecommand',
  'DeclareMathOperator',
  'bibitem',
])

function readCommandName(line: string, start: number): string {
  let i = start + 1
  let name = ''
  while (i < line.length && /[a-zA-Z@]/.test(line[i])) {
    name += line[i]
    i++
  }
  return i === start + 1 && line[start + 1] === '*' ? '*' : name
}

function skipBalancedBrackets(
  line: string,
  start: number,
  open: string,
  close: string
): number {
  let depth = 0
  let i = start
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2
      continue
    }
    if (line[i] === open) depth++
    if (line[i] === close) {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return line.length
}

/**
 * Ranges the syntax tree says are not prose: comments, math (inline and
 * display) and verbatim-like environments. Returns an empty array when the
 * parser is not ready yet; the line scanner still masks most of these.
 */
function treeExcludedRanges(state: EditorState): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  try {
    syntaxTree(state).iterate({
      enter: node => {
        if (/Comment/.test(node.name)) {
          ranges.push([node.from, node.to])
          return false
        }
        if (/^Verbatim/.test(node.name)) {
          ranges.push([node.from, node.to])
          return false
        }
        if (/Math/.test(node.name)) {
          ranges.push([node.from, node.to])
          return false
        }
        return undefined
      },
    })
  } catch {
    // tree not available yet
  }
  return ranges
}

/**
 * Extract prose segments from the document. Each segment carries a
 * parallel array of document offsets so LanguageTool offsets map back to
 * exactly the right source ranges, even where characters were transformed
 * (escaped chars, ~ and & become spaces).
 */
export function extractProseSegments(
  doc: Text,
  excluded: Array<[number, number]> = []
): Segment[] {
  const segments: Segment[] = []
  let current: Segment | null = null
  let skipEnvironment: string | null = null

  const isExcluded = (pos: number) => {
    for (const [from, to] of excluded) {
      if (pos >= from && pos < to) return true
    }
    return false
  }

  const closeSegment = () => {
    if (current && current.chars.length >= MIN_SEGMENT_LENGTH) {
      segments.push(current)
    }
    current = null
  }

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber++) {
    const line = doc.line(lineNumber)
    const text = line.text
    const trimmed = text.trimStart()

    if (trimmed.startsWith('@')) {
      closeSegment()
      continue
    }

    let i = 0
    while (i < text.length) {
      if (isExcluded(line.from + i)) {
        // skip the excluded range inside this line
        let j = i
        while (j < text.length && isExcluded(line.from + j)) j++
        if (current) current = null
        i = j
        continue
      }

      const ch = text[i]

      if (skipEnvironment) {
        const endToken = `\\end{${skipEnvironment}}`
        const endIdx = text.indexOf(endToken)
        if (endIdx === -1) break
        skipEnvironment = null
        i = endIdx + endToken.length
        continue
      }

      if (ch === '%') break // comment

      if (ch === '\\') {
        const name = readCommandName(text, i)
        let after = i + 1 + name.length
        if (name === 'begin') {
          const envStart = text.indexOf('{', after)
          const envEnd = text.indexOf('}', envStart)
          const env = text.slice(envStart + 1, envEnd)
          after = envEnd + 1
          if (SKIP_ENVIRONMENTS.has(env)) {
            closeSegment()
            const endToken = `\\end{${env}}`
            const endIdx = text.indexOf(endToken, after)
            if (endIdx === -1) {
              skipEnvironment = env
              break
            }
            i = endIdx + endToken.length
            continue
          }
        } else if (name === 'end') {
          const envStart = text.indexOf('{', after)
          const envEnd = text.indexOf('}', envStart)
          after = envEnd + 1
        } else if (NON_PROSE_COMMANDS.has(name)) {
          while (after < text.length && text[after] === ' ') after++
          if (text[after] === '[') {
            after = skipBalancedBrackets(text, after, '[', ']')
          }
          while (after < text.length && text[after] === '{') {
            after = skipBalancedBrackets(text, after, '{', '}')
          }
        }
        if (!current) current = { chars: [], offsets: [] }
        current.chars.push(' ')
        current.offsets.push(line.from + i)
        i = after
        continue
      }

      if (ch === '$') {
        const double = text.startsWith('$$', i)
        const closing = double ? '$$' : '$'
        const end = text.indexOf(closing, i + closing.length)
        i = end === -1 ? text.length : end + closing.length
        if (current) current = null
        continue
      }

      if (ch === '~' || ch === '&' || ch === '\\') {
        if (!current) current = { chars: [], offsets: [] }
        current.chars.push(' ')
        current.offsets.push(line.from + i)
        i++
        continue
      }

      if (
        (ch === 'h' &&
          (text.startsWith('http://', i) || text.startsWith('https://', i))) ||
        (ch === 'w' && text.startsWith('www.', i))
      ) {
        let j = i
        while (j < text.length && !/[\s)}]/.test(text[j])) j++
        if (current) current = null
        i = j
        continue
      }

      if (!current) current = { chars: [], offsets: [] }
      current.chars.push(ch)
      current.offsets.push(line.from + i)
      i++
    }

    // merge prose continuing on the next line into one paragraph segment
    const endsWithProse = current !== null && i >= text.length
    if (lineNumber < doc.lines && endsWithProse && text.trim() !== '') {
      if (current) {
        current.chars.push('\n')
        current.offsets.push(line.to - 1)
      }
    } else if (text.trim() === '') {
      closeSegment()
    }
  }
  closeSegment()
  return segments
}

// ---------------------------------------------------------------------------
// Matches state + decorations
// ---------------------------------------------------------------------------

const setLaMatches = StateEffect.define<LaMatch[]>()

const matchDecoration = (m: LaMatch) =>
  Decoration.mark({
    class: m.isStyle
      ? 'ol-cm-la-match ol-cm-la-match-style'
      : 'ol-cm-la-match ol-cm-la-match-grammar',
  })

const laMatchesField = StateField.define<LaMatch[]>({
  create() {
    return []
  },
  update(matches, tr) {
    let next = matches
    for (const effect of tr.effects) {
      if (effect.is(setLaMatches)) {
        next = effect.value
      }
    }
    if (tr.docChanged) {
      next = next.filter(m => {
        let touched = false
        tr.changes.iterChangedRanges((from, to) => {
          if (m.to > from && m.from < to) touched = true
        })
        return !touched
      })
      next = next.map(m => ({
        ...m,
        from: tr.changes.mapPos(m.from),
        to: tr.changes.mapPos(m.to, 1),
      }))
    }
    return next
  },
})

function buildDecorations(matches: LaMatch[]): DecorationSet {
  const ranges: Array<Range<Decoration>> = []
  for (const m of matches) {
    ranges.push(matchDecoration(m).range(m.from, m.to))
  }
  return Decoration.set(ranges, true)
}

// ---------------------------------------------------------------------------
// Checking (debounced, incremental, cached)
// ---------------------------------------------------------------------------

const cache = new Map<string, GrammarMatch[]>()

async function checkText(
  text: string,
  language: string
): Promise<GrammarMatch[]> {
  // postJSON sends the CSRF token automatically
  const data = await postJSON('/user/writing/grammar', {
    body: { text, language: language || 'en-US' },
  })
  return data.matches || []
}

const segmentKey = (text: string, language: string) =>
  `${language}\u0001${text}`

let getOptions: () => Options = () => ({})

const laPlugin = ViewPlugin.fromClass(
  class {
    private timer: number | null = null
    private runId = 0
    private settingsListener: () => void

    constructor(private view: EditorView) {
      this.settingsListener = () => this.schedule(50)
      window.addEventListener(SETTINGS_EVENT, this.settingsListener)
      this.schedule(300)
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.schedule()
      }
    }

    destroy() {
      if (this.timer) window.clearTimeout(this.timer)
      window.removeEventListener(SETTINGS_EVENT, this.settingsListener)
    }

    schedule(delay = DEBOUNCE_MS) {
      if (this.timer) window.clearTimeout(this.timer)
      this.timer = window.setTimeout(() => {
        this.timer = null
        this.run()
      }, delay)
    }

    async run() {
      const runId = ++this.runId
      // grammar checking is on by default: it runs on a fully internal
      // LanguageTool service, so no opt-in is required
      const mode = settings().mode ?? 'grammar'
      const language =
        settings().language || getOptions().spellCheckLanguage || 'en-US'

      if (mode === 'off') {
        this.view.dispatch({ effects: setLaMatches.of([]) })
        return
      }

      const excluded = treeExcludedRanges(this.view.state)
      const segments = extractProseSegments(this.view.state.doc, excluded)
      const ignored = ignoredRules()

      const dirty: Array<{ segment: Segment; text: string }> = []
      const resolved: LaMatch[] = []
      for (const segment of segments) {
        const text = segment.chars.join('')
        const key = segmentKey(text, language)
        const cached = cache.get(key)
        if (cached) {
          resolved.push(...toDocMatches(cached, segment, mode, ignored))
        } else {
          dirty.push({ segment, text })
        }
      }

      if (dirty.length > 0) {
        let joined = ''
        const starts: number[] = []
        for (const { text } of dirty) {
          starts.push(joined.length)
          joined += text + '\n\n'
        }
        try {
          const found = await checkText(joined, language)
          if (this.runId !== runId) return
          const perSegment = dirty.map(() => [] as GrammarMatch[])
          for (const match of found) {
            for (let idx = dirty.length - 1; idx >= 0; idx--) {
              if (match.offset >= starts[idx]) {
                perSegment[idx].push({
                  ...match,
                  offset: match.offset - starts[idx],
                })
                break
              }
            }
          }
          if (cache.size > CACHE_LIMIT) cache.clear()
          dirty.forEach(({ text }, idx) => {
            cache.set(segmentKey(text, language), perSegment[idx])
            resolved.push(
              ...toDocMatches(perSegment[idx], dirty[idx].segment, mode, ignored)
            )
          })
        } catch {
          if (this.runId !== runId) return
          // service unavailable - keep resolved so far
        }
      }

      if (this.runId !== runId) return
      this.view.dispatch({ effects: setLaMatches.of(resolved) })
    }
  }
)

function toDocMatches(
  textMatches: GrammarMatch[],
  segment: Segment,
  mode: Mode,
  ignored: Set<string>
): LaMatch[] {
  const result: LaMatch[] = []
  for (const m of textMatches) {
    if (mode === 'grammar' && m.isStyle) continue
    const fromOffset =
      segment.offsets[Math.min(m.offset, segment.offsets.length - 1)]
    const toOffset =
      segment.offsets[
        Math.min(m.offset + m.length - 1, segment.offsets.length - 1)
      ] + 1
    const text = segment.chars.slice(m.offset, m.offset + m.length).join('')
    if (ignored.has(ignoreKey(m.ruleId, text))) continue
    result.push({
      from: fromOffset,
      to: toOffset,
      message: m.message,
      shortMessage: m.shortMessage,
      replacements: m.replacements,
      ruleId: m.ruleId,
      category: m.category,
      isStyle: m.isStyle,
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

const laTooltip = hoverTooltip((view, pos) => {
  const matches = view.state.field(laMatchesField)
  const match = matches.find(m => pos >= m.from && pos <= m.to)
  if (!match) return null
  return {
    pos: match.from,
    above: true,
    create: () => {
      const dom = document.createElement('div')
      dom.className = 'ol-cm-la-tooltip'
      const title = document.createElement('div')
      title.className = 'ol-cm-la-tooltip-title'
      title.textContent = match.shortMessage || match.message
      dom.appendChild(title)

      if (match.shortMessage && match.message !== match.shortMessage) {
        const detail = document.createElement('div')
        detail.className = 'ol-cm-la-tooltip-detail'
        detail.textContent = match.message
        dom.appendChild(detail)
      }

      const meta = document.createElement('div')
      meta.className = 'ol-cm-la-tooltip-meta'
      meta.textContent = `${match.category}${match.ruleId ? ` · ${match.ruleId}` : ''}${
        match.isStyle ? ' · style' : ' · grammar'
      }`
      dom.appendChild(meta)

      const buttons = document.createElement('div')
      buttons.className = 'ol-cm-la-tooltip-buttons'
      for (const replacement of match.replacements.slice(0, 4)) {
        const button = document.createElement('button')
        button.className = 'ol-cm-la-tooltip-button'
        button.textContent = replacement
        button.addEventListener('mousedown', event => {
          event.preventDefault()
          view.dispatch({
            changes: { from: match.from, to: match.to, insert: replacement },
          })
        })
        buttons.appendChild(button)
      }
      const ignore = document.createElement('button')
      ignore.className = 'ol-cm-la-tooltip-ignore'
      ignore.textContent = 'Ignore once'
      ignore.addEventListener('mousedown', event => {
        event.preventDefault()
        const currentText = view.state.sliceDoc(match.from, match.to)
        const ignored = ignoredRules()
        ignored.add(ignoreKey(match.ruleId, currentText))
        window.localStorage.setItem(
          IGNORED_KEY,
          JSON.stringify([...ignored].slice(-IGNORE_LIMIT))
        )
        view.dispatch({
          effects: setLaMatches.of(
            view.state.field(laMatchesField).filter(
              m => !(m.from === match.from && m.to === match.to)
            )
          ),
        })
      })
      buttons.appendChild(ignore)
      dom.appendChild(buttons)
      return { dom }
    },
  }
})

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const laTheme = EditorView.baseTheme({
  '.ol-cm-la-match': {
    textDecoration: 'underline',
    textDecorationStyle: 'wavy',
    textDecorationSkipInk: 'none',
    cursor: 'help',
  },
  '.ol-cm-la-match-grammar': {
    textDecorationColor: '#2f6fed',
  },
  '.ol-cm-la-match-style': {
    textDecorationColor: '#d9822b',
  },
  '.ol-cm-la-tooltip': {
    fontFamily: 'inherit',
    fontSize: '13px',
    padding: '8px 10px',
    borderRadius: '4px',
    maxWidth: '420px',
    whiteSpace: 'normal',
  },
  '&light .ol-cm-la-tooltip': {
    backgroundColor: '#ffffff',
    border: '1px solid #d9d9d9',
    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.12)',
  },
  '&dark .ol-cm-la-tooltip': {
    backgroundColor: '#1b222c',
    border: '1px solid #3b4a5c',
    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.4)',
  },
  '.ol-cm-la-tooltip-title': {
    fontWeight: 600,
    marginBottom: '4px',
  },
  '.ol-cm-la-tooltip-detail': {
    opacity: 0.8,
    marginBottom: '4px',
  },
  '.ol-cm-la-tooltip-meta': {
    fontSize: '11px',
    opacity: 0.6,
    marginBottom: '6px',
  },
  '.ol-cm-la-tooltip-buttons': {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
  },
  '.ol-cm-la-tooltip-button': {
    fontSize: '12px',
    padding: '2px 8px',
    borderRadius: '4px',
    border: '1px solid #2f6fed',
    color: '#2f6fed',
    background: 'transparent',
    cursor: 'pointer',
  },
  '.ol-cm-la-tooltip-ignore': {
    fontSize: '12px',
    padding: '2px 8px',
    borderRadius: '4px',
    border: '1px solid #9aa5b1',
    color: '#9aa5b1',
    background: 'transparent',
    cursor: 'pointer',
  },
})

// ---------------------------------------------------------------------------
// Extension entry point (sourceEditorExtensions)
// ---------------------------------------------------------------------------

export const extension = (options: Options): Extension => {
  getOptions = () => options
  return [
    laMatchesField,
    EditorView.decorations.compute(
      [laMatchesField],
      state => buildDecorations(state.field(laMatchesField)) as DecorationSet
    ),
    laPlugin,
    laTooltip,
    laTheme,
  ]
}

export { SETTINGS_KEY, IGNORED_KEY, SETTINGS_EVENT, settings, ignoredRules }

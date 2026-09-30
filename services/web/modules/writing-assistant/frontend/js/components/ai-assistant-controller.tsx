/**
 * AI assistant controller: modal UI opened by the editor selection tooltip
 * (window event "editor:ai-assistant") or the compile-error log action.
 *
 * Flow: user picks an action -> the modal opens and starts the request unless
 * the action needs more input -> the response streams from the Overleaf
 * backend (POST /user/ai/:action) using the user's own e-INFRA API token.
 * Mutating results are shown as a word-level diff and applied only on
 * Accept. Cancel aborts the in-flight request.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useEditorViewContext } from '@/features/ide-react/context/editor-view-context'
import getMeta from '@/utils/meta'
import { AI_EVENT } from '../extensions/ai-selector'

type Request = {
  action: string
  from: number
  to: number
  text: string
  error?: string
  sourceLines?: string
  referenceId?: string
}

const ACTION_TITLES: Record<string, string> = {
  improve: 'Improve academic English',
  concise: 'Make concise',
  grammar: 'Fix grammar and style',
  explain: 'Explain',
  translate: 'Translate',
  review: 'Review paragraph',
  'latex-fix': 'Fix LaTeX',
  'latex-explain': 'Explain LaTeX',
  equation: 'Generate equation',
  table: 'Generate table',
  custom: 'Custom instruction',
  'library-support': 'Support from my library',
  'literature-search': 'Find related papers',
  'ask-paper': 'Ask paper',
  'missing-citations': 'Missing citations check',
  'verify-citations': 'Verify citations',
  'compile-error': 'Explain compilation error',
}

const TRANSLATE_LANGUAGES = [
  'English',
  'Czech',
  'Slovak',
  'German',
  'French',
  'Polish',
  'Spanish',
]

function needsInput(action: string) {
  return action === 'custom' || action === 'translate' || action === 'ask-paper'
}

// simple word-level diff (LCS) for the preview
function diffWords(
  a: string,
  b: string
): Array<{ text: string; removed?: boolean; added?: boolean }> {
  const split = (s: string) =>
    s.split(/(\s+)/).filter((part) => part.length > 0)
  const left = split(a)
  const right = split(b)
  const n = left.length
  const m = right.length
  if (n * m > 250000) {
    return [
      { text: a, removed: true },
      { text: b, added: true },
    ]
  }
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        left[i] === right[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const result: Array<{ text: string; removed?: boolean; added?: boolean }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      result.push({ text: left[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      result.push({ text: left[i], removed: true })
      i++
    } else {
      result.push({ text: right[j], added: true })
      j++
    }
  }
  while (i < n) result.push({ text: left[i++], removed: true })
  while (j < m) result.push({ text: right[j++], added: true })
  return result
}

// SSE streaming POST: returns { promise, abort }
function streamCompletion(
  url: string,
  body: Record<string, unknown>,
  onDelta: (delta: string) => void
): { promise: Promise<void>; abort: () => void } {
  const controller = new AbortController()
  const promise = (async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': getMeta('ol-csrfToken'),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.message || `request failed (${response.status})`)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('no response stream')
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return
        try {
          const json = JSON.parse(payload)
          const delta = json.choices?.[0]?.delta?.content
          if (typeof delta === 'string') onDelta(delta)
        } catch {
          // ignore malformed keepalives
        }
      }
    }
  })()
  return { promise, abort: () => controller.abort() }
}

export default function AIAssistantController() {
  const { view } = useEditorViewContext()

  const [request, setRequest] = useState<Request | null>(null)
  const [instruction, setInstruction] = useState('')
  const [language, setLanguage] = useState('English')
  const [result, setResult] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showDiff, setShowDiff] = useState(true)
  const [aborted, setAborted] = useState(false)
  const [libraryMatches, setLibraryMatches] = useState<
    Array<{ key: string; reason: string }>
  >([])
  const [searchResults, setSearchResults] = useState<
    Array<{
      key: string
      title: string
      authors: string[]
      year: number | null
      venue: string
      doi: string
      reason: string
    }>
  >([])
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set())
  const [citationClaims, setCitationClaims] = useState<
    Array<{
      quote: string
      classification: string
      suggestion: string
    }>
  >([])
  const [paperQuestion, setPaperQuestion] = useState('')
  const [citationChecks, setCitationChecks] = useState<
    Array<{
      key: string
      title?: string
      verdict: string
      note: string
    }>
  >([])

  const close = useCallback(() => {
    setRequest(null)
    setResult('')
    setError('')
    setInstruction('')
    setLoading(false)
    setAborted(false)
    setLibraryMatches([])
    setSearchResults([])
    setAddedKeys(new Set())
    setCitationClaims([])
    setCitationChecks([])
    setPaperQuestion('')
  }, [])

  const addToLibrary = useCallback(async (entry: Record<string, unknown>) => {
    try {
      const response = await fetch(
        '/user/research-library/references/from-lookup',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': getMeta('ol-csrfToken'),
          },
          body: JSON.stringify({
            reference: { ...entry, source: 'literature-search' },
          }),
        }
      )
      const data = await response.json()
      if (response.ok && data.added) {
        setAddedKeys((previous) => new Set(previous).add(String(entry.key)))
      } else if (response.ok) {
        setAddedKeys((previous) => new Set(previous).add(String(entry.key)))
      }
    } catch {
      // non-fatal
    }
  }, [])

  const run = useCallback(
    async (activeRequest: Request | null = request) => {
      if (!activeRequest || loading) return

      setLibraryMatches([])
      setSearchResults([])
      setAddedKeys(new Set())
      setCitationClaims([])
      setCitationChecks([])

      // structured, non-streaming actions
      if (
        activeRequest.action === 'library-support' ||
        activeRequest.action === 'literature-search' ||
        activeRequest.action === 'missing-citations' ||
        activeRequest.action === 'verify-citations'
      ) {
        setLoading(true)
        setError('')
        try {
          const response = await fetch(`/user/ai/${activeRequest.action}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-csrf-token': getMeta('ol-csrfToken'),
            },
            body: JSON.stringify({ text: activeRequest.text }),
          })
          const data = await response.json()
          if (!response.ok) {
            throw new Error(
              data.message || `request failed (${response.status})`
            )
          }
          if (activeRequest.action === 'library-support') {
            setLibraryMatches(data.matches || [])
            if (!(data.matches || []).length) {
              setError('No matching entries found in your library.')
            }
          } else if (activeRequest.action === 'missing-citations') {
            setCitationClaims(data.claims || [])
            if (!(data.claims || []).length) {
              setError('No citation-worthy claims detected.')
            }
          } else if (activeRequest.action === 'verify-citations') {
            setCitationChecks(data.checks || [])
            if (!(data.checks || []).length) {
              setError('No \\cite commands found in the selection.')
            }
          } else {
            setSearchResults(data.results || [])
            if (!(data.results || []).length) {
              setError('No results found.')
            }
          }
        } catch (err: any) {
          setError(err.message || 'AI request failed')
        } finally {
          setLoading(false)
        }
        return
      }

      setLoading(true)
      setError('')
      setResult('')
      setAborted(false)
      const body: Record<string, unknown> = {
        text: activeRequest.text,
        latex: activeRequest.text,
        language,
        instruction,
      }
      if (activeRequest.action === 'compile-error') {
        body.error = activeRequest.error
        body.sourceLines = activeRequest.sourceLines
      }
      if (
        activeRequest.action === 'equation' ||
        activeRequest.action === 'table'
      ) {
        body.description = activeRequest.text
      }
      if (activeRequest.action === 'ask-paper') {
        body.referenceId = activeRequest.referenceId
        body.question = paperQuestion
      }
      const { promise, abort } = streamCompletion(
        `/user/ai/${activeRequest.action}`,
        body,
        (delta) => setResult((previous) => previous + delta)
      )
      // store the abort fn on the component for the Cancel button
      abortRef.current = abort
      try {
        await promise
      } catch (err: any) {
        if (err.name === 'AbortError') {
          setAborted(true)
        } else {
          setError(err.message || 'AI request failed')
        }
      } finally {
        setLoading(false)
        abortRef.current = null
      }
    },
    [request, loading, instruction, language, paperQuestion]
  )

  const abortRef = React.useRef<null | (() => void)>(null)

  const applyResult = useCallback(() => {
    if (!view || !request || !result) return
    view.dispatch({
      changes: { from: request.from, to: request.to, insert: result },
      selection: { anchor: request.from + result.length },
    })
    view.focus()
    close()
  }, [view, request, result, close])

  const applyCitation = useCallback(
    (key: string) => {
      if (!view || !request) return
      view.dispatch({
        changes: {
          from: request.to,
          to: request.to,
          insert: `~\\cite{${key}}`,
        },
      })
      view.focus()
    },
    [view, request]
  )

  const insertResult = useCallback(() => {
    if (!view || !result) return
    const pos = request ? request.to : view.state.selection.main.head
    view.dispatch({
      changes: { from: pos, to: pos, insert: `\n${result}\n` },
    })
    view.focus()
    close()
  }, [view, request, result, close])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      if (detail.from == null || detail.to == null) return
      const text = view ? view.state.sliceDoc(detail.from, detail.to) : ''
      setResult('')
      setError('')
      setInstruction('')
      setPaperQuestion('')
      setLibraryMatches([])
      setSearchResults([])
      setAddedKeys(new Set())
      setCitationClaims([])
      setCitationChecks([])
      const nextRequest = {
        action: detail.action,
        from: detail.from,
        to: detail.to,
        text,
        error: detail.error,
        sourceLines: detail.sourceLines,
        referenceId: detail.referenceId,
      }
      setRequest(nextRequest)
      if (!needsInput(nextRequest.action)) {
        void run(nextRequest)
      }
    }
    window.addEventListener(AI_EVENT, handler)
    return () => window.removeEventListener(AI_EVENT, handler)
  }, [view, run])

  if (!request) return null

  const isGenerate = request.action === 'equation' || request.action === 'table'
  const isCompileError = request.action === 'compile-error'
  const isReview =
    request.action === 'review' ||
    request.action === 'explain' ||
    request.action === 'latex-explain'
  const title = ACTION_TITLES[request.action] || 'AI assistant'
  const requiresInput = needsInput(request.action)
  const hasStructuredResult =
    libraryMatches.length > 0 ||
    searchResults.length > 0 ||
    citationClaims.length > 0 ||
    citationChecks.length > 0
  const hasOutput = Boolean(result) || hasStructuredResult
  const canRun =
    request.action === 'custom'
      ? Boolean(instruction.trim())
      : request.action === 'ask-paper'
        ? Boolean(paperQuestion.trim())
        : true
  const runLabel = hasOutput
    ? 'Run again'
    : error
      ? 'Retry'
      : request.action === 'ask-paper'
        ? 'Ask'
        : request.action === 'translate'
          ? 'Translate'
          : request.action === 'custom'
            ? 'Apply instruction'
            : 'Run'

  return (
    <div className="modal in" style={{ display: 'block' }}>
      <div className="modal-dialog modal-lg" role="document">
        <div className="modal-content">
          <div className="modal-header">
            <h4 className="modal-title">AI: {title}</h4>
            <button className="close" onClick={close} aria-label="Close">
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <div className="modal-body">
            <p className="small text-muted">
              This action sends the relevant text to the e-INFRA CZ LLM service
              using your personal API token.
            </p>
            {isCompileError && (
              <pre className="ai-assistant-error small">{request.error}</pre>
            )}
            {!isCompileError && (
              <details>
                <summary className="small">
                  {isGenerate ? 'Description / request' : 'Selected text'}
                </summary>
                <pre className="small">{request.text}</pre>
              </details>
            )}

            {request.action === 'custom' && (
              <textarea
                className="form-control"
                rows={2}
                placeholder="Instruction, e.g. rewrite in passive voice"
                value={instruction}
                disabled={loading}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && instruction.trim()) {
                    e.preventDefault()
                    void run()
                  }
                }}
              />
            )}
            {request.action === 'translate' && (
              <select
                className="form-control"
                value={language}
                disabled={loading}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {TRANSLATE_LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            )}

            {request.action === 'ask-paper' && (
              <textarea
                className="form-control"
                rows={2}
                placeholder="Ask a question about this paper…"
                value={paperQuestion}
                disabled={loading}
                onChange={(e) => setPaperQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    !e.shiftKey &&
                    paperQuestion.trim()
                  ) {
                    e.preventDefault()
                    void run()
                  }
                }}
              />
            )}

            {loading && (
              <div className="loading">
                <div
                  className="spinner-border spinner-border-sm"
                  role="status"
                  aria-hidden="true"
                />
                &nbsp;Thinking…{' '}
                <span className="small text-muted">(streaming)</span>
              </div>
            )}
            {aborted && <div className="small text-muted">Cancelled.</div>}

            {error && (
              <div className="alert alert-danger small" role="alert">
                {error}
              </div>
            )}

            {result && (
              <>
                {isReview || isCompileError || isGenerate ? (
                  <pre className="ai-assistant-result small">{result}</pre>
                ) : (
                  <>
                    <div className="small mb-1">
                      <label>
                        <input
                          type="checkbox"
                          checked={showDiff}
                          onChange={(e) => setShowDiff(e.target.checked)}
                        />
                        &nbsp;Show changes
                      </label>
                    </div>
                    {showDiff ? (
                      <pre className="ai-assistant-result small">
                        {diffWords(request.text, result).map((part, idx) => (
                          <span
                            key={idx}
                            className={
                              part.removed
                                ? 'ai-assistant-diff-removed'
                                : part.added
                                  ? 'ai-assistant-diff-added'
                                  : undefined
                            }
                          >
                            {part.text}
                          </span>
                        ))}
                      </pre>
                    ) : (
                      <pre className="ai-assistant-result small">{result}</pre>
                    )}
                  </>
                )}
              </>
            )}

            {libraryMatches.length > 0 && (
              <div className="list-group">
                {libraryMatches.map((match) => (
                  <div className="list-group-item" key={match.key}>
                    <strong>{match.key}</strong>
                    <p className="small">{match.reason}</p>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => applyCitation(match.key)}
                    >
                      Insert citation
                    </button>
                  </div>
                ))}
              </div>
            )}

            {searchResults.length > 0 && (
              <div className="list-group">
                {searchResults.map((entry) => (
                  <div className="list-group-item" key={entry.key}>
                    <strong>{entry.title}</strong>
                    <div className="small text-muted">
                      {entry.authors.join(', ')}
                      {entry.year ? ` (${entry.year})` : ''}
                    </div>
                    <p className="small">{entry.reason}</p>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={addedKeys.has(entry.key)}
                      onClick={() => addToLibrary(entry)}
                    >
                      {addedKeys.has(entry.key) ? 'Added' : 'Add to library'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {citationClaims.length > 0 && (
              <div className="list-group">
                {citationClaims.map((claim, index) => (
                  <div className="list-group-item" key={index}>
                    <strong>{claim.classification}</strong>
                    <blockquote className="small">{claim.quote}</blockquote>
                    <p className="small">{claim.suggestion}</p>
                  </div>
                ))}
              </div>
            )}

            {citationChecks.length > 0 && (
              <div className="list-group">
                {citationChecks.map((check) => (
                  <div className="list-group-item" key={check.key}>
                    <strong>
                      {check.key}: {check.verdict}
                    </strong>
                    {check.title && <div className="small">{check.title}</div>}
                    <p className="small">{check.note}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="modal-footer">
            {loading ? (
              <button
                className="btn btn-secondary"
                onClick={() => abortRef.current?.()}
              >
                Cancel
              </button>
            ) : requiresInput || hasOutput || error ? (
              <button
                className="btn btn-primary"
                disabled={!canRun}
                onClick={() => void run()}
              >
                {runLabel}
              </button>
            ) : null}
            {result &&
              !loading &&
              !isReview &&
              !isCompileError &&
              !isGenerate && (
                <button className="btn btn-success" onClick={applyResult}>
                  Accept (replace selection)
                </button>
              )}
            {result && !loading && isGenerate && (
              <button className="btn btn-success" onClick={insertResult}>
                Insert
              </button>
            )}
            <button className="btn btn-secondary" onClick={close}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

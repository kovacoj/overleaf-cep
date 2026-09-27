/**
 * AI Assistant rail panel: chat about the current document and a structured
 * "Review document" action, using the user's own e-INFRA LLM token via the
 * writing-assistant backend. Context scope is explicit (selection /
 * current file / none) and text is only sent when the user sends a message
 * or presses Review.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useEditorViewContext } from '@/features/ide-react/context/editor-view-context'
import getMeta from '@/utils/meta'
import OLButton from '@/shared/components/ol/ol-button'

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

type ContextMode = 'selection' | 'document' | 'library' | 'none'

// SSE streaming POST; onDelta receives text chunks
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
          // ignore keepalives
        }
      }
    }
  })()
  return { promise, abort: () => controller.abort() }
}

export default function AIAssistantPanel() {
  const { view } = useEditorViewContext()

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streamingText, setStreamingText] = useState('')
  const [reviewResult, setReviewResult] = useState('')
  const [mode, setMode] = useState<'chat' | 'review'>('chat')
  const [contextMode, setContextMode] = useState<ContextMode>('document')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef<null | (() => void)>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const getContext = useCallback((): string => {
    if (!view) return ''
    if (contextMode === 'none') return ''
    if (contextMode === 'selection') {
      const { from, to } = view.state.selection.main
      if (to > from) return view.state.sliceDoc(from, to)
      return ''
    }
    if (contextMode === 'library') return '' // assembled server-side
    return view.state.doc.toString()
  }, [view, contextMode])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streamingText, reviewResult])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setError('')
    setBusy(true)
    const userMessage: ChatMessage = { role: 'user', content: text }
    const history = [...messages, userMessage]
    setMessages(history)
    setStreamingText('')
    const sendContextMode = contextMode
    const { promise, abort } = streamCompletion(
      '/user/ai/chat',
      {
        messages: history,
        context: getContext(),
        library: sendContextMode === 'library',
      },
      delta => setStreamingText(previous => previous + delta)
    )
    abortRef.current = abort
    try {
      await promise
      setMessages(previous => [
        ...previous,
        { role: 'assistant', content: streamingTextRef.current },
      ])
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'AI request failed')
      }
      // keep partial answer if any
      if (streamingTextRef.current) {
        setMessages(previous => [
          ...previous,
          { role: 'assistant', content: streamingTextRef.current },
        ])
      }
    } finally {
      setStreamingText('')
      setBusy(false)
      abortRef.current = null
    }
  }, [input, busy, messages, getContext, contextMode])

  // keep the latest streamed text accessible inside the async closure
  const streamingTextRef = useRef('')
  useEffect(() => {
    streamingTextRef.current = streamingText
  }, [streamingText])

  const reviewDocument = useCallback(async () => {
    if (busy) return
    setError('')
    setBusy(true)
    setMode('review')
    setReviewResult('')
    const { promise, abort } = streamCompletion(
      '/user/ai/review',
      { text: view ? view.state.doc.toString() : '' },
      delta => setReviewResult(previous => previous + delta)
    )
    abortRef.current = abort
    try {
      await promise
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'AI review failed')
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }, [busy, view])

  return (
    <div className="ai-assistant-panel" style={{ padding: '8px' }}>
      <div
        style={{
          display: 'flex',
          gap: '4px',
          marginBottom: '8px',
          flexWrap: 'wrap',
        }}
      >
        <OLButton
          variant={mode === 'chat' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setMode('chat')}
        >
          Chat
        </OLButton>
        <OLButton
          variant={mode === 'review' ? 'primary' : 'secondary'}
          size="sm"
          disabled={busy}
          onClick={reviewDocument}
        >
          Review document
        </OLButton>
        {busy && (
          <OLButton
            variant="secondary"
            size="sm"
            onClick={() => abortRef.current?.()}
          >
            Cancel
          </OLButton>
        )}
      </div>

      {mode === 'chat' && (
        <>
          <select
            className="form-control form-control-sm"
            value={contextMode}
            onChange={e => setContextMode(e.target.value as ContextMode)}
            style={{ marginBottom: '8px' }}
          >
            <option value="selection">Context: selection only</option>
            <option value="document">Context: current file</option>
            <option value="library">Context: my research library</option>
            <option value="none">Context: none</option>
          </select>
          <div
            ref={scrollRef}
            style={{
              overflowY: 'auto',
              maxHeight: '50vh',
              minHeight: '100px',
              border: '1px solid #d9d9d9',
              borderRadius: '4px',
              padding: '6px',
              marginBottom: '8px',
              fontSize: '13px',
            }}
          >
            {messages.length === 0 && !streamingText && (
              <div className="small text-muted">
                Ask anything about your document. Requests are sent to the
                e-INFRA CZ LLM service using your personal API token, only
                when you send a message.
              </div>
            )}
            {messages.map((message, index) => (
              <div
                key={index}
                style={{
                  marginBottom: '6px',
                  textAlign: message.role === 'user' ? 'right' : 'left',
                }}
              >
                <div
                  style={{
                    display: 'inline-block',
                    maxWidth: '90%',
                    textAlign: 'left',
                    padding: '4px 8px',
                    borderRadius: '6px',
                    backgroundColor:
                      message.role === 'user' ? '#e8f0fe' : '#f2f2f2',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {message.content}
                </div>
              </div>
            ))}
            {streamingText && (
              <div style={{ marginBottom: '6px' }}>
                <div
                  style={{
                    display: 'inline-block',
                    maxWidth: '90%',
                    padding: '4px 8px',
                    borderRadius: '6px',
                    backgroundColor: '#f2f2f2',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {streamingText}
                  <span className="small text-muted"> ▍</span>
                </div>
              </div>
            )}
          </div>
          <div className="input-group">
            <textarea
              className="form-control"
              rows={2}
              placeholder="Ask about this document…"
              value={input}
              disabled={busy}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <OLButton
              variant="primary"
              size="sm"
              disabled={busy || !input.trim()}
              onClick={send}
            >
              Send
            </OLButton>
          </div>
        </>
      )}

      {mode === 'review' && (
        <div
          style={{
            overflowY: 'auto',
            maxHeight: '60vh',
            border: '1px solid #d9d9d9',
            borderRadius: '4px',
            padding: '8px',
            fontSize: '13px',
            whiteSpace: 'pre-wrap',
          }}
        >
          {reviewResult || (
            <span className="small text-muted">
              {busy
                ? 'Reviewing…'
                : 'Press "Review document" for an AI review of the current file.'}
            </span>
          )}
        </div>
      )}

      {error && (
        <div
          className="small"
          style={{ color: '#d9534f', marginTop: '6px' }}
          role="alert"
        >
          {error}
        </div>
      )}
    </div>
  )
}

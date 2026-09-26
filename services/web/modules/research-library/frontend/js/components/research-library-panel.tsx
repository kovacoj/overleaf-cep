/**
 * Research Library rail panel: personal bibliography shared across
 * projects. Search entries, add references via DOI / arXiv / title lookup
 * or pasted BibTeX, insert \cite{key} at the cursor, and materialize the
 * whole library into the current project as library.bib.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useProjectContext } from '@/shared/context/project-context'
import { useEditorViewContext } from '@/features/ide-react/context/editor-view-context'
import getMeta from '@/utils/meta'
import OLButton from '@/shared/components/ol/ol-button'
import Notification from '@/shared/components/notification'

type Reference = {
  _id: string
  key: string
  title: string
  authors: string[]
  year: number | null
  venue: string
  doi?: string
  arxivId?: string
  source?: string
}

export default function ResearchLibraryPanel() {
  const { projectId } = useProjectContext()
  const { view } = useEditorViewContext()
  const csrf = getMeta('ol-csrfToken')

  const [references, setReferences] = useState<Reference[]>([])
  const [query, setQuery] = useState('')
  const [lookupQuery, setLookupQuery] = useState('')
  const [bibtexText, setBibtexText] = useState('')
  const [showAdd, setShowAdd] = useState<'none' | 'lookup' | 'bibtex'>('none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const fetchReferences = useCallback(async () => {
    try {
      const params = query ? `?q=${encodeURIComponent(query)}` : ''
      const response = await fetch(`/user/research-library/references${params}`)
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || 'failed to load')
      setReferences(data.references || [])
    } catch (err: any) {
      setError(err.message || 'failed to load library')
    }
  }, [query])

  useEffect(() => {
    fetchReferences()
  }, [fetchReferences])

  const doLookup = useCallback(async () => {
    if (!lookupQuery.trim()) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch('/user/research-library/references/lookup', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ query: lookupQuery.trim() }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.message || 'lookup failed')
      }
      // store it directly (dedup happens server-side)
      const addResponse = await fetch(
        '/user/research-library/references/from-lookup',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf,
          },
          body: JSON.stringify({ reference: data.reference }),
        }
      )
      const addData = await addResponse.json()
      if (!addResponse.ok) {
        throw new Error(addData.message || 'failed to add')
      }
      setMessage(
        addData.added
          ? `Added: ${data.reference.title}`
          : `Already in library (${addData.duplicateOf})`
      )
      setLookupQuery('')
      await fetchReferences()
    } catch (err: any) {
      setError(err.message || 'lookup failed')
    } finally {
      setBusy(false)
    }
  }, [lookupQuery, csrf, fetchReferences])

  const addBibtex = useCallback(async () => {
    if (!bibtexText.trim()) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch('/user/research-library/references', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ bibtex: bibtexText }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || 'failed to add')
      const parts = [
        `${data.added?.length || 0} added`,
        data.duplicates?.length ? `${data.duplicates.length} duplicates` : '',
        data.errors?.length ? `${data.errors.length} errors` : '',
      ].filter(Boolean)
      setMessage(parts.join(', '))
      setBibtexText('')
      await fetchReferences()
    } catch (err: any) {
      setError(err.message || 'failed to add')
    } finally {
      setBusy(false)
    }
  }, [bibtexText, csrf, fetchReferences])

  const deleteReference = useCallback(
    async (referenceId: string) => {
      try {
        await fetch(`/user/research-library/references/${referenceId}`, {
          method: 'DELETE',
          headers: { 'x-csrf-token': csrf },
        })
        await fetchReferences()
      } catch {
        setError('failed to delete')
      }
    },
    [csrf, fetchReferences]
  )

  const insertCitation = useCallback(
    (key: string) => {
      if (!view) return
      const pos = view.state.selection.main.head
      view.dispatch({
        changes: { from: pos, to: pos, insert: `\\cite{${key}}` },
        selection: { anchor: pos + 7 + key.length },
      })
      view.focus()
    },
    [view]
  )

  const materialize = useCallback(async () => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch(
        `/project/${projectId}/research-library/materialize`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf,
          },
          body: JSON.stringify({}),
        }
      )
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || 'failed')
      setMessage(
        `${data.updated ? 'Updated' : 'Created'} ${data.docName} (${data.count} references)`
      )
    } catch (err: any) {
      setError(err.message || 'failed to materialize')
    } finally {
      setBusy(false)
    }
  }, [projectId, csrf])

  return (
    <div className="research-library-panel full-project-search">
      <div className="research-library-toolbar">
        <div className="form-group">
          <input
            className="form-control"
            placeholder="Search library…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
        <div className="btn-group">
          <OLButton
            variant="secondary"
            size="sm"
            onClick={() =>
              setShowAdd(showAdd === 'lookup' ? 'none' : 'lookup')
            }
          >
            Add by DOI/arXiv/title
          </OLButton>
          <OLButton
            variant="secondary"
            size="sm"
            onClick={() =>
              setShowAdd(showAdd === 'bibtex' ? 'none' : 'bibtex')
            }
          >
            Paste BibTeX
          </OLButton>
          <OLButton
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={materialize}
          >
            library.bib → project
          </OLButton>
        </div>
      </div>

      {showAdd === 'lookup' && (
        <div className="research-library-add">
          <div className="input-group">
            <input
              className="form-control"
              placeholder="10.1000/xyz123, arXiv:2101.01234, or title…"
              value={lookupQuery}
              onChange={e => setLookupQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') doLookup()
              }}
            />
            <OLButton
              variant="primary"
              size="sm"
              disabled={busy || !lookupQuery.trim()}
              onClick={doLookup}
            >
              {busy ? '…' : 'Resolve'}
            </OLButton>
          </div>
        </div>
      )}

      {showAdd === 'bibtex' && (
        <div className="research-library-add">
          <textarea
            className="form-control"
            rows={4}
            placeholder="@article{key, title = {…}, …}"
            value={bibtexText}
            onChange={e => setBibtexText(e.target.value)}
          />
          <OLButton
            variant="primary"
            size="sm"
            disabled={busy || !bibtexText.trim()}
            onClick={addBibtex}
          >
            Add entries
          </OLButton>
        </div>
      )}

      {error && (
        <Notification type="error" content={error} onDismiss={() => setError('')} />
      )}
      {message && (
        <Notification type="info" content={message} onDismiss={() => setMessage('')} />
      )}

      <div className="research-library-results">
        {references.length === 0 ? (
          <div className="small text-muted">
            No references yet. Add some via DOI, arXiv id, title search or
            pasted BibTeX.
          </div>
        ) : (
          references.map(reference => (
            <div
              key={reference._id}
              className="research-library-entry"
            >
              <div className="research-library-entry-main">
                <button
                  className="research-library-entry-title"
                  title="Insert \cite at cursor"
                  onClick={() => insertCitation(reference.key)}
                >
                  {reference.title || reference.key}
                </button>
                <div className="small text-muted">
                  {reference.authors?.slice(0, 3).join(', ')}
                  {reference.authors?.length > 3 ? ' et al.' : ''}
                  {reference.year ? ` (${reference.year})` : ''}
                  {reference.venue ? ` — ${reference.venue}` : ''}
                </div>
                <div className="small">
                  <code>{reference.key}</code>
                  {reference.doi ? (
                    <a
                      className="ms-1"
                      href={`https://doi.org/${reference.doi}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      DOI
                    </a>
                  ) : null}
                  {reference.arxivId ? (
                    <a
                      className="ms-1"
                      href={`https://arxiv.org/abs/${reference.arxivId}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      arXiv
                    </a>
                  ) : null}
                  <button
                    className="btn btn-link btn-xs ms-1"
                    title="Remove from library"
                    onClick={() => deleteReference(reference._id)}
                  >
                    remove
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

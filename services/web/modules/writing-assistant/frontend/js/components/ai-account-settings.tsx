/**
 * e-INFRA AI account settings: per-user API token management and model
 * selection. The token is submitted over HTTPS to the Overleaf backend,
 * stored encrypted (never in localStorage, never returned to the browser,
 * never logged). Models are discovered dynamically via the user's token.
 */
import React, { useCallback, useEffect, useState } from 'react'
import getMeta from '@/utils/meta'

type Status = {
  connected: boolean
  model: string | null
  defaultModel: string
  baseUrl: string
}

export default function AiAccountSettings() {
  const [status, setStatus] = useState<Status | null>(null)
  const [token, setToken] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const userId = getMeta('ol-user_id')

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch('/user/ai/status')
      const data = await response.json()
      setStatus(data)
      setModel(data.model || data.defaultModel || 'mini')
      if (data.connected) {
        const modelsResponse = await fetch('/user/ai/models')
        if (modelsResponse.ok) {
          const modelsData = await modelsResponse.json()
          setModels(modelsData.models || [])
        }
      }
    } catch {
      setError('Could not load AI status')
    }
  }, [])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  const saveToken = useCallback(async () => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch('/user/ai/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || 'failed to save token')
      setToken('')
      setMessage('Token saved and verified.')
      await refreshStatus()
    } catch (err: any) {
      setError(err.message || 'failed to save token')
    } finally {
      setBusy(false)
    }
  }, [token, refreshStatus])

  const deleteToken = useCallback(async () => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch('/user/ai/token', { method: 'DELETE' })
      if (!response.ok) throw new Error('failed to delete token')
      setModels([])
      setMessage('Token deleted.')
      await refreshStatus()
    } catch (err: any) {
      setError(err.message || 'failed to delete token')
    } finally {
      setBusy(false)
    }
  }, [refreshStatus])

  const saveModel = useCallback(async (newModel: string) => {
    setModel(newModel)
    try {
      await fetch('/user/ai/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: newModel }),
      })
    } catch {
      // non-fatal: default model will be used
    }
  }, [])

  if (!userId) return null

  return (
    <div className="setting">
      <div className="setting-inner">
        <label className="control-label">
          <strong>AI Assistant</strong> (e-INFRA CZ)
        </label>

        <p className="small">
          Uses your personal e-INFRA CZ LLM API key (
          <a
            href="https://chat.ai.e-infra.cz"
            target="_blank"
            rel="noreferrer noopener"
          >
            generate one at chat.ai.e-infra.cz
          </a>
          , Settings → Account → API keys). AI requests are sent to the
          configured e-INFRA CZ LLM service{' '}
          {status ? <code>{status.baseUrl}</code> : null} and happen only
          when you invoke an AI action.
        </p>

        <p className="small">
          Status:{' '}
          {status === null ? (
            '…'
          ) : status.connected ? (
            <span className="text-success">
              <strong>Connected</strong> — token stored encrypted
            </span>
          ) : (
            <span className="text-danger">
              <strong>Not configured</strong> — AI actions will be unavailable
            </span>
          )}
        </p>

        <div className="form-group">
          <label className="control-label" htmlFor="ai-api-token">
            API key
          </label>
          <input
            id="ai-api-token"
            className="form-control"
            type="password"
            autoComplete="off"
            placeholder={status?.connected ? '•••••••• (saved)' : 'sk-…'}
            value={token}
            onChange={e => setToken(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label className="control-label" htmlFor="ai-model">
            Model
          </label>
          {models.length > 0 ? (
            <select
              id="ai-model"
              className="form-control"
              value={model}
              onChange={e => saveModel(e.target.value)}
            >
              {models.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="ai-model"
              className="form-control"
              value={model}
              onChange={e => saveModel(e.target.value)}
              placeholder="mini"
            />
          )}
          <p className="small">
            Models are discovered dynamically using your token (aliases such
            as <code>mini</code> are supported).
          </p>
        </div>

        {message && (
          <p className="small text-success" role="status">
            {message}
          </p>
        )}
        {error && (
          <p className="small text-danger" role="alert">
            {error}
          </p>
        )}

        <div className="btn-group">
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || token.trim().length < 10}
            onClick={saveToken}
          >
            {status?.connected ? 'Replace token' : 'Connect'}
          </button>
          {status?.connected && (
            <button
              className="btn btn-danger-ghost btn-sm"
              disabled={busy}
              onClick={deleteToken}
            >
              Delete token
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

import Settings from '@overleaf/settings'

// Minimal OpenAI-compatible client for the e-INFRA CZ LLM platform.
// Always authenticates with the CURRENT USER's token (decrypted by
// AiTokenManager), never with a deployment-wide credential.
const EInfraClient = {
  async listModels(token) {
    const response = await fetch(
      `${Settings.writingAssistant.aiBaseUrl.replace(/\/$/, '')}/models`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      }
    )
    if (!response.ok) {
      const error = new Error(
        `failed to list models (${response.status})`
      )
      error.statusCode = response.status === 401 ? 401 : 502
      throw error
    }
    const data = await response.json()
    return (data.data || []).map(model => model.id).filter(Boolean)
  },

  // Streaming chat completion. Returns the upstream Response; the caller
  // pipes the SSE body through to the client and must handle abortion.
  async chatCompletionStream({ token, model, messages, temperature }) {
    const response = await fetch(
      `${Settings.writingAssistant.aiBaseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: 2048,
          stream: true, // CERIT recommends streaming for API integrations
        }),
        signal: AbortSignal.timeout(Settings.writingAssistant.aiTimeout),
      }
    )
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const error = new Error(
        `AI provider error (${response.status}): ${detail.slice(0, 300)}`
      )
      error.statusCode = response.status === 401 ? 401 : 502
      throw error
    }
    return response
  },
}

// Non-streaming chat completion (returns the parsed OpenAI response)
const EInfraClientSync = {
  async chatCompletion({ token, model, messages, temperature }) {
    const response = await fetch(
      `${Settings.writingAssistant.aiBaseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(Settings.writingAssistant.aiTimeout),
      }
    )
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const error = new Error(
        `AI provider error (${response.status}): ${detail.slice(0, 300)}`
      )
      error.statusCode = response.status === 401 ? 401 : 502
      throw error
    }
    return response.json()
  },
}

export { EInfraClientSync }
export default EInfraClient

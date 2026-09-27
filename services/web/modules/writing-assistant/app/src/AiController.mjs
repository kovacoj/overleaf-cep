import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import OError from '@overleaf/o-error'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import AiTokenManager from './AiTokenManager.mjs'
import EInfraClient from './EInfraClient.mjs'
import { getCollectionInternal } from '../../../../app/src/infrastructure/mongodb.mjs'

// AI actions for the writing assistant. Each narrow endpoint:
//   1. requires an authenticated Overleaf user
//   2. decrypts THAT user's e-INFRA API token (404 if none configured)
//   3. builds a task-specific prompt that preserves LaTeX structure
//   4. streams the OpenAI-compatible SSE response through to the editor
//
// Privacy: only operational metadata is logged (user, action, model,
// latency, status) - never prompts, responses or tokens.

const SYSTEM_PROMPTS = {
  improve:
    'You are an academic writing assistant. Improve the academic English of the given LaTeX text while preserving its meaning and technical precision. PRESERVE all LaTeX structure exactly: keep \\cite{}, \\ref{}, \\label{}, \\eqref{}, commands, math expressions ($...$, \\[...\\]) and environment structure UNCHANGED unless the instruction explicitly concerns them. Return ONLY the rewritten text, no commentary.',
  grammar:
    'You are a grammar and style corrector. Fix grammatical and stylistic errors in the given LaTeX text. PRESERVE all LaTeX structure exactly: keep \\cite{}, \\ref{}, \\label{}, \\eqref{}, commands, math and environments UNCHANGED. Return ONLY the corrected text, no commentary.',
  concise:
    'You are an academic writing assistant. Make the given LaTeX text more concise while keeping all meaning and technical content. PRESERVE all LaTeX structure exactly (citations, references, labels, math, commands). Return ONLY the rewritten text, no commentary.',
  explain:
    'You are a helpful academic assistant. Explain the given text clearly and concisely. If it is LaTeX, explain what it does and what it renders to.',
  translate:
    'You are a professional translator for academic texts. Translate the given text to the requested target language, preserving LaTeX commands where present. Return ONLY the translation.',
  review:
    'You are an academic reviewer and writing coach, focused on scientific writing. Review the given paragraph. Structure your answer with these exact headings: Grammar, Clarity, Academic style, Ambiguity, Redundancy, Terminology, Logical flow. Under each heading give at most two short, concrete bullet points quoting the problematic text. Preserve technical meaning; do not invent facts or references; do not suggest changing notation unnecessarily.',
  'latex-fix':
    'You are a LaTeX expert. Fix the syntax errors in the given LaTeX. Return ONLY the corrected LaTeX, no commentary.',
  'latex-explain':
    'You are a LaTeX expert. Explain what the given LaTeX does, what it renders, and any pitfalls. Be concise.',
  equation:
    'You are a LaTeX expert. Generate the requested mathematical equation in LaTeX. Return ONLY the LaTeX (an equation environment or inline math as appropriate), no commentary or markdown fences.',
  table:
    'You are a LaTeX expert. Generate the requested table in LaTeX (use booktabs style \\toprule/\\midrule/\\bottomrule where suitable). Return ONLY the LaTeX, no commentary or markdown fences.',
  'compile-error':
    'You are a LaTeX debugging expert. Explain the given compilation error, identify its likely cause in the provided source lines, and suggest a concrete fix. Respond with three short sections: Explanation, Likely cause, Suggested fix.',
  chat:
    'You are a helpful academic writing assistant embedded in a LaTeX editor. Answer questions about the provided document or library context concisely and precisely. When referencing library items, cite them with their BibTeX keys (e.g. \\cite{key}); never invent references that are not in the provided context. When suggesting text changes, show them as LaTeX snippets or before/after examples rather than modifying anything. Preserve technical meaning, equations and citations.',
  'review-document':
    'You are a rigorous academic reviewer. Review the given LaTeX document. Structure your answer with these exact headings: Summary, Major issues, Minor issues, Questions for the author, Suggestions. Be specific and quote the relevant passages. Focus on clarity, methodology descriptions, mathematical rigor, consistency and academic style. Do not invent facts or references. Keep each section short and actionable.',
  custom:
    'You are an academic writing assistant working on LaTeX text. Follow the user instruction. PRESERVE LaTeX structure (citations, references, labels, math, commands) unless the instruction concerns it. Return ONLY the result text, no commentary.',
}

// Build a compact textual representation of the user's research library
// (from the research-library module's researchLibraryReferences
// collection) to serve as retrieval context for "ask my library".
async function buildLibraryContext(userId) {
  try {
    const collection = await getCollectionInternal(
      'researchLibraryReferences'
    )
    const entries = await collection
      .find({ userId: String(userId) })
      .sort({ key: 1 })
      .toArray()
    if (entries.length === 0) return '(library is empty)'
    return entries
      .map(
        entry =>
          `- \cite{${entry.key}}: ${entry.title || '(no title)'}${
            entry.authors && entry.authors.length
              ? ` — ${entry.authors.slice(0, 3).join(', ')}${
                  entry.authors.length > 3 ? ' et al.' : ''
                }`
              : ''
          }${entry.year ? ` (${entry.year})` : ''}${
            entry.venue ? `, ${entry.venue}` : ''
          }${entry.abstract ? `: ${entry.abstract.slice(0, 300)}` : ''
          }`
      )
      .join('\n')
  } catch {
    return '(library unavailable)'
  }
}

async function buildMessages(action, body) {
  const system = SYSTEM_PROMPTS[action]
  if (!system) {
    const error = new Error('unknown action')
    error.statusCode = 404
    throw error
  }
  const text = body.text ?? body.latex ?? ''
  switch (action) {
    case 'improve':
    case 'grammar':
    case 'concise':
    case 'custom':
      return [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `${action === 'custom' ? `Instruction: ${body.instruction || ''}\n\n` : ''}Text:\n${text}`,
        },
      ]
    case 'translate':
      return [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Target language: ${body.language || 'English'}\n\nText:\n${text}`,
        },
      ]
    case 'explain':
    case 'latex-explain':
    case 'review':
      return [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ]
    case 'latex-fix':
      return [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `LaTeX:\n${text}\n\nCompiler error (if any):\n${body.error || ''}`,
        },
      ]
    case 'equation':
    case 'table':
      return [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Request:\n${body.description || text}${body.data ? `\n\nData:\n${body.data}` : ''}`,
        },
      ]
    case 'compile-error':
      return [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Compiler: ${body.compiler || 'pdfLaTeX'}\n\nError:\n${body.error || ''}\n\nNearby source lines:\n${body.sourceLines || ''}`,
        },
      ]
    case 'chat': {
      // conversation history with optional document context
      const history = Array.isArray(body.messages)
        ? body.messages
            .filter(
              m =>
                m &&
                (m.role === 'user' || m.role === 'assistant') &&
                typeof m.content === 'string' &&
                m.content.length > 0
            )
            .slice(-20)
            .map(m => ({ role: m.role, content: m.content.slice(0, 16000) }))
        : []
      if (history.length === 0) {
        const error = new Error('messages is required')
        error.statusCode = 400
        throw error
      }
      const messages = [{ role: 'system', content: system }]
      let context = typeof body.context === 'string' ? body.context : ''
      if (body.library === true) {
        context = `The user's research library (BibTeX keys, titles, authors, abstracts):\n\n${await buildLibraryContext(
          body._userId
        )}\n\nWhen referencing a library item, use its \cite{key}.`
      }
      if (context) {
        messages.push({
          role: 'user',
          content: `Document context (for reference, do not repeat it):\n\n${context.slice(0, 40000)}`,
        })
        messages.push({
          role: 'assistant',
          content: 'Understood, I have the document context. How can I help?',
        })
      }
      messages.push(...history)
      return messages
    }
    case 'review-document':
      return [
        { role: 'system', content: system },
        { role: 'user', content: (body.text || '').slice(0, 60000) },
      ]
    default:
      const error = new Error('unhandled action')
      error.statusCode = 404
      throw error
  }
}

async function runAction(req, res, action) {
  const started = Date.now()
  const userId = SessionManager.getLoggedInUserId(req.session)

  let token
  try {
    token = await AiTokenManager.getToken(userId)
  } catch (err) {
    return res.status(500).json({ message: 'cannot read AI credentials' })
  }
  if (!token) {
    return res.status(404).json({
      message:
        'No e-INFRA AI token configured. Add your personal API key in Account Settings.',
    })
  }

  const model = (await AiTokenManager.getModel(userId)) ||
    Settings.writingAssistant.aiDefaultModel

  let messages
  try {
    messages = await buildMessages(action, {
      ...(req.body ?? {}),
      _userId: userId,
    })
  } catch (err) {
    return res.status(err.statusCode || 400).json({ message: err.message })
  }

  let upstream
  try {
    upstream = await EInfraClient.chatCompletionStream({
      token,
      model,
      messages,
      temperature: action === 'review' || action.includes('explain') ? 0.2 : 0.3,
    })
  } catch (err) {
    logger.warn(
      { err: OError.getFullStack(err), userId, action, model },
      'writing-assistant: AI request failed'
    )
    return res
      .status(err.statusCode || 502)
      .json({ message: err.message || 'AI request failed' })
  }

  // stream the upstream SSE through; abort upstream when the client goes away
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const pipe = (async () => {
    try {
      const reader = upstream.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    } catch (err) {
      // upstream aborted or timed out - metadata only
    } finally {
      logger.debug(
        { userId, action, model, latencyMs: Date.now() - started },
        'writing-assistant: AI request completed'
      )
      res.end()
    }
  })()
  req.on('close', () => {
    // client cancelled: stop the upstream request
    try {
      upstream.body?.cancel()
    } catch {
      // already finished
    }
  })
  return pipe
}

// ---- token + model management (Account Settings) ----

async function status(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const status = await AiTokenManager.getStatus(userId)
  res.json({
    connected: status.connected,
    model: status.model,
    defaultModel: Settings.writingAssistant.aiDefaultModel,
    baseUrl: Settings.writingAssistant.aiBaseUrl,
  })
}

async function saveToken(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { token } = req.body ?? {}
  if (typeof token !== 'string' || token.length < 10) {
    return res.status(400).json({ message: 'invalid token' })
  }
  // validate against the user's token before storing
  try {
    await EInfraClient.listModels(token)
  } catch (err) {
    return res.status(400).json({
      message: 'token rejected by the e-INFRA LLM API',
    })
  }
  await AiTokenManager.saveToken(userId, token)
  res.json({ connected: true })
}

async function deleteToken(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  await AiTokenManager.deleteToken(userId)
  res.json({ connected: false })
}

async function models(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const token = await AiTokenManager.getToken(userId)
  if (!token) {
    return res
      .status(404)
      .json({ message: 'No e-INFRA AI token configured' })
  }
  try {
    const models = await EInfraClient.listModels(token)
    res.json({ models })
  } catch (err) {
    return res
      .status(err.statusCode || 502)
      .json({ message: err.message || 'failed to list models' })
  }
}

async function setModel(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { model } = req.body ?? {}
  if (typeof model !== 'string' || !model) {
    return res.status(400).json({ message: 'model required' })
  }
  await AiTokenManager.setModel(userId, model)
  res.json({ model })
}

export default {
  runAction,
  status,
  saveToken,
  deleteToken,
  models,
  setModel,
}

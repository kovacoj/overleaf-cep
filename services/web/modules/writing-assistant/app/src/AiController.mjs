import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import OError from '@overleaf/o-error'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import AiTokenManager from './AiTokenManager.mjs'
import EInfraClient from './EInfraClient.mjs'
import { getCollectionInternal } from '../../../../app/src/infrastructure/mongodb.mjs'
import { EInfraClientSync } from './EInfraClient.mjs'

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

// Extract the first balanced JSON object from a model reply
function extractJson(text) {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    if (text[i] === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

async function _completion(userId, messages, temperature) {
  const token = await AiTokenManager.getToken(userId)
  if (!token) {
    const error = new Error(
      'No e-INFRA AI token configured. Add your personal API key in Account Settings.'
    )
    error.statusCode = 404
    throw error
  }
  const model =
    (await AiTokenManager.getModel(userId)) ||
    Settings.writingAssistant.aiDefaultModel
  const data = await EInfraClientSync.chatCompletion({
    token,
    model,
    messages,
    temperature,
  })
  const content = data.choices?.[0]?.message?.content || ''
  return { content, model: data.model || model }
}

// POST /user/ai/library-support {text}
// Which entries in the user's research library support or relate to the
// given manuscript statement? Retrieval-first: the library is provided as
// context; the model only selects and justifies. Never invents entries.
async function librarySupport(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { text } = req.body ?? {}
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ message: 'text is required' })
  }
  try {
    const library = await buildLibraryContext(userId)
    let matches = null
    for (let attempt = 0; attempt < 2 && !matches; attempt++) {
      const { content } = await _completion(
        userId,
        [
          {
            role: 'system',
            content:
              'You are an academic literature assistant. Given a manuscript statement and a list of library entries, select the entries that support, relate to or would be appropriate to cite for the statement. Respond ONLY with JSON in the form {"matches": [{"key": "bibtex-key", "reason": "one sentence"}]}. Use only keys from the provided list; never invent keys. If nothing matches, return {"matches": []}.',
          },
          {
            role: 'user',
            content: `Statement:\n${text.slice(0, 4000)}\n\nLibrary:\n${library}`,
          },
        ],
        0.1
      )
      const parsed = extractJson(content)
      if (parsed && Array.isArray(parsed.matches)) {
        matches = parsed.matches
          .filter(m => m && typeof m.key === 'string')
          .slice(0, 8)
          .map(m => ({
            key: m.key,
            reason: typeof m.reason === 'string' ? m.reason : '',
          }))
      }
    }
    if (!matches) {
      return res
        .status(502)
        .json({ message: 'could not parse the model response' })
    }
    res.json({ matches })
  } catch (err) {
    res.status(err.statusCode || 502).json({ message: err.message })
  }
}

// POST /user/ai/literature-search {text}
// LLM extracts scholarly search queries, then Crossref is searched
// server-side. Results include generated BibTeX and can be added to the
// library from the UI.
async function literatureSearch(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { text } = req.body ?? {}
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ message: 'text is required' })
  }
  try {
    let queries = null
    for (let attempt = 0; attempt < 2 && !queries; attempt++) {
      const { content } = await _completion(
        userId,
        [
          {
            role: 'system',
            content:
              'You are an academic search assistant. Given a manuscript statement or topic, generate 2 short scholarly search queries (as used on Crossref). Respond ONLY with JSON in the form {"queries": ["query one", "query two"]}.',
          },
          { role: 'user', content: text.slice(0, 4000) },
        ],
        0.2
      )
      const parsed = extractJson(content)
      if (
        parsed &&
        Array.isArray(parsed.queries) &&
        parsed.queries.length > 0
      ) {
        queries = parsed.queries
          .filter(q => typeof q === 'string')
          .slice(0, 3)
      }
    }
    if (!queries) {
      return res
        .status(502)
        .json({ message: 'could not parse the model response' })
    }

    // search Crossref for each query, dedup by DOI
    const seen = new Set()
    const results = []
    for (const query of queries) {
      const url = new URL(Settings.writingAssistant.crossrefUrl)
      url.searchParams.set('query.bibliographic', query)
      url.searchParams.set('rows', '3')
      const response = await fetch(url, {
        headers: {
          'user-agent':
            'Overleaf-CE-Research-Library/1.0 (mailto:noreply@example.com)',
        },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) continue
      const data = await response.json()
      for (const item of data.message?.items || []) {
        const doi = item.DOI || ''
        if (!doi || seen.has(doi)) continue
        seen.add(doi)
        const authors = (item.author || []).map(a =>
          [a.family, a.given].filter(Boolean).join(', ')
        )
        const year =
          item.issued?.['date-parts']?.[0]?.[0] || null
        const title = item.title?.[0] || ''
        const entryType =
          item.type === 'journal-article'
            ? 'article'
            : item.type === 'proceedings-article'
              ? 'inproceedings'
              : 'misc'
        const venue = item['container-title']?.[0] || ''
        const key = `${(authors[0] || 'unknown').split(',')[0].replace(/[^a-zA-Z]/g, '')}${year || 'nd'}${title.replace(/[^a-zA-Z]/g, '').slice(0, 1).toUpperCase() || ''}`
        results.push({
          key,
          title,
          authors,
          year,
          venue,
          doi,
          entryType,
          url: `https://doi.org/${doi}`,
          reason: query,
        })
      }
    }
    res.json({ queries, results: results.slice(0, 8) })
  } catch (err) {
    res.status(err.statusCode || 502).json({ message: err.message })
  }
}

// POST /user/ai/missing-citations {text}
// Scan text for claims that would typically require a citation.
// Suggestions only - nothing is inserted automatically.
async function missingCitations(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { text } = req.body ?? {}
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ message: 'text is required' })
  }
  try {
    let claims = null
    for (let attempt = 0; attempt < 2 && !claims; attempt++) {
      const { content } = await _completion(
        userId,
        [
          {
            role: 'system',
            content:
              'You are an academic reviewer. Identify statements in the given text that would typically require a citation in a scholarly paper (established results, factual claims, attributions of methods, "it is known" claims). Do NOT flag the author\'s own contributions, hypotheses, or descriptions of their own work. Respond ONLY with JSON: {"claims": [{"quote": "exact short quote from the text", "classification": "probably-needs-citation" | "possibly-needs-citation" | "likely-common-knowledge", "suggestion": "what kind of source would fit"}]}. Quote at most 15 words per claim. Return at most 10 claims.',
          },
          { role: 'user', content: text.slice(0, 30000) },
        ],
        0.2
      )
      const parsed = extractJson(content)
      if (parsed && Array.isArray(parsed.claims)) {
        claims = parsed.claims
          .filter(
            c =>
              c &&
              typeof c.quote === 'string' &&
              typeof c.classification === 'string'
          )
          .slice(0, 10)
          .map(c => ({
            quote: c.quote,
            classification: c.classification,
            suggestion: typeof c.suggestion === 'string' ? c.suggestion : '',
          }))
      }
    }
    if (!claims) {
      return res
        .status(502)
        .json({ message: 'could not parse the model response' })
    }
    res.json({ claims })
  } catch (err) {
    res.status(err.statusCode || 502).json({ message: err.message })
  }
}

// POST /user/ai/verify-citations {text}
// For each \cite{...} in the text, check whether the cited library entry
// (title + abstract) plausibly supports the claim it is attached to.
// Cautious verdicts: abstract-only coverage is reported as insufficient
// evidence, never as a mismatch.
async function verifyCitations(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { text } = req.body ?? {}
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ message: 'text is required' })
  }

  // collect citations with surrounding context
  const contexts = []
  const regex = /\\cite[tp]?\{([^}]*)\}/g
  let match
  while ((match = regex.exec(text)) !== null) {
    const keys = match[1].split(',').map(k => k.trim()).filter(Boolean)
    const from = Math.max(0, match.index - 250)
    const to = Math.min(text.length, match.index + match[0].length + 250)
    for (const key of keys.slice(0, 3)) {
      contexts.push({ key, context: text.slice(from, to) })
    }
    if (contexts.length >= 15) break
  }

  if (contexts.length === 0) {
    return res.json({ checks: [] })
  }

  try {
    // fetch library entries for the cited keys
    const collection = await getCollectionInternal(
      'researchLibraryReferences'
    )
    const entries = await collection
      .find({ userId: String(userId) })
      .toArray()
    const byKey = new Map(entries.map(e => [e.key, e]))

    const checks = []
    const toVerify = []
    for (const { key, context } of contexts) {
      const entry = byKey.get(key)
      if (!entry) {
        checks.push({
          key,
          verdict: 'not-in-library',
          note: 'The cited key is not in your research library.',
          context,
        })
      } else {
        toVerify.push({
          key,
          title: entry.title || '',
          abstract: (entry.abstract || '').slice(0, 500),
          context,
        })
      }
    }

    if (toVerify.length > 0) {
      let verdicts = null
      for (let attempt = 0; attempt < 2 && !verdicts; attempt++) {
        const { content } = await _completion(
          userId,
          [
            {
              role: 'system',
              content:
                'You are an academic citation verifier. For each numbered item you get a claim from a manuscript (with context) and the cited work (title and, when available, abstract). Judge whether the cited source supports the claim it is attached to. Respond ONLY with JSON: {"verdicts": [{"index": 0, "verdict": "supported" | "partially-supported" | "insufficient-evidence" | "potential-mismatch", "note": "one sentence"}]}. Be cautious: if only a title/abstract is available and it does not clearly cover the claim, use "insufficient-evidence" rather than "potential-mismatch".',
            },
            {
              role: 'user',
              content: toVerify
                .map(
                  (item, index) =>
                    `[${index}] Claim/context: "${item.context.replace(/\s+/g, ' ').slice(0, 400)}"\n    Cited: ${item.key} — ${item.title}${item.abstract ? `\n    Abstract: ${item.abstract}` : ' (no abstract available)'}`
                )
                .join('\n\n'),
            },
          ],
          0.2
        )
        const parsed = extractJson(content)
        if (parsed && Array.isArray(parsed.verdicts)) {
          verdicts = parsed.verdicts
        }
      }
      if (verdicts) {
        toVerify.forEach((item, index) => {
          const verdict = verdicts.find(v => v.index === index) || {}
          checks.push({
            key: item.key,
            title: item.title,
            verdict: verdict.verdict || 'insufficient-evidence',
            note: typeof verdict.note === 'string' ? verdict.note : '',
            context: item.context,
          })
        })
      } else {
        toVerify.forEach(item => {
          checks.push({
            key: item.key,
            title: item.title,
            verdict: 'unverified',
            note: 'The model response could not be parsed.',
            context: item.context,
          })
        })
      }
    }

    res.json({ checks })
  } catch (err) {
    res.status(err.statusCode || 502).json({ message: err.message })
  }
}

export default {
  runAction,
  librarySupport,
  literatureSearch,
  missingCitations,
  verifyCitations,
  status,
  saveToken,
  deleteToken,
  models,
  setModel,
}

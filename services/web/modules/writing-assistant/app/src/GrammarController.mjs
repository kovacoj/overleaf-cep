import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import OError from '@overleaf/o-error'
import { fetchJsonWithResponse } from '@overleaf/fetch-utils'

const GRAMMAR_CATEGORIES = new Set([
  'TYPOS',
  'GRAMMAR',
  'PUNCTUATION',
  'TYPOGRAPHY',
])

// POST /user/writing/grammar  { text, language }
// -> { matches: [{ offset, length, message, shortMessage, replacements,
//                  ruleId, category, isStyle }] }
//
// Proxies to the internal LanguageTool service; the browser never talks to
// LanguageTool directly.
async function checkGrammar(req, res) {
  const { text, language } = req.body ?? {}
  if (typeof text !== 'string' || text.length === 0) {
    return res.status(400).json({ message: 'text is required' })
  }
  if (text.length > Settings.writingAssistant.maxTextLength) {
    return res.status(413).json({ message: 'text too long' })
  }

  const params = new URLSearchParams()
  params.set(
    'language',
    typeof language === 'string' && language ? language : 'en-US'
  )
  params.set('text', text)

  try {
    const { json } = await fetchJsonWithResponse(
      new URL('/v2/check', Settings.writingAssistant.languageToolUrl),
      {
        method: 'POST',
        body: params,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(
          Settings.writingAssistant.languageToolTimeout
        ),
      }
    )
    const matches = (json.matches || []).map(match => ({
      offset: match.offset,
      length: match.length,
      message: match.message,
      shortMessage: match.shortMessage,
      replacements: (match.replacements || [])
        .slice(0, 5)
        .map(r => r.value),
      ruleId: match.rule?.id || '',
      category: match.rule?.category?.name || match.rule?.category?.id || '',
      isStyle: !GRAMMAR_CATEGORIES.has(match.rule?.category?.id || ''),
    }))
    res.json({ matches })
  } catch (err) {
    logger.warn(
      { err: OError.getFullStack(err) },
      'writing-assistant: LanguageTool check failed'
    )
    const status = err.response?.status ?? 502
    res.status(status).json({ message: 'grammar check service unavailable' })
  }
}

export default { checkGrammar }

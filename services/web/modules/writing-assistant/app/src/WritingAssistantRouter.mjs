import { expressify } from '@overleaf/promise-utils'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import GrammarController from './GrammarController.mjs'
import AiController from './AiController.mjs'

const grammarRateLimiter = new RateLimiter('writing-assistant-grammar', {
  points: 60,
  duration: 60,
})

const aiRateLimiter = new RateLimiter('writing-assistant-ai', {
  points: 20,
  duration: 60,
})

// Narrow, authenticated endpoints only. No generic LLM proxy, no
// arbitrary target URLs.
const AI_ACTIONS = [
  ['improve', 'improve'],
  ['grammar', 'grammar'],
  ['concise', 'concise'],
  ['explain', 'explain'],
  ['translate', 'translate'],
  ['review', 'review'],
  ['custom', 'custom'],
  ['latex/fix', 'latex-fix'],
  ['latex/explain', 'latex-explain'],
  ['equation', 'equation'],
  ['table', 'table'],
  ['compile-error', 'compile-error'],
  ['chat', 'chat'],
  ['review', 'review-document'],
]

export default {
  apply(webRouter) {
    // grammar/style checking (LanguageTool, proxied)
    webRouter.post(
      '/user/writing/grammar',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(grammarRateLimiter),
      expressify(GrammarController.checkGrammar)
    )

    // per-user AI credentials + model selection (Account Settings)
    webRouter.get(
      '/user/ai/status',
      AuthenticationController.requireLogin(),
      expressify(AiController.status)
    )
    webRouter.post(
      '/user/ai/token',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(aiRateLimiter),
      expressify(AiController.saveToken)
    )
    webRouter.delete(
      '/user/ai/token',
      AuthenticationController.requireLogin(),
      expressify(AiController.deleteToken)
    )
    webRouter.get(
      '/user/ai/models',
      AuthenticationController.requireLogin(),
      expressify(AiController.models)
    )
    webRouter.post(
      '/user/ai/model',
      AuthenticationController.requireLogin(),
      expressify(AiController.setModel)
    )

    // AI actions (streamed, per-user token, explicit invocation only)
    for (const [route, action] of AI_ACTIONS) {
      webRouter.post(
        `/user/ai/${route}`,
        AuthenticationController.requireLogin(),
        RateLimiterMiddleware.rateLimit(aiRateLimiter),
        (req, res, next) => {
          AiController.runAction(req, res, action).catch(next)
        }
      )
    }
  },
}

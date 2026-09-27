import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'

// Writing assistant:
//  - continuous grammar/style checking via a self-hosted LanguageTool
//    service (ClusterIP-internal, proxied by this backend)
//  - explicit AI actions via each user's own e-INFRA CZ LLM API token
//    (OpenAI-compatible endpoint, token stored encrypted per user)
//
// Enabled with WRITING_ASSISTANT_ENABLED=true. Nothing is exposed publicly
// except through authenticated web routes in this module.
let WritingAssistantModule = {}
if (process.env.WRITING_ASSISTANT_ENABLED === 'true') {
  logger.debug({}, 'Enabling writing-assistant module')

  const [{ default: WritingAssistantRouter }] = await Promise.all([
    import('./app/src/WritingAssistantRouter.mjs'),
  ])

  Settings.writingAssistant = {
    languageToolUrl:
      process.env.LANGUAGETOOL_URL || 'http://languagetool:8081',
    languageToolTimeout: parseInt(
      process.env.LANGUAGETOOL_TIMEOUT || '10000',
      10
    ),
    maxTextLength: parseInt(
      process.env.LANGUAGETOOL_MAX_TEXT_LENGTH || '30000',
      10
    ),
    aiBaseUrl:
      process.env.E_INFRA_LLM_BASE_URL || 'https://llm.ai.e-infra.cz/v1',
    aiTimeout: parseInt(process.env.E_INFRA_LLM_TIMEOUT || '150000', 10),
    aiDefaultModel: process.env.E_INFRA_LLM_DEFAULT_MODEL || 'mini',
    crossrefUrl:
      process.env.CROSSREF_API_URL || 'https://api.crossref.org/works',
  }

  WritingAssistantModule = {
    router: WritingAssistantRouter,
  }
}

export default WritingAssistantModule

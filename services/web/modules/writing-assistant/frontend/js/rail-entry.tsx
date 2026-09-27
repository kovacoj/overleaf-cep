/**
 * Rail entry for the AI Assistant panel (registered via the
 * `railEntries` module import key).
 */
import AIAssistantPanel from './components/ai-assistant-panel'

import type { RailElement } from '@/features/ide-react/util/rail-types'

const aiAssistantRailEntry: RailElement = {
  key: 'ai-assistant',
  icon: 'smart_toy',
  title: 'AI Assistant',
  component: <AIAssistantPanel />,
}

export default aiAssistantRailEntry

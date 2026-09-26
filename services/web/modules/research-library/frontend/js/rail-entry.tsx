/**
 * Rail entry for the Research Library panel (registered via the
 * `railEntries` module import key).
 */
import ResearchLibraryPanel from './components/research-library-panel'

import type { RailElement } from '@/features/ide-react/util/rail-types'

const researchLibraryRailEntry: RailElement = {
  key: 'research-library',
  icon: 'auto_stories',
  title: 'Research Library',
  component: <ResearchLibraryPanel />,
}

export default researchLibraryRailEntry

import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'

// Shared Research Library: a personal, searchable bibliography that can be
// reused across all projects. Entries are added from pasted BibTeX, or
// resolved from a DOI / arXiv ID / title via Crossref and the arXiv API.
// The library can be materialized into any project as a library.bib file.
//
// Enabled with RESEARCH_LIBRARY_ENABLED=true. Data lives in MongoDB
// (researchLibraryReferences collection, one scope per user for now;
// group scopes are a future extension).
let ResearchLibraryModule = {}
if (process.env.RESEARCH_LIBRARY_ENABLED === 'true') {
  logger.debug({}, 'Enabling research-library module')

  const [{ default: ResearchLibraryRouter }] = await Promise.all([
    import('./app/src/ResearchLibraryRouter.mjs'),
  ])

  Settings.researchLibrary = {
    crossrefUrl:
      process.env.CROSSREF_API_URL || 'https://api.crossref.org/works',
    arxivUrl:
      process.env.ARXIV_API_URL || 'https://export.arxiv.org/api/query',
    lookupTimeout: parseInt(process.env.REFERENCE_LOOKUP_TIMEOUT || '15000', 10),
    maxEntriesPerUser: parseInt(
      process.env.RESEARCH_LIBRARY_MAX_ENTRIES || '20000',
      10
    ),
    pdfRoot:
      process.env.RESEARCH_LIBRARY_PDF_ROOT ||
      '/var/lib/overleaf/data/research-library',
  }

  ResearchLibraryModule = {
    router: ResearchLibraryRouter,
  }
}

export default ResearchLibraryModule

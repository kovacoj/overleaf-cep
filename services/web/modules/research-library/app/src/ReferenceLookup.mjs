import Settings from '@overleaf/settings'
import { entryToBibtex } from './BibtexParser.mjs'

// Metadata resolution via Crossref and the arXiv API.
// Input: a DOI (bare or as doi.org URL), an arXiv id (bare or as arxiv.org
// URL), or a free-text title query.
// Output: normalized reference fields + generated BibTeX (preview only,
// nothing is stored here).

function extractDoi(input) {
  const trimmed = String(input || '').trim()
  if (/^10\.\d{4,9}\//.test(trimmed)) return trimmed
  const match = trimmed.match(/doi\.org\/(10\.[^\s?#]+)/i)
  return match ? match[1] : null
}

function extractArxivId(input) {
  const trimmed = String(input || '').trim()
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(trimmed)) return trimmed
  const match = trimmed.match(/arxiv\.org\/abs\/([^\s?#]+)/i)
  return match ? match[1] : null
}

async function crossrefGet(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Overleaf-CE-Research-Library/1.0 (mailto:noreply@example.com)',
    },
    signal: AbortSignal.timeout(Settings.researchLibrary.lookupTimeout),
  })
  if (!response.ok) {
    const error = new Error(`crossref error (${response.status})`)
    error.statusCode = response.status === 404 ? 404 : 502
    throw error
  }
  return response.json()
}

function crossrefToEntry(message) {
  const authors = (message.author || []).map(a =>
    [a.family, a.given].filter(Boolean).join(', ')
  )
  const year =
    message.issued && message.issued['date-parts']
      ? message.issued['date-parts'][0][0]
      : null
  const typeMap = {
    'journal-article': 'article',
    'proceedings-article': 'inproceedings',
    'book-chapter': 'incollection',
    book: 'book',
  }
  const entryType = typeMap[message.type] || 'misc'
  const entry = {
    key: '',
    entryType,
    title: (message.title && message.title[0]) || '',
    authors,
    year,
    venue: (message['container-title'] && message['container-title'][0]) || '',
    doi: message.DOI || '',
    arxivId: '',
    url: message.URL || (message.DOI ? `https://doi.org/${message.DOI}` : ''),
    abstract: (message.abstract || '').replace(/<[^>]+>/g, '').trim(),
  }
  entry.key = buildCitationKey(entry)
  entry.bibtex = entryToBibtex(entry)
  return entry
}

function buildCitationKey(entry) {
  const firstAuthor =
    (entry.authors && entry.authors[0] || 'unknown')
      .split(',')[0]
      .replace(/[^a-zA-Z]/g, '') || 'unknown'
  const year = entry.year || 'nd'
  const word =
    (entry.title || '')
      .split(/\s+/)
      .find(w => w.length > 3) || ''
  const cleaned = word.replace(/[^a-zA-Z]/g, '').toLowerCase()
  const suffix = cleaned ? `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}` : ''
  return `${firstAuthor}${year}${suffix}`
}

async function lookupCrossrefByDoi(doi) {
  const data = await crossrefGet(
    `${Settings.researchLibrary.crossrefUrl}/${encodeURIComponent(doi)}`
  )
  return crossrefToEntry(data.message)
}

async function lookupCrossrefByTitle(title) {
  const url = new URL(Settings.researchLibrary.crossrefUrl)
  url.searchParams.set('query.bibliographic', title)
  url.searchParams.set('rows', '1')
  const data = await crossrefGet(url.toString())
  const item = data.message && data.message.items && data.message.items[0]
  if (!item) {
    const error = new Error('no results found')
    error.statusCode = 404
    throw error
  }
  return crossrefToEntry(item)
}

async function lookupArxiv(arxivId) {
  const url = new URL(Settings.researchLibrary.arxivUrl)
  url.searchParams.set('id_list', arxivId)
  const response = await fetch(url, {
    signal: AbortSignal.timeout(Settings.researchLibrary.lookupTimeout),
  })
  if (!response.ok) {
    throw new Error(`arxiv error (${response.status})`)
  }
  const xml = await response.text()
  const entryMatch = xml.match(/<entry>[\s\S]*?<\/entry>/)
  if (!entryMatch) {
    const error = new Error('arxiv entry not found')
    error.statusCode = 404
    throw error
  }
  const entryXml = entryMatch[0]
  const pick = tag =>
    ((entryXml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1] || '')
      .replace(/\s+/g, ' ')
      .trim()
  const authors = [...entryXml.matchAll(/<name>([^<]+)<\/name>/g)].map(m =>
    m[1].trim()
  )
  const published = pick('published')
  const year = published ? parseInt(published.slice(0, 4), 10) : null
  const entry = {
    key: '',
    entryType: 'article',
    title: pick('title'),
    authors,
    year,
    venue: 'arXiv',
    doi: '',
    arxivId,
    url: `https://arxiv.org/abs/${arxivId}`,
    abstract: pick('summary'),
  }
  entry.key = buildCitationKey(entry)
  entry.bibtex = entryToBibtex(entry)
  return entry
}

export async function lookupReference(query) {
  const doi = extractDoi(query)
  if (doi) return lookupCrossrefByDoi(doi)
  const arxivId = extractArxivId(query)
  if (arxivId) return lookupArxiv(arxivId)
  if (query && query.length > 4) {
    return lookupCrossrefByTitle(query)
  }
  const error = new Error('provide a DOI, arXiv id/URL or a title')
  error.statusCode = 400
  throw error
}

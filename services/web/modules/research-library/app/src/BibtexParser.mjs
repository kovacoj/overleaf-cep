// Compact BibTeX parser: extracts @type{key, field = {...}, ...} entries
// with balanced braces. No external dependencies. Field names are
// normalized to lower case; values have surrounding braces stripped.

const NON_ENTRY_TYPES = new Set(['comment', 'string', 'preamble'])

function findMatchingBrace(text, start) {
  // start points at the opening brace; returns index of the matching close
  let depth = 0
  let i = start
  let inQuotes = false
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (inQuotes) {
      if (ch === '"') inQuotes = false
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

function cleanValue(value) {
  let v = value.trim()
  if (v.startsWith('{') && v.endsWith('}')) {
    v = v.slice(1, -1)
  } else if (v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1)
  }
  return v.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
}

export function parseBibtexEntries(text) {
  const entries = []
  const errors = []
  let pos = 0

  while (pos < text.length) {
    const at = text.indexOf('@', pos)
    if (at === -1) break

    const braceOpen = text.indexOf('{', at)
    if (braceOpen === -1) break
    const entryType = text.slice(at + 1, braceOpen).trim().toLowerCase()

    const braceClose = findMatchingBrace(text, braceOpen)
    if (braceClose === -1) {
      errors.push({ position: at, message: 'unbalanced braces' })
      break
    }

    if (!NON_ENTRY_TYPES.has(entryType) && entryType.length > 0) {
      const body = text.slice(braceOpen + 1, braceClose)
      const commaIdx = body.indexOf(',')
      if (commaIdx === -1) {
        errors.push({ key: body.trim(), message: 'entry has no fields' })
      } else {
        const key = body.slice(0, commaIdx).trim()
        const fields = {}
        const rawFields = body.slice(commaIdx + 1)

        let i = 0
        while (i < rawFields.length) {
          // field name
          const eq = rawFields.indexOf('=', i)
          if (eq === -1) break
          const name = rawFields.slice(i, eq).trim().toLowerCase()
          if (!/^[a-z-]+$/.test(name)) {
            i = eq + 1
            continue
          }
          // value
          let j = eq + 1
          while (j < rawFields.length && /\s/.test(rawFields[j])) j++
          let valueEnd = -1
          if (rawFields[j] === '{') {
            const close = findMatchingBrace(rawFields, j)
            if (close === -1) break
            valueEnd = close + 1
          } else if (rawFields[j] === '"') {
            const close = rawFields.indexOf('"', j + 1)
            if (close === -1) break
            valueEnd = close + 1
          } else {
            // bare value (number or abbreviation) until comma
            const comma = rawFields.indexOf(',', j)
            valueEnd = comma === -1 ? rawFields.length : comma
          }
          const value = cleanValue(rawFields.slice(j, valueEnd))
          if (!(name in fields)) {
            fields[name] = value
          }
          // advance to next field
          let k = valueEnd
          while (k < rawFields.length && rawFields[k] !== ',') k++
          i = k + 1
        }

        if (key) {
          entries.push({
            key,
            type: entryType,
            fields,
            raw: `@${entryType}{${body}}`,
          })
        }
      }
    }
    pos = braceClose + 1
  }

  return { entries, errors }
}

// Normalize a parsed entry into the library record shape
export function normalizeEntry({ key, type, fields, raw }) {
  const authors = (fields.author || '')
    .split(/\s+and\s+/i)
    .map(author => author.trim())
    .filter(Boolean)
  const title = fields.title || fields.booktitle || ''
  const year = parseInt(fields.year, 10) || null
  const venue =
    fields.journal || fields.booktitle || fields.publisher || ''
  return {
    key,
    entryType: type,
    title,
    authors,
    year,
    venue,
    doi: (fields.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''),
    arxivId: fields.eprint || fields.arxivid || '',
    url: fields.url || '',
    abstract: fields.abstract || '',
    bibtex: raw || '',
  }
}

export function entryToBibtex(entry) {
  const lines = [`@${entry.entryType || 'misc'}{${entry.key},`]
  const fieldOrder = [
    'author',
    'title',
    'journal',
    'booktitle',
    'year',
    'venue',
    'doi',
    'eprint',
    'url',
    'abstract',
  ]
  const emit = (name, value) => {
    if (value) {
      lines.push(`  ${name} = {${value}},`)
    }
  }
  if (entry.authors && entry.authors.length > 0) {
    emit('author', entry.authors.join(' and '))
  }
  emit('title', entry.title)
  if (entry.venue) {
    if (entry.entryType === 'article') {
      emit('journal', entry.venue)
    } else {
      emit('booktitle', entry.venue)
    }
  }
  emit('year', entry.year)
  emit('doi', entry.doi)
  if (entry.arxivId) {
    lines.push(`  eprint = {${entry.arxivId}},`)
    lines.push(`  archivePrefix = {arXiv},`)
  }
  emit('url', entry.url)
  lines.push('}')
  return lines.join('\n')
}

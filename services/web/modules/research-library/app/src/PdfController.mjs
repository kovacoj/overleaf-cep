import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import OError from '@overleaf/o-error'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import Path from 'node:path'
import { spawn } from 'node:child_process'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import { getCollectionInternal } from '../../../../app/src/infrastructure/mongodb.mjs'

// PDFs associated with library entries. Files live under
// Settings.researchLibrary.pdfRoot on the persistent volume:
//   <pdfRoot>/<userId>/<referenceId>.pdf   (original upload)
//   <pdfRoot>/<userId>/<referenceId>.txt   (extracted text, regenerable)
//
// Text extraction uses pdftotext (poppler-utils). Paths are built only
// from validated ObjectIds and userIds - no user-controlled path parts.

const MAX_PDF_SIZE = 25 * 1024 * 1024

const _userId = userId => String(userId)

function _storageDir(userId, referenceId) {
  return Path.join(
    Settings.researchLibrary.pdfRoot,
    _userId(userId),
    `${referenceId}`
  )
}

async function _runPdftotext(pdfPath, txtPath) {
  await new Promise((resolve, reject) => {
    const child = spawn('pdftotext', ['-q', pdfPath, txtPath])
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`pdftotext failed (${code})`))
    })
  })
}

async function _getEntry(userId, referenceId) {
  const collection = await getCollectionInternal('researchLibraryReferences')
  const { ObjectId } = await import('mongodb')
  let objectId
  try {
    objectId = new ObjectId(referenceId)
  } catch {
    return null
  }
  return await collection.findOne({
    _id: objectId,
    userId: _userId(userId),
  })
}

async function _setHasPdf(userId, referenceId, hasPdf) {
  const collection = await getCollectionInternal('researchLibraryReferences')
  const { ObjectId } = await import('mongodb')
  await collection.updateOne(
    { _id: new ObjectId(referenceId), userId: _userId(userId) },
    { $set: { hasPdf, updatedAt: new Date() } }
  )
}

// POST /user/research-library/references/:referenceId/pdf (multipart qqfile)
async function uploadPdf(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { referenceId } = req.params
  const entry = await _getEntry(userId, referenceId)
  if (!entry) {
    return res.status(404).json({ message: 'reference not found' })
  }
  const upload = req.file
  if (!upload || !upload.path) {
    return res.status(400).json({ message: 'no file uploaded' })
  }
  try {
    const stat = await fsp.stat(upload.path)
    if (stat.size > MAX_PDF_SIZE) {
      await fsp.unlink(upload.path).catch(() => {})
      return res.status(413).json({ message: 'PDF too large (max 25 MB)' })
    }
    // sanity check: is it a PDF?
    const header = await fsp.readFile(upload.path, { encoding: null }).then(
      buf => buf.subarray(0, 5).toString('latin1')
    )
    if (!header.startsWith('%PDF')) {
      await fsp.unlink(upload.path).catch(() => {})
      return res.status(400).json({ message: 'not a PDF file' })
    }

    const dir = Path.dirname(_storageDir(userId, referenceId))
    await fsp.mkdir(dir, { recursive: true })
    const pdfPath = `${_storageDir(userId, referenceId)}.pdf`
    const txtPath = `${_storageDir(userId, referenceId)}.txt`
    await fsp.copyFile(upload.path, pdfPath)
    await _runPdftotext(pdfPath, txtPath)
    await _setHasPdf(userId, referenceId, true)
    const textStat = await fsp.stat(txtPath).catch(() => null)
    res.json({
      hasPdf: true,
      textChars: textStat ? textStat.size : 0,
    })
  } catch (err) {
    logger.warn(
      { err: OError.getFullStack(err), userId, referenceId },
      'research-library: PDF upload failed'
    )
    res.status(500).json({ message: 'failed to store PDF' })
  } finally {
    await fsp.unlink(upload.path).catch(() => {})
  }
}

// GET /user/research-library/references/:referenceId/pdf
async function downloadPdf(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { referenceId } = req.params
  const entry = await _getEntry(userId, referenceId)
  if (!entry || !entry.hasPdf) {
    return res.status(404).json({ message: 'no PDF' })
  }
  const pdfPath = `${_storageDir(userId, referenceId)}.pdf`
  try {
    await fsp.access(pdfPath)
  } catch {
    return res.status(404).json({ message: 'no PDF' })
  }
  const safeName = (entry.key || 'paper').replace(/[^a-zA-Z0-9_-]/g, '_')
  res.setHeader('content-type', 'application/pdf')
  res.attachment(`${safeName}.pdf`)
  fs.createReadStream(pdfPath).pipe(res)
}

// GET /user/research-library/references/:referenceId/text
// (used by the AI ask-paper action; owner only)
async function getText(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { referenceId } = req.params
  const entry = await _getEntry(userId, referenceId)
  if (!entry || !entry.hasPdf) {
    return res.status(404).json({ message: 'no PDF' })
  }
  try {
    const text = await fsp.readFile(
      `${_storageDir(userId, referenceId)}.txt`,
      'utf8'
    )
    res.json({ text })
  } catch {
    res.status(404).json({ message: 'no extracted text' })
  }
}

// DELETE /user/research-library/references/:referenceId/pdf
async function deletePdf(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { referenceId } = req.params
  const entry = await _getEntry(userId, referenceId)
  if (!entry) {
    return res.status(404).json({ message: 'reference not found' })
  }
  await Promise.all([
    fsp.unlink(`${_storageDir(userId, referenceId)}.pdf`).catch(() => {}),
    fsp.unlink(`${_storageDir(userId, referenceId)}.txt`).catch(() => {}),
  ])
  await _setHasPdf(userId, referenceId, false)
  res.json({ hasPdf: false })
}

// Internal helper for the writing-assistant ask-paper action
export async function readPaperText(userId, referenceId) {
  const entry = await _getEntry(userId, referenceId)
  if (!entry) return null
  try {
    const text = await fsp.readFile(
      `${_storageDir(userId, referenceId)}.txt`,
      'utf8'
    )
    return { entry, text }
  } catch {
    return { entry, text: null }
  }
}

export default {
  uploadPdf,
  downloadPdf,
  getText,
  deletePdf,
}

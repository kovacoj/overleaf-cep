import logger from '@overleaf/logger'
import fs from 'node:fs'
import crypto from 'node:crypto'
import Path from 'node:path'
import AccessTokenEncryptorClass from '@overleaf/access-token-encryptor'
import { getCollectionInternal } from '../../../../app/src/infrastructure/mongodb.mjs'

// Per-user e-INFRA LLM API token storage. Tokens are encrypted at rest with
// a deployment-level key (AI_TOKEN_CIPHER_PASSWORD secret) and are NEVER
// returned to the browser, written to logs, or embedded in frontend code.
//
// Mongo collection: writingAssistantSettings
//   { userId, encryptedToken (encrypted {token}), model }

const TOKEN_CIPHER_FILE = '/var/lib/overleaf/data/.ai-token-cipher.json'
const TOKEN_CIPHER_LABEL = 'OL_CEP-AI-v1'

let encryptorInstance = null

function _getEncryptorData() {
  const cipherPassword =
    process.env.AI_TOKEN_CIPHER_PASSWORD || process.env.TOKEN_CIPHER_PASSWORD
  const cipherLabel = TOKEN_CIPHER_LABEL
  if (cipherPassword) {
    return {
      cipherLabel,
      cipherPasswords: { [cipherLabel]: cipherPassword },
    }
  }
  // fallback: auto-generated cipher file on the persistent volume
  const cipherFile = TOKEN_CIPHER_FILE
  try {
    return JSON.parse(fs.readFileSync(cipherFile, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error({ err, cipherFile }, 'Bad AI token cipherFile')
      throw err
    }
  }
  const encryptorData = {
    cipherLabel,
    cipherPasswords: {
      [cipherLabel]: crypto.randomBytes(32).toString('base64'),
    },
  }
  fs.mkdirSync(Path.dirname(cipherFile), { recursive: true })
  fs.writeFileSync(cipherFile, JSON.stringify(encryptorData, null, 2), {
    mode: 0o600,
  })
  return encryptorData
}

function _getEncryptor() {
  if (!encryptorInstance) {
    encryptorInstance = new AccessTokenEncryptorClass(_getEncryptorData())
  }
  return encryptorInstance
}

const COLLECTION = 'writingAssistantSettings'

// the core `db` object only exposes pre-declared collections; use the
// sanctioned dynamic accessor instead of patching mongodb.mjs
async function _collection() {
  return await getCollectionInternal(COLLECTION)
}

const _userId = userId => String(userId)

async function _getUserDoc(userId) {
  return await (await _collection()).findOne({ userId: _userId(userId) })
}

const AiTokenManager = {
  // Store (or replace) the user's e-INFRA API token. Returns only metadata.
  async saveToken(userId, token) {
    const encryptedToken = await _getEncryptor().promises.encryptJson({
      token,
    })
    await (await _collection()).updateOne(
      { userId: _userId(userId) },
      {
        $set: { userId, encryptedToken },
        $setOnInsert: { model: null },
      },
      { upsert: true }
    )
    logger.info({ userId }, 'writing-assistant: AI token saved')
  },

  async deleteToken(userId) {
    await (await _collection()).deleteOne({ userId: _userId(userId) })
    logger.info({ userId }, 'writing-assistant: AI token deleted')
  },

  // Internal use only (AiController/EInfraClient): decrypt the token.
  async getToken(userId) {
    const doc = await _getUserDoc(userId)
    if (!doc || !doc.encryptedToken) return null
    try {
      const json = await _getEncryptor().promises.decryptToJson(
        doc.encryptedToken
      )
      return json ? json.token : null
    } catch (err) {
      logger.warn(
        { err, userId },
        'writing-assistant: failed to decrypt AI token'
      )
      return null
    }
  },

  async getModel(userId) {
    const doc = await _getUserDoc(userId)
    return (doc && doc.model) || null
  },

  async setModel(userId, model) {
    await (await _collection()).updateOne(
      { userId: _userId(userId) },
      { $set: { userId: _userId(userId), model } },
      { upsert: true }
    )
  },

  // Status for the settings UI - never includes the token itself.
  async getStatus(userId) {
    const doc = await _getUserDoc(userId)
    return {
      connected: Boolean(doc && doc.encryptedToken),
      model: (doc && doc.model) || null,
    }
  },
}

export default AiTokenManager

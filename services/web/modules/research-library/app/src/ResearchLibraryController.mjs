import Settings from "@overleaf/settings";
import logger from "@overleaf/logger";
import OError from "@overleaf/o-error";
import crypto from "node:crypto";
import SessionManager from "../../../../app/src/Features/Authentication/SessionManager.mjs";
import ProjectGetter from "../../../../app/src/Features/Project/ProjectGetter.mjs";
import ProjectLocator from "../../../../app/src/Features/Project/ProjectLocator.mjs";
import EditorController from "../../../../app/src/Features/Editor/EditorController.mjs";
import DocumentUpdaterHandler from "../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs";
import { promisify } from "@overleaf/promise-utils";
import { getCollectionInternal } from "../../../../app/src/infrastructure/mongodb.mjs";
import {
  parseBibtexEntries,
  normalizeEntry,
  entryToBibtex,
} from "./BibtexParser.mjs";
import { lookupReference } from "./ReferenceLookup.mjs";

const COLLECTION = "researchLibraryReferences";

async function _collection() {
  return await getCollectionInternal(COLLECTION);
}

const _userId = (userId) => String(userId);

const LINK_COLLECTION = "researchLibraryLinks";

async function _linkCollection() {
  return await getCollectionInternal(LINK_COLLECTION);
}

const contentHash = (text) =>
  crypto.createHash("sha256").update(text).digest("hex");

// Library version: changes whenever any entry is added, edited or removed
async function _libraryVersion(userId) {
  const collection = await _collection();
  const entries = await collection
    .find({ userId: _userId(userId) }, { projection: { key: 1, updatedAt: 1 } })
    .sort({ key: 1 })
    .toArray();
  return contentHash(
    entries.map((e) => `${e.key}:${e.updatedAt?.getTime() || 0}`).join("|"),
  );
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function findDuplicate(userId, entry) {
  const collection = await _collection();
  const or = [];
  if (entry.doi) or.push({ userId: _userId(userId), doi: entry.doi });
  if (entry.arxivId)
    or.push({ userId: _userId(userId), arxivId: entry.arxivId });
  if (entry.title) {
    or.push({
      userId: _userId(userId),
      normalizedTitle: normalizeTitle(entry.title),
    });
  }
  if (or.length === 0) return null;
  return await collection.findOne({ $or: or });
}

async function listReferences(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const collection = await _collection();
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

  const filter = { userId: _userId(userId) };
  if (q) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { title: { $regex: escaped, $options: "i" } },
      { authors: { $regex: escaped, $options: "i" } },
      { key: { $regex: escaped, $options: "i" } },
      { venue: { $regex: escaped, $options: "i" } },
    ];
  }

  const entries = await collection
    .find(filter, { projection: { bibtex: 0 } })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();
  res.json({ references: entries });
}

async function addReferences(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const { bibtex } = req.body ?? {};
  if (typeof bibtex !== "string" || bibtex.trim().length === 0) {
    return res.status(400).json({ message: "bibtex is required" });
  }

  const collection = await _collection();
  const count = await collection.countDocuments({ userId: _userId(userId) });
  if (count > Settings.researchLibrary.maxEntriesPerUser) {
    return res.status(413).json({ message: "library is full" });
  }

  const { entries, errors } = parseBibtexEntries(bibtex);
  const added = [];
  const duplicates = [];
  for (const parsed of entries) {
    const entry = normalizeEntry(parsed);
    const duplicate = await findDuplicate(userId, entry);
    if (duplicate) {
      duplicates.push({ key: entry.key, existingKey: duplicate.key });
      continue;
    }
    // preserve the original BibTeX text for round-tripping
    entry.bibtex = parsed.raw || entryToBibtex(entry);
    const doc = {
      userId: _userId(userId),
      ...entry,
      normalizedTitle: normalizeTitle(entry.title),
      source: "bibtex",
      contentHash: contentHash(entry.title + (entry.year || "")),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { insertedId } = await collection.insertOne(doc);
    added.push({ _id: insertedId, key: entry.key, title: entry.title });
  }
  res.json({ added, duplicates, errors });
}

async function lookup(req, res) {
  const { query } = req.body ?? {};
  try {
    const entry = await lookupReference(query);
    res.json({ reference: entry });
  } catch (err) {
    const status = err.statusCode || 502;
    res.status(status).json({ message: err.message || "lookup failed" });
  }
}

async function addFromLookup(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const { reference } = req.body ?? {};
  if (!reference || !reference.title) {
    return res.status(400).json({ message: "reference is required" });
  }
  const collection = await _collection();
  const duplicate = await findDuplicate(userId, reference);
  if (duplicate) {
    return res.json({ added: false, duplicateOf: duplicate.key });
  }
  const entry = {
    ...reference,
    bibtex: reference.bibtex || entryToBibtex(reference),
  };
  const doc = {
    userId: _userId(userId),
    ...entry,
    normalizedTitle: normalizeTitle(entry.title),
    source: reference.source || "lookup",
    contentHash: contentHash(entry.title + (entry.year || "")),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const { insertedId } = await collection.insertOne(doc);
  res.json({ added: true, reference: { _id: insertedId, key: entry.key } });
}

async function deleteReference(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const { referenceId } = req.params;
  const collection = await _collection();
  const { ObjectId } = await import("mongodb");
  let objectId;
  try {
    objectId = new ObjectId(referenceId);
  } catch {
    return res.status(400).json({ message: "invalid id" });
  }
  const result = await collection.deleteOne({
    _id: objectId,
    userId: _userId(userId),
  });
  res.json({ deleted: result.deletedCount });
}

async function exportLibrary(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const collection = await _collection();
  const entries = await collection
    .find({ userId: _userId(userId) })
    .sort({ key: 1 })
    .toArray();
  const bibtex = entries
    .map((entry) => entry.bibtex || entryToBibtex(entry))
    .join("\n\n");
  res.setHeader("content-type", "application/x-bibtex");
  res.attachment("library.bib");
  res.send(bibtex);
}

const LIBRARY_DOC_NAME = "library.bib";
const addDoc = promisify(EditorController.addDoc);

// Materialize the user's library into the project as library.bib:
// create the doc if missing, update it in place otherwise. This is the
// pragmatic v1 of "link the library to a project" - the linked-file
// agent integration comes later.
async function materialize(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const { project_id: projectId } = req.params;
  const { docName } = req.body ?? {};
  const name =
    typeof docName === "string" && docName.endsWith(".bib")
      ? docName
      : LIBRARY_DOC_NAME;

  const collection = await _collection();
  const entries = await collection
    .find({ userId: _userId(userId) })
    .sort({ key: 1 })
    .toArray();
  const bibtex = entries
    .map((entry) => entry.bibtex || entryToBibtex(entry))
    .join("\n\n");

  try {
    // find an existing library doc at the project root
    const project = await ProjectGetter.promises.getProject(projectId, {
      rootFolder: true,
      name: true,
    });
    if (!project) {
      return res.status(404).json({ message: "project not found" });
    }
    const rootFolder = project.rootFolder[0];
    const existing = (rootFolder.docs || []).find((doc) => doc.name === name);

    const lines = bibtex.length ? bibtex.split("\n") : [""];
    // document-updater expects no trailing newline element
    if (lines[lines.length - 1] === "") lines.pop();

    if (existing) {
      await DocumentUpdaterHandler.promises.setDocument(
        projectId,
        existing._id,
        userId,
        lines,
        "research-library",
      );
    } else {
      await addDoc(
        projectId,
        rootFolder._id,
        name,
        lines,
        "research-library",
        userId,
      );
    }
    // record the link so the project can report update availability
    const links = await _linkCollection();
    const docId = existing ? existing._id : null;
    const version = await _libraryVersion(userId);
    await links.updateOne(
      { projectId, userId: _userId(userId), docName: name },
      {
        $set: {
          projectId,
          userId: _userId(userId),
          docName: name,
          version,
          count: entries.length,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    res.json({
      updated: Boolean(existing),
      docName: name,
      count: entries.length,
    });
  } catch (err) {
    logger.warn(
      { err: OError.getFullStack(err), userId, projectId },
      "research-library: materialize failed",
    );
    res.status(500).json({ message: "failed to materialize library" });
  }
}

// GET /project/:project_id/research-library/status
// Reports whether the project has a materialized library and whether the
// library has changed since (update available) - never silently changes
// the manuscript.
async function projectStatus(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const { project_id: projectId } = req.params;

  const links = await _linkCollection();
  const link = await links.findOne({
    projectId,
    userId: _userId(userId),
    asset: { $ne: true },
  });
  if (!link) {
    return res.json({ linked: false, upToDate: false });
  }
  // verify the doc still exists in the project
  const project = await ProjectGetter.promises.getProject(projectId, {
    rootFolder: true,
  });
  const rootFolder = project && project.rootFolder && project.rootFolder[0];
  const docExists = Boolean(
    rootFolder &&
    (rootFolder.docs || []).some((doc) => doc.name === link.docName),
  );
  if (!docExists) {
    return res.json({ linked: false, upToDate: false });
  }
  const currentVersion = await _libraryVersion(userId);
  res.json({
    linked: true,
    upToDate: link.version === currentVersion,
    count: link.count,
    docName: link.docName,
    materializedAt: link.updatedAt,
  });
}

async function status(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const collection = await _collection();
  const count = await collection.countDocuments({ userId: _userId(userId) });
  res.json({ enabled: true, references: count });
}

export default {
  projectStatus,
  listReferences,
  addReferences,
  lookup,
  addFromLookup,
  deleteReference,
  exportLibrary,
  materialize,
  status,
};

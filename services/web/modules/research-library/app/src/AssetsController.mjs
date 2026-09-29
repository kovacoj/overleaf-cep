import logger from "@overleaf/logger";
import OError from "@overleaf/o-error";
import crypto from "node:crypto";
import SessionManager from "../../../../app/src/Features/Authentication/SessionManager.mjs";
import ProjectGetter from "../../../../app/src/Features/Project/ProjectGetter.mjs";
import EditorController from "../../../../app/src/Features/Editor/EditorController.mjs";
import DocumentUpdaterHandler from "../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs";
import { promisify } from "@overleaf/promise-utils";
import { getCollectionInternal } from "../../../../app/src/infrastructure/mongodb.mjs";

// Shared LaTeX assets (macros.tex, notation.tex, theorem-envs.tex, ...):
// defined once in the research library, materialized into any project on
// demand (create on first use, update in place afterwards, never silent -
// the panel reports update availability via the link records).

const COLLECTION = "researchLibraryAssets";
const LINK_COLLECTION = "researchLibraryLinks";

const ASSET_NAME_RE = /^[a-zA-Z0-9._-]+\.(tex|sty|cls)$/;

const _userId = (userId) => String(userId);

async function _collection() {
  return await getCollectionInternal(COLLECTION);
}

async function _linkCollection() {
  return await getCollectionInternal(LINK_COLLECTION);
}

// version = content hash; changes when the asset content changes
const _version = (content) =>
  crypto.createHash("sha256").update(content).digest("hex");

// Extract notation definitions (\newcommand, \DeclareMathOperator,
// \newtheorem) from LaTeX source for the registry view.
export function extractNotation(latex) {
  const items = [];
  const push = (macro, definition, kind) => {
    if (macro && !items.some((i) => i.macro === macro)) {
      items.push({ macro, definition, kind });
    }
  };
  const source = String(latex || "");

  for (const match of source.matchAll(
    /\\(?:re)?newcommand\*?\s*\{\s*(\\[a-zA-Z]+)\s*\}\s*(?:\[(\d+)\])?\s*\{/g,
  )) {
    const macro = match[1];
    const rest = source.slice(match.index + match[0].length);
    let depth = 1;
    let end = 0;
    while (end < rest.length && depth > 0) {
      if (rest[end] === "\\") end++;
      else if (rest[end] === "{") depth++;
      else if (rest[end] === "}") depth--;
      end++;
    }
    push(macro, rest.slice(0, Math.max(0, end - 1)).trim(), "command");
  }

  for (const match of source.matchAll(
    /\\DeclareMathOperator\*?\s*\{\s*(\\[a-zA-Z]+)\s*\}\s*\{([^}]*)\}/g,
  )) {
    push(match[1], match[2].trim(), "operator");
  }

  for (const match of source.matchAll(
    /\\newtheorem\*?\s*\{([^}]+)\}\s*\{([^}]*)\}/g,
  )) {
    push(`\\begin{${match[1]}}`, match[2].trim(), "environment");
  }

  return items;
}

async function listAssets(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const collection = await _collection();
  const assets = await collection
    .find({ userId: _userId(userId) })
    .sort({ name: 1 })
    .toArray();
  res.json({
    assets: assets.map((asset) => ({
      _id: asset._id,
      name: asset.name,
      version: asset.version,
      notation: extractNotation(asset.content),
      updatedAt: asset.updatedAt,
    })),
  });
}

async function listProjectAssets(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const { project_id: projectId } = req.params;
  const collection = await _collection();
  const links = await _linkCollection();
  const [assets, assetLinks] = await Promise.all([
    collection
      .find({ userId: _userId(userId) })
      .sort({ name: 1 })
      .toArray(),
    links.find({ projectId, userId: _userId(userId), asset: true }).toArray(),
  ]);
  const linksByName = new Map(assetLinks.map((link) => [link.docName, link]));
  res.json({
    assets: assets.map((asset) => {
      const link = linksByName.get(asset.name);
      return {
        _id: asset._id,
        name: asset.name,
        version: asset.version,
        notation: extractNotation(asset.content),
        updatedAt: asset.updatedAt,
        linked: Boolean(link),
        upToDate: link?.version === asset.version,
      };
    }),
  });
}

async function getAssetContent(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const { assetId } = req.params;
  const collection = await _collection();
  const { ObjectId } = await import("mongodb");
  let objectId;
  try {
    objectId = new ObjectId(assetId);
  } catch {
    return res.status(400).json({ message: "invalid id" });
  }
  const asset = await collection.findOne({
    _id: objectId,
    userId: _userId(userId),
  });
  if (!asset) {
    return res.status(404).json({ message: "asset not found" });
  }
  res.json({ name: asset.name, content: asset.content });
}

async function saveAsset(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const { name, content } = req.body ?? {};
  if (typeof name !== "string" || !ASSET_NAME_RE.test(name)) {
    return res.status(400).json({
      message: "name must be a .tex/.sty/.cls file name",
    });
  }
  if (typeof content !== "string" || content.length > 500000) {
    return res.status(400).json({ message: "invalid content" });
  }
  const collection = await _collection();
  const existing = await collection.findOne({
    userId: _userId(userId),
    name,
  });
  if (existing) {
    await collection.updateOne(
      { _id: existing._id },
      { $set: { content, version: _version(content), updatedAt: new Date() } },
    );
    return res.json({ _id: existing._id, name, updated: true });
  }
  const { insertedId } = await collection.insertOne({
    userId: _userId(userId),
    name,
    content,
    version: _version(content),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  res.json({ _id: insertedId, name, updated: false });
}

async function deleteAsset(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const { assetId } = req.params;
  const collection = await _collection();
  const { ObjectId } = await import("mongodb");
  let objectId;
  try {
    objectId = new ObjectId(assetId);
  } catch {
    return res.status(400).json({ message: "invalid id" });
  }
  const result = await collection.deleteOne({
    _id: objectId,
    userId: _userId(userId),
  });
  res.json({ deleted: result.deletedCount });
}

const addDoc = promisify(EditorController.addDoc);

// POST /project/:project_id/research-library/assets/:assetId/materialize
async function materializeAsset(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  const { project_id: projectId, assetId } = req.params;
  const collection = await _collection();
  const { ObjectId } = await import("mongodb");
  let objectId;
  try {
    objectId = new ObjectId(assetId);
  } catch {
    return res.status(400).json({ message: "invalid id" });
  }
  const asset = await collection.findOne({
    _id: objectId,
    userId: _userId(userId),
  });
  if (!asset) {
    return res.status(404).json({ message: "asset not found" });
  }

  try {
    const project = await ProjectGetter.promises.getProject(projectId, {
      rootFolder: true,
    });
    if (!project) {
      return res.status(404).json({ message: "project not found" });
    }
    const rootFolder = project.rootFolder[0];
    const existing = (rootFolder.docs || []).find(
      (doc) => doc.name === asset.name,
    );
    const lines = asset.content.split("\n");
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
        asset.name,
        lines,
        "research-library",
        userId,
      );
    }

    // stamp the link for update awareness
    const links = await _linkCollection();
    await links.updateOne(
      { projectId, userId: _userId(userId), docName: asset.name },
      {
        $set: {
          projectId,
          userId: _userId(userId),
          docName: asset.name,
          version: asset.version,
          asset: true,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
    res.json({ updated: Boolean(existing), docName: asset.name });
  } catch (err) {
    logger.warn(
      { err: OError.getFullStack(err), userId, projectId },
      "research-library: asset materialize failed",
    );
    res.status(500).json({ message: "failed to materialize asset" });
  }
}

export default {
  listAssets,
  listProjectAssets,
  getAssetContent,
  saveAsset,
  deleteAsset,
  materializeAsset,
};

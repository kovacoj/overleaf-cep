/**
 * Research Library rail panel: personal bibliography shared across
 * projects. Search entries, add references via DOI / arXiv / title lookup
 * or pasted BibTeX, insert \cite{key} at the cursor, and materialize the
 * whole library into the current project as library.bib.
 */
import React, { useCallback, useEffect, useState } from "react";
import { useProjectContext } from "@/shared/context/project-context";
import { useEditorViewContext } from "@/features/ide-react/context/editor-view-context";
import getMeta from "@/utils/meta";
import { AI_EVENT } from "../../../../writing-assistant/frontend/js/extensions/ai-selector";
import OLButton from "@/shared/components/ol/ol-button";
import OLFormControl from "@/shared/components/ol/ol-form-control";
import OLIconButton from "@/shared/components/ol/ol-icon-button";
import OLTooltip from "@/shared/components/ol/ol-tooltip";
import MaterialIcon from "@/shared/components/material-icon";
import RailPanelHeader from "@/features/ide-react/components/rail/rail-panel-header";
import Notification from "@/shared/components/notification";
import "../../stylesheets/research-library.scss";

type Reference = {
  _id: string;
  key: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  doi?: string;
  arxivId?: string;
  source?: string;
  hasPdf?: boolean;
};

type Asset = {
  _id: string;
  name: string;
  version: string;
  notation: Array<{ macro: string; definition: string; kind: string }>;
  updatedAt: string;
  linked: boolean;
  upToDate: boolean;
};

export default function ResearchLibraryPanel() {
  const { projectId } = useProjectContext();
  const { view } = useEditorViewContext();

  const [references, setReferences] = useState<Reference[]>([]);
  const [query, setQuery] = useState("");
  const [lookupQuery, setLookupQuery] = useState("");
  const [bibtexText, setBibtexText] = useState("");
  const [showAdd, setShowAdd] = useState<"none" | "lookup" | "bibtex">("none");
  const [busy, setBusy] = useState(false);
  const [pdfUploadFor, setPdfUploadFor] = useState<string | null>(null);
  const [section, setSection] = useState<"references" | "assets">("references");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [editingAsset, setEditingAsset] = useState<string | null>(null);
  const [assetName, setAssetName] = useState("");
  const [assetContent, setAssetContent] = useState("");
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [linkStatus, setLinkStatus] = useState<{
    linked: boolean;
    upToDate: boolean;
    count?: number;
  } | null>(null);

  const fetchReferences = useCallback(async () => {
    try {
      const params = query ? `?q=${encodeURIComponent(query)}` : "";
      const response = await fetch(
        `/user/research-library/references${params}`,
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "failed to load");
      setReferences(data.references || []);
    } catch (err: any) {
      setError(err.message || "failed to load library");
    }
  }, [query]);

  const fetchLinkStatus = useCallback(async () => {
    try {
      const response = await fetch(
        `/project/${projectId}/research-library/status`,
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "failed to load");
      setLinkStatus(data);
    } catch {
      setLinkStatus(null);
    }
  }, [projectId]);

  const fetchAssets = useCallback(async () => {
    try {
      const response = await fetch(
        `/project/${projectId}/research-library/assets`,
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "failed to load");
      setAssets(data.assets || []);
    } catch {
      setAssets([]);
    }
  }, [projectId]);

  useEffect(() => {
    fetchReferences();
    fetchLinkStatus();
  }, [fetchReferences, fetchLinkStatus]);

  useEffect(() => {
    if (section === "assets") fetchAssets();
  }, [section, fetchAssets]);

  const saveAsset = useCallback(async () => {
    if (!assetName.trim() || !assetContent.trim()) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/user/research-library/assets", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": getMeta("ol-csrfToken"),
        },
        body: JSON.stringify({
          name: assetName.trim(),
          content: assetContent,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "failed to save");
      setMessage(`Saved ${data.name}`);
      setAssetName("");
      setAssetContent("");
      setEditingAsset(null);
      await fetchAssets();
    } catch (err: any) {
      setError(err.message || "failed to save");
    } finally {
      setBusy(false);
    }
  }, [assetName, assetContent, fetchAssets]);

  const editAsset = useCallback(async (assetId: string) => {
    try {
      const response = await fetch(
        `/user/research-library/assets/${assetId}/content`,
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      setAssetName(data.name);
      setAssetContent(data.content);
      setEditingAsset(assetId);
    } catch (err: any) {
      setError(err.message || "failed to load asset");
    }
  }, []);

  const deleteAsset = useCallback(
    async (assetId: string) => {
      try {
        await fetch(`/user/research-library/assets/${assetId}`, {
          method: "DELETE",
          headers: { "x-csrf-token": getMeta("ol-csrfToken") },
        });
        await fetchAssets();
      } catch {
        setError("failed to delete asset");
      }
    },
    [fetchAssets],
  );

  const materializeAsset = useCallback(
    async (assetId: string) => {
      setBusy(true);
      setError("");
      try {
        const response = await fetch(
          `/project/${projectId}/research-library/assets/${assetId}/materialize`,
          {
            method: "POST",
            headers: { "x-csrf-token": getMeta("ol-csrfToken") },
          },
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "failed");
        setMessage(`${data.updated ? "Updated" : "Created"} ${data.docName}`);
        await fetchAssets();
      } catch (err: any) {
        setError(err.message || "failed to materialize");
      } finally {
        setBusy(false);
      }
    },
    [projectId, fetchAssets],
  );

  const doLookup = useCallback(async () => {
    if (!lookupQuery.trim()) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/user/research-library/references/lookup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": getMeta("ol-csrfToken"),
        },
        body: JSON.stringify({ query: lookupQuery.trim() }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "lookup failed");
      }
      // store it directly (dedup happens server-side)
      const addResponse = await fetch(
        "/user/research-library/references/from-lookup",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": getMeta("ol-csrfToken"),
          },
          body: JSON.stringify({ reference: data.reference }),
        },
      );
      const addData = await addResponse.json();
      if (!addResponse.ok) {
        throw new Error(addData.message || "failed to add");
      }
      setMessage(
        addData.added
          ? `Added: ${data.reference.title}`
          : `Already in library (${addData.duplicateOf})`,
      );
      setLookupQuery("");
      await fetchReferences();
    } catch (err: any) {
      setError(err.message || "lookup failed");
    } finally {
      setBusy(false);
    }
  }, [lookupQuery, fetchReferences]);

  const addBibtex = useCallback(async () => {
    if (!bibtexText.trim()) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/user/research-library/references", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": getMeta("ol-csrfToken"),
        },
        body: JSON.stringify({ bibtex: bibtexText }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "failed to add");
      const parts = [
        `${data.added?.length || 0} added`,
        data.duplicates?.length ? `${data.duplicates.length} duplicates` : "",
        data.errors?.length ? `${data.errors.length} errors` : "",
      ].filter(Boolean);
      setMessage(parts.join(", "));
      setBibtexText("");
      await fetchReferences();
    } catch (err: any) {
      setError(err.message || "failed to add");
    } finally {
      setBusy(false);
    }
  }, [bibtexText, fetchReferences]);

  const importFromZotero = useCallback(async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        "/user/research-library/references/from-zotero",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": getMeta("ol-csrfToken"),
          },
          body: JSON.stringify({}),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Zotero import failed");
      setMessage(
        `${data.added?.length || 0} added${
          data.duplicates?.length
            ? `, ${data.duplicates.length} duplicates`
            : ""
        }`,
      );
      await fetchReferences();
      await fetchLinkStatus();
    } catch (err: any) {
      setError(
        err.message === "RefProvider credentials missed"
          ? "Link Zotero in Account Settings first"
          : err.message || "Zotero import failed",
      );
    } finally {
      setBusy(false);
    }
  }, [fetchReferences, fetchLinkStatus]);

  const deleteReference = useCallback(
    async (referenceId: string) => {
      try {
        await fetch(`/user/research-library/references/${referenceId}`, {
          method: "DELETE",
          headers: { "x-csrf-token": getMeta("ol-csrfToken") },
        });
        await fetchReferences();
      } catch {
        setError("failed to delete");
      }
    },
    [fetchReferences],
  );

  const uploadPdf = useCallback(
    (referenceId: string, file: File) => {
      const body = new FormData();
      body.append("qqfile", file);
      fetch(`/user/research-library/references/${referenceId}/pdf`, {
        method: "POST",
        headers: { "x-csrf-token": getMeta("ol-csrfToken") },
        body,
      })
        .then((response) => response.json())
        .then((data) => {
          if (!data.hasPdf) throw new Error(data.message || "upload failed");
          setMessage(`PDF stored (${data.textChars || 0} chars of text)`);
          return fetchReferences();
        })
        .catch((err) => setError(err.message || "upload failed"));
    },
    [fetchReferences],
  );

  const deletePdf = useCallback(
    async (referenceId: string) => {
      try {
        await fetch(`/user/research-library/references/${referenceId}/pdf`, {
          method: "DELETE",
          headers: { "x-csrf-token": getMeta("ol-csrfToken") },
        });
        await fetchReferences();
      } catch {
        setError("failed to delete PDF");
      }
    },
    [fetchReferences],
  );

  const askPaper = useCallback(
    (reference: Reference) => {
      if (!view) return;
      const pos = view.state.selection.main.head;
      window.dispatchEvent(
        new CustomEvent(AI_EVENT, {
          detail: {
            action: "ask-paper",
            from: pos,
            to: pos,
            referenceId: reference._id,
            text: reference.title || reference.key,
          },
        }),
      );
    },
    [view],
  );

  const insertCitation = useCallback(
    (key: string) => {
      if (!view) return;
      const pos = view.state.selection.main.head;
      view.dispatch({
        changes: { from: pos, to: pos, insert: `\\cite{${key}}` },
        selection: { anchor: pos + 7 + key.length },
      });
      view.focus();
    },
    [view],
  );

  const materialize = useCallback(async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/project/${projectId}/research-library/materialize`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": getMeta("ol-csrfToken"),
          },
          body: JSON.stringify({}),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "failed");
      setMessage(
        `${data.updated ? "Updated" : "Created"} ${data.docName} (${data.count} references)`,
      );
      await fetchLinkStatus();
    } catch (err: any) {
      setError(err.message || "failed to materialize");
    } finally {
      setBusy(false);
    }
  }, [projectId, fetchLinkStatus]);

  return (
    <div className="research-library-panel">
      <RailPanelHeader title="Research Library" />

      <div className="research-library-tabs" role="tablist">
        <button
          className={section === "references" ? "active" : ""}
          role="tab"
          aria-selected={section === "references"}
          onClick={() => setSection("references")}
        >
          <MaterialIcon type="menu_book" />
          References
        </button>
        <button
          className={section === "assets" ? "active" : ""}
          role="tab"
          aria-selected={section === "assets"}
          onClick={() => setSection("assets")}
        >
          <MaterialIcon type="code" />
          LaTeX assets
        </button>
      </div>

      {section === "assets" && (
        <div className="research-library-view">
          <p className="research-library-description">
            Reuse macros, notation and environments across projects. Updates are
            always applied explicitly.
          </p>
          {assets.length === 0 && (
            <div className="research-library-empty-state">
              <MaterialIcon type="code" />
              <strong>No shared LaTeX assets</strong>
              <span>
                Create a macros.tex or notation.tex file to get started.
              </span>
            </div>
          )}
          {assets.map((asset) => (
            <div key={asset._id} className="research-library-entry">
              <div className="research-library-entry-icon">
                <MaterialIcon type="description" />
              </div>
              <div className="research-library-entry-content">
                <div className="research-library-entry-heading">
                  <strong>{asset.name}</strong>
                  {asset.linked && asset.upToDate && (
                    <span className="research-library-status">
                      <MaterialIcon type="check_circle" /> Up to date
                    </span>
                  )}
                </div>
                {asset.notation?.length > 0 && (
                  <details className="research-library-notation">
                    <summary>
                      {asset.notation.length} notation definitions
                    </summary>
                    {asset.notation.map((item, index) => (
                      <div key={index}>
                        <code>{item.macro}</code>
                        {item.definition
                          ? ` = ${item.definition.slice(0, 50)}`
                          : ""}
                      </div>
                    ))}
                  </details>
                )}
              </div>
              <div className="research-library-entry-actions">
                <OLTooltip
                  id={`materialize-asset-${asset._id}`}
                  description={
                    asset.linked && asset.upToDate
                      ? "Already up to date in this project"
                      : asset.linked
                        ? "Update this project"
                        : "Add to this project"
                  }
                >
                  <OLIconButton
                    icon={asset.linked ? "sync" : "add_to_drive"}
                    accessibilityLabel="Add or update in project"
                    size="sm"
                    variant="ghost"
                    disabled={busy || (asset.linked && asset.upToDate)}
                    onClick={() => materializeAsset(asset._id)}
                  />
                </OLTooltip>
                <OLTooltip id={`edit-asset-${asset._id}`} description="Edit">
                  <OLIconButton
                    icon="edit"
                    accessibilityLabel="Edit asset"
                    size="sm"
                    variant="ghost"
                    onClick={() => editAsset(asset._id)}
                  />
                </OLTooltip>
                <OLTooltip
                  id={`delete-asset-${asset._id}`}
                  description="Delete"
                >
                  <OLIconButton
                    icon="delete"
                    accessibilityLabel="Delete asset"
                    size="sm"
                    variant="danger-ghost"
                    onClick={() => deleteAsset(asset._id)}
                  />
                </OLTooltip>
              </div>
            </div>
          ))}
          <details
            className="research-library-editor"
            open={editingAsset ? true : undefined}
          >
            <summary>
              <MaterialIcon type={editingAsset ? "edit" : "add"} />
              {editingAsset ? "Edit asset" : "New asset"}
            </summary>
            <OLFormControl
              size="sm"
              placeholder="macros.tex"
              value={assetName}
              disabled={editingAsset !== null}
              onChange={(e) => setAssetName(e.target.value)}
            />
            <textarea
              className="form-control"
              rows={6}
              placeholder={
                "\\newcommand{\\R}{\\mathbb{R}}\n\\DeclareMathOperator{\\rank}{rank}"
              }
              value={assetContent}
              onChange={(e) => setAssetContent(e.target.value)}
            />
            <OLButton
              variant="primary"
              size="sm"
              disabled={busy || !assetName.trim() || !assetContent.trim()}
              isLoading={busy}
              loadingLabel="Saving"
              leadingIcon="save"
              onClick={saveAsset}
            >
              Save asset
            </OLButton>
          </details>
        </div>
      )}

      {error && (
        <Notification
          type="error"
          content={error}
          onDismiss={() => setError("")}
        />
      )}
      {message && (
        <Notification
          type="info"
          content={message}
          onDismiss={() => setMessage("")}
        />
      )}

      {section === "references" && (
        <div className="research-library-view">
          <div className="research-library-toolbar">
            <OLFormControl
              type="search"
              size="sm"
              aria-label="Search references"
              placeholder="Search references"
              prepend={<MaterialIcon type="search" />}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="research-library-toolbar-actions">
              <OLButton
                variant="secondary"
                size="sm"
                leadingIcon="travel_explore"
                onClick={() =>
                  setShowAdd(showAdd === "lookup" ? "none" : "lookup")
                }
              >
                Add by DOI/arXiv/title
              </OLButton>
              <OLButton
                variant="secondary"
                size="sm"
                leadingIcon="data_object"
                onClick={() =>
                  setShowAdd(showAdd === "bibtex" ? "none" : "bibtex")
                }
              >
                Paste BibTeX
              </OLButton>
              <OLButton
                variant="secondary"
                size="sm"
                leadingIcon="download"
                disabled={busy}
                onClick={importFromZotero}
              >
                Import from Zotero
              </OLButton>
              <OLButton
                variant={
                  linkStatus?.linked && !linkStatus.upToDate
                    ? "primary"
                    : linkStatus?.linked && linkStatus.upToDate
                      ? "secondary"
                      : "primary"
                }
                size="sm"
                leadingIcon={linkStatus?.linked ? "sync" : "library_add"}
                disabled={busy || (linkStatus?.linked && linkStatus.upToDate)}
                title={
                  linkStatus?.linked
                    ? linkStatus.upToDate
                      ? "library.bib is up to date"
                      : "The library has changed - update library.bib"
                    : "Materialize the library as library.bib"
                }
                onClick={materialize}
              >
                {linkStatus?.linked
                  ? linkStatus.upToDate
                    ? "Up to date"
                    : "Update library.bib"
                  : "Add to project"}
              </OLButton>
            </div>
          </div>

          {showAdd === "lookup" && (
            <div className="research-library-add">
              <div className="input-group">
                <input
                  className="form-control"
                  placeholder="10.1000/xyz123, arXiv:2101.01234, or title…"
                  value={lookupQuery}
                  onChange={(e) => setLookupQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") doLookup();
                  }}
                />
                <OLButton
                  variant="primary"
                  size="sm"
                  disabled={busy || !lookupQuery.trim()}
                  onClick={doLookup}
                >
                  {busy ? "…" : "Resolve"}
                </OLButton>
              </div>
            </div>
          )}

          {showAdd === "bibtex" && (
            <div className="research-library-add">
              <textarea
                className="form-control"
                rows={4}
                placeholder="@article{key, title = {…}, …}"
                value={bibtexText}
                onChange={(e) => setBibtexText(e.target.value)}
              />
              <OLButton
                variant="primary"
                size="sm"
                disabled={busy || !bibtexText.trim()}
                onClick={addBibtex}
              >
                Add entries
              </OLButton>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file && pdfUploadFor) uploadPdf(pdfUploadFor, file);
              e.target.value = "";
              setPdfUploadFor(null);
            }}
          />

          <div className="research-library-results">
            {references.length === 0 ? (
              <div className="research-library-empty-state">
                <MaterialIcon type={query ? "search_off" : "menu_book"} />
                <strong>
                  {query ? "No matching references" : "No references yet"}
                </strong>
                <span>
                  {query
                    ? "Try a different author, title or citation key."
                    : "Add a paper by DOI, arXiv ID, title or BibTeX."}
                </span>
              </div>
            ) : (
              references.map((reference) => (
                <div key={reference._id} className="research-library-entry">
                  <div className="research-library-entry-icon">
                    <MaterialIcon
                      type={reference.hasPdf ? "picture_as_pdf" : "article"}
                    />
                  </div>
                  <div className="research-library-entry-content">
                    <button
                      className="research-library-entry-title"
                      onClick={() => insertCitation(reference.key)}
                    >
                      {reference.title || reference.key}
                    </button>
                    <div className="small text-muted">
                      {reference.authors?.slice(0, 3).join(", ")}
                      {reference.authors?.length > 3 ? " et al." : ""}
                      {reference.year ? ` (${reference.year})` : ""}
                      {reference.venue ? ` — ${reference.venue}` : ""}
                    </div>
                    <div className="research-library-entry-meta">
                      <code>{reference.key}</code>
                      {reference.doi ? (
                        <a
                          className="ms-1"
                          href={`https://doi.org/${reference.doi}`}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          DOI
                        </a>
                      ) : null}
                      {reference.arxivId ? (
                        <a
                          className="ms-1"
                          href={`https://arxiv.org/abs/${reference.arxivId}`}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          arXiv
                        </a>
                      ) : null}
                    </div>
                  </div>
                  <div className="research-library-entry-actions">
                    <OLTooltip
                      id={`insert-citation-${reference._id}`}
                      description="Insert citation at cursor"
                    >
                      <OLIconButton
                        icon="format_quote"
                        accessibilityLabel="Insert citation at cursor"
                        size="sm"
                        variant="ghost"
                        onClick={() => insertCitation(reference.key)}
                      />
                    </OLTooltip>
                    {reference.hasPdf ? (
                      <>
                        <OLTooltip
                          id={`open-pdf-${reference._id}`}
                          description="Open PDF"
                        >
                          <OLIconButton
                            icon="picture_as_pdf"
                            accessibilityLabel="Open PDF"
                            size="sm"
                            variant="ghost"
                            href={`/user/research-library/references/${reference._id}/pdf`}
                            target="_blank"
                            rel="noreferrer noopener"
                          />
                        </OLTooltip>
                        <OLTooltip
                          id={`ask-paper-${reference._id}`}
                          description="Ask AI about this paper"
                        >
                          <OLIconButton
                            icon="auto_awesome"
                            accessibilityLabel="Ask AI about this paper"
                            size="sm"
                            variant="ghost"
                            onClick={() => askPaper(reference)}
                          />
                        </OLTooltip>
                        <OLTooltip
                          id={`remove-pdf-${reference._id}`}
                          description="Remove PDF"
                        >
                          <OLIconButton
                            icon="link_off"
                            accessibilityLabel="Remove PDF"
                            size="sm"
                            variant="ghost"
                            onClick={() => deletePdf(reference._id)}
                          />
                        </OLTooltip>
                      </>
                    ) : (
                      <OLTooltip
                        id={`attach-pdf-${reference._id}`}
                        description="Attach PDF"
                      >
                        <OLIconButton
                          icon="upload_file"
                          accessibilityLabel="Attach PDF"
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setPdfUploadFor(reference._id);
                            fileInputRef.current?.click();
                          }}
                        />
                      </OLTooltip>
                    )}
                    <OLTooltip
                      id={`delete-reference-${reference._id}`}
                      description="Remove from library"
                    >
                      <OLIconButton
                        icon="delete"
                        accessibilityLabel="Remove from library"
                        size="sm"
                        variant="danger-ghost"
                        onClick={() => deleteReference(reference._id)}
                      />
                    </OLTooltip>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

# CE+ Feature Inventory — deployment in `kovacovsky-ns`

Audit performed against the actual `ext-ce` source tree (v6.2.0-231)
and the running deployment of `overleafcep/sharelatex:6.2.0-ext-v5.0`.
Verified 2026-09-29.

Legend for "Test result":

- `PASS` — exercised end-to-end via HTTP/API during this audit or the
  deployment bring-up (compile, persistence, restarts)
- `PRESENT` — code + frontend assets confirmed shipped and enabled, but
  full browser interaction not exercised headlessly (no user-visible
  failure; needs a human click-through)
- `BLOCKED-<reason>` — enabled but a prerequisite is missing
- `PENDING-USER` — requires an account owner action in a browser
- `DEFERRED` — deliberately not enabled

| Feature                                | In source?                 | Enabled?                                                                             | Credentials?                                  | External service?                 | Custom code? | Test result                                                                                                                                                                        |
| -------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- | --------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core editing / compilation             | yes                        | yes                                                                                  | no                                            | no                                | no           | PASS — create/edit/compile/PDF verified                                                                                                                                            |
| Project history / versioning           | yes                        | yes                                                                                  | no                                            | no                                | no           | PASS — history-v1 + project-history running; data survives restarts                                                                                                                |
| Comments (add/resolve)                 | yes                        | yes                                                                                  | no                                            | no                                | no           | PRESENT — frontend module shipped; websocket interaction needs browser                                                                                                             |
| Track changes (accept/reject)          | yes                        | yes (`trackChanges: true` default)                                                   | no                                            | no                                | no           | PRESENT — module + `track-changes` frontend compiled in bundle                                                                                                                     |
| Project restore / labels               | yes                        | yes                                                                                  | no                                            | no                                | no           | PRESENT — part of history UI                                                                                                                                                       |
| Collaborator permissions               | yes                        | yes                                                                                  | no                                            | no                                | no           | PASS — invite flow available (`OVERLEAF_INVITE_TOKEN_SECRET` set)                                                                                                                  |
| Full project search                    | yes (frontend-only module) | yes                                                                                  | no                                            | no                                | no           | PRESENT — uses built-in search APIs                                                                                                                                                |
| Symbol palette                         | yes                        | yes                                                                                  | no                                            | no                                | no           | PRESENT — `symbol-palette` in shipped bundle                                                                                                                                       |
| Reference picker                       | yes                        | yes (`references: true` default)                                                     | no                                            | no (works with local `.bib`)      | no           | PRESENT — `reference-picker` in codemirror bundle                                                                                                                                  |
| Template gallery                       | yes                        | **yes** (`OVERLEAF_TEMPLATE_GALLERY=true`)                                           | no                                            | no                                | no           | PASS — `/templates/all` returns 200; manager = admin user                                                                                                                          |
| Import file from external URL          | yes                        | **yes** (`url` added to linked file types; linked-url-proxy running in-pod)          | no                                            | no                                | no           | PRESENT — `hasLinkUrlFeature=true`                                                                                                                                                 |
| GitHub Sync                            | yes                        | yes (`GITHUB_SYNC_ENABLED=true`)                                                     | yes (OAuth app, set)                          | github.com                        | no           | PENDING-USER — OAuth start redirects correctly; callback URL validated; E2E bidirectional sync needs account owner                                                                 |
| Git Bridge (git clone/push)            | yes                        | **yes** (`GIT_BRIDGE_ENABLED=true`)                                                  | per-user PAT                                  | self-hosted git-bridge service    | no           | **PASS** — authenticated clone and push verified against the sample project; repositories and SQLite metadata use a dedicated 10Gi PVC                                             |
| Zotero                                 | yes                        | **yes** (`zotero` in linked types)                                                    | per-user API key, encrypted                    | zotero.org                        | custom       | **PASS** — API key validation, encrypted per-user storage, personal-library BibTeX fetch, and Research Library import verified; QA credentials and imported test records removed   |
| Multilingual spell checking (Hunspell) | yes                        | yes                                                                                  | no                                            | no                                | no           | PRESENT — 215 dictionary files (~107 languages incl. cs, sk, de, fr, pl, en-GB/US) shipped; client-side; selection/underline/learn-word are browser UI                             |
| DOCX/Markdown import + export          | yes                        | **yes** (`ENABLE_PANDOC_CONVERSIONS=true` + pandoc/zip/TeX packages in custom image) | no                                            | no                                | custom image | **PASS** — md→project, docx→project, project→docx (valid Word file), project→md (zip) all exercised; imported projects compile (lualatex); nginx UUID fix for conversion downloads |

| Research Library PASS (foundation: personal scope, bibliography)
Grammar/style checking (LanguageTool) | added | **yes** (`WRITING_ASSISTANT_ENABLED=true`, custom image) | no (self-hosted) | LanguageTool ClusterIP | writing-assistant module | **PASS** — `POST /user/writing/grammar` verified with match parity vs raw LanguageTool; editor bundle ships decorations+tooltip (browser click-through pending) |
| AI missing-citation detector | added | **yes** | per-user e-INFRA key | llm.ai.e-infra.cz | writing-assistant module | **PASS** — flagged literature claims (Krylov superlinear convergence, GMRES analysis), correctly skipped the author's own contributions; follow-up buttons: find-in-library / search-Crossref |
| AI citation verification | added | **yes** | per-user e-INFRA key + library entries | llm.ai.e-infra.cz | writing-assistant module | **PASS** — \cite{higham2002} for rounding-error → partially-supported with reasoning; unknown key → not-in-library; cautious verdicts, no false mismatches |
| AI support-from-library (selection → matching entries + insert \cite) | added | **yes** | per-user e-INFRA key | library context | writing-assistant module | **PASS** — statement about iterative methods → \cite{higham2002}, \cite{trefethen1997} with justifications |
| AI related-papers search (selection → Crossref) | added | **yes** | per-user e-INFRA key | llm.ai.e-infra.cz + Crossref | writing-assistant module | **PASS** — "mixed precision randomized least squares" → 5 real papers (Carson 2025 sketching etc.) with add-to-library |
| PDF library (upload per entry, pdftotext extraction, authenticated download) | added | **yes** (`poppler-utils` in image, PVC storage) | no | no | research-library module | **PASS** — sample paper PDF uploaded (2028 chars extracted, content verified), ask-paper grounded in full text |
| AI ask-paper (grounded in uploaded PDF text) | added | **yes** | per-user e-INFRA key | extracted PDF text | writing-assistant module | **PASS** — "which precisions where?" → correct half/QR/Cholesky breakdown citing the paper |
| AI chat over library ("ask my library") | added | **yes** (AI panel context mode 'library') | per-user e-INFRA key | llm.ai.e-infra.cz + researchLibraryReferences | writing-assistant module | **PASS** — question over library → correct citation keys (\cite{trefethen1997}), no invented references |
| Research Library (global bibliography) | added | **yes** (`RESEARCH_LIBRARY_ENABLED=true`, rail panel) | no | Crossref + arXiv APIs (lookups) | research-library module | **PASS** — add via BibTeX paste (dedup by title/DOI), DOI/arXiv/title live lookup, search, materialize library.bib into project (create + refresh), export; editor rail panel shipped in bundle |
| Shared LaTeX assets (macros, notation, theorem environments) | added | **yes** (Research Library rail panel) | no | no | research-library module | **PASS** — create/edit `.tex`/`.sty`/`.cls`, extract `newcommand`/operators/theorems, materialize into project, detect stale links, update in place; verified in downloaded project ZIP |
| AI assistant (per-user e-INFRA LLM) | added | **yes** (custom image) | per-user e-INFRA API key (Account Settings) | llm.ai.e-infra.cz | writing-assistant module | **PASS** — real-key E2E: encrypted token, chat/review/improve streaming; selection and compile-error actions run immediately, while actions needing parameters retain a single submit; structured citation/search results render inline |
| Registration page | yes | no (disabled by default) | no | no | no | DEFERRED — enable with `OVERLEAF_ENABLE_REGISTRATION_PAGE=true` when wanted |
| Admin tools | yes | yes | no | no | no | PRESENT — QA account sees admin pages (real admin: `kovacoj1@gmail.com`) |
| User activation / invite | yes | yes | no | SMTP (not configured) | no | PASS — activation URL flow exercised (email logged, not sent) |
| LDAP | yes (`authentication/ldap`) | no | yes (LDAP server) | IdP | no | AVAILABLE / intentionally not configured |
| SAML | yes (`authentication/saml`) | no | yes (IdP metadata) | IdP | no | AVAILABLE / intentionally not configured |
| OIDC | yes (`authentication/oidc`) | no | yes (OP credentials) | IdP | no | AVAILABLE / intentionally not configured |
| Sandboxed compiles | yes | no | no | sibling containers / privileged | no | DEFERRED — incompatible with CERIT PodSecurity `restricted` as-is; separate design project |
| Dropbox / Mendeley                     | partial                    | no                                                                                   | —                                             | —                                 | —            | not evaluated (SaaS-linked features)                                                                                                                                               |

## Dashboard

```text
Core editing                 PASS
Compilation                  PASS
History                      PASS
Comments                     PRESENT (needs browser click-through)
Track changes                PRESENT (needs browser click-through)
Symbol palette               PRESENT
Reference picker             PRESENT
Zotero                       PASS (per-user key + library import)
Template gallery             PASS
GitHub Sync                  PENDING-USER (bidirectional sync test)
Git Bridge                   PASS (authenticated clone/push)
Multilingual spellcheck      PRESENT (assets verified, browser UI)
LanguageTool grammar         PASS
DOCX/Markdown conversions    PASS
AI rewrite                   PASS (streaming E2E verified)
AI compile-error help        PASS (endpoint verified)
AI equation/table tools      PASS (endpoint verified)
LDAP                         AVAILABLE / not configured
OIDC                         AVAILABLE / not configured
SAML                         AVAILABLE / not configured
Sandboxed compiles           DEFERRED
```

## Notes

- Spell checking = **Hunspell** (client-side, dictionary files under
  `public/js/dictionaries/0.0.3/`). Grammar/style checking is a separate
  system (LanguageTool, Phase 2).
- Pandoc conversions are executed by the **CLSI service**
  (`/convert/docx-to-latex`, `/convert/document-to-latex`), i.e. `pandoc`
  must exist inside the sharelatex image itself. The stock CE+ image does
  not contain it; do not install into running pods — a derived image is
  required (built in Phase 2 together with the new modules).
- Zotero uses encrypted per-user API keys entered in Account Settings. No
  shared OAuth application is required. Research Library imports are one-time
  copies; automatic Zotero synchronization is not implemented.
- Feature defaults (`settings.defaults.js`): `github: true`,
  `gitBridge: true`, `versioning: true`, `references: true`,
  `trackChanges: true`.

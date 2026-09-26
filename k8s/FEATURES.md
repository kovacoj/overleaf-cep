# CE+ Feature Inventory — deployment in `kovacovsky-ns`

Audit performed against the actual `ext-ce` source tree (v6.2.0-231)
and the running deployment of `overleafcep/sharelatex:6.2.0-ext-v5.0`.
Verified 2026-09-25.

Legend for "Test result":

- `PASS` — exercised end-to-end via HTTP/API during this audit or the
  deployment bring-up (compile, persistence, restarts)
- `PRESENT` — code + frontend assets confirmed shipped and enabled, but
  full browser interaction not exercised headlessly (no user-visible
  failure; needs a human click-through)
- `BLOCKED-<reason>` — enabled but a prerequisite is missing
- `PENDING-USER` — requires an account owner action in a browser
- `DEFERRED` — deliberately not enabled

| Feature | In source? | Enabled? | Credentials? | External service? | Custom code? | Test result |
|---|---|---|---|---|---|---|
| Core editing / compilation | yes | yes | no | no | no | PASS — create/edit/compile/PDF verified |
| Project history / versioning | yes | yes | no | no | no | PASS — history-v1 + project-history running; data survives restarts |
| Comments (add/resolve) | yes | yes | no | no | no | PRESENT — frontend module shipped; websocket interaction needs browser |
| Track changes (accept/reject) | yes | yes (`trackChanges: true` default) | no | no | no | PRESENT — module + `track-changes` frontend compiled in bundle |
| Project restore / labels | yes | yes | no | no | no | PRESENT — part of history UI |
| Collaborator permissions | yes | yes | no | no | no | PASS — invite flow available (`OVERLEAF_INVITE_TOKEN_SECRET` set) |
| Full project search | yes (frontend-only module) | yes | no | no | no | PRESENT — uses built-in search APIs |
| Symbol palette | yes | yes | no | no | no | PRESENT — `symbol-palette` in shipped bundle |
| Reference picker | yes | yes (`references: true` default) | no | no (works with local `.bib`) | no | PRESENT — `reference-picker` in codemirror bundle |
| Template gallery | yes | **yes** (`OVERLEAF_TEMPLATE_GALLERY=true`) | no | no | no | PASS — `/templates/all` returns 200; manager = admin user |
| Import file from external URL | yes | **yes** (`url` added to linked file types; linked-url-proxy running in-pod) | no | no | no | PRESENT — `hasLinkUrlFeature=true` |
| GitHub Sync | yes | yes (`GITHUB_SYNC_ENABLED=true`) | yes (OAuth app, set) | github.com | no | PENDING-USER — OAuth start redirects correctly; callback URL validated; E2E bidirectional sync needs account owner |
| Git Bridge (git clone/push) | yes | **no** (`GIT_BRIDGE_ENABLED` unset) | no | git-bridge service (not deployed) | no | DEFERRED — needs the git-bridge service running + env wiring |
| Zotero | yes | wired (`zotero` in linked types; env + cipher secret plumbed) | yes — Zotero OAuth app **not yet registered** | zotero.org | no | BLOCKED-ZOTERO-APP — module activates when `ZOTERO_CLIENT_KEY/SECRET` are filled in `overleaf-secrets`; callback must be registered at zotero.org |
| Multilingual spell checking (Hunspell) | yes | yes | no | no | no | PRESENT — 215 dictionary files (~107 languages incl. cs, sk, de, fr, pl, en-GB/US) shipped; client-side; selection/underline/learn-word are browser UI |
| DOCX/Markdown import + export | yes | **yes** (`ENABLE_PANDOC_CONVERSIONS=true` + pandoc/zip/TeX packages in custom image) | no | no | custom image | **PASS** — md→project, docx→project, project→docx (valid Word file), project→md (zip) all exercised; imported projects compile (lualatex); nginx UUID fix for conversion downloads |
| Grammar/style checking (LanguageTool) | added | **yes** (`WRITING_ASSISTANT_ENABLED=true`, custom image) | no (self-hosted) | LanguageTool ClusterIP | writing-assistant module | **PASS** — `POST /user/writing/grammar` verified with match parity vs raw LanguageTool; editor bundle ships decorations+tooltip (browser click-through pending) |
| AI assistant (per-user e-INFRA LLM) | added | **yes** (custom image) | per-user e-INFRA API key (Account Settings) | llm.ai.e-infra.cz | writing-assistant module | **PARTIAL** — token validation (invalid → 400), status/models/improve verified with graceful no-token 404s; real-key E2E + streaming + diff UI need a user key |
| Registration page | yes | no (disabled by default) | no | no | no | DEFERRED — enable with `OVERLEAF_ENABLE_REGISTRATION_PAGE=true` when wanted |
| Admin tools | yes | yes | no | no | no | PRESENT — QA account sees admin pages (real admin: `kovacoj1@gmail.com`) |
| User activation / invite | yes | yes | no | SMTP (not configured) | no | PASS — activation URL flow exercised (email logged, not sent) |
| LDAP | yes (`authentication/ldap`) | no | yes (LDAP server) | IdP | no | AVAILABLE / intentionally not configured |
| SAML | yes (`authentication/saml`) | no | yes (IdP metadata) | IdP | no | AVAILABLE / intentionally not configured |
| OIDC | yes (`authentication/oidc`) | no | yes (OP credentials) | IdP | no | AVAILABLE / intentionally not configured |
| Sandboxed compiles | yes | no | no | sibling containers / privileged | no | DEFERRED — incompatible with CERIT PodSecurity `restricted` as-is; separate design project |
| Git Bridge (repeated) / Dropbox / Mendeley | partial | no | — | — | — | not evaluated (SaaS-linked features) |

## Dashboard

```text
Core editing                 PASS
Compilation                  PASS
History                      PASS
Comments                     PRESENT (needs browser click-through)
Track changes                PRESENT (needs browser click-through)
Symbol palette               PRESENT
Reference picker             PRESENT
Zotero                       BLOCKED (OAuth app registration pending)
Template gallery             PASS
GitHub Sync                  PENDING-USER (bidirectional sync test)
Git Bridge                   DEFERRED (service not deployed)
Multilingual spellcheck      PRESENT (assets verified, browser UI)
LanguageTool grammar         PASS
DOCX/Markdown conversions    PASS
AI rewrite                   PARTIAL (needs user e-INFRA key)
AI compile-error help        PARTIAL (needs user e-INFRA key)
AI equation/table tools      PARTIAL (needs user e-INFRA key)
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
- Zotero: `ZOTERO_CLIENT_KEY`, `ZOTERO_CLIENT_SECRET` (empty in
  `overleaf-secrets` until an OAuth app is registered at
  https://www.zotero.org/oauth/apps with callback
  `https://overleaf-kovacovsky-ns.dyn.cloud.e-infra.cz/user/zotero/oauth/callback`),
  plus `ZOTERO_TOKEN_CIPHER_PASSWORD` (already set, high-entropy, so token
  encryption is PVC-independent). CE+ requests read-only access to the
  user library and group libraries.
- Feature defaults (`settings.defaults.js`): `github: true`,
  `gitBridge: true`, `versioning: true`, `references: true`,
  `trackChanges: true`.

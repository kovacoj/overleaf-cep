# Overleaf CE+ on CERIT Kubernetes (Rancher)

Plain-manifest deployment of [Overleaf CE+](https://github.com/yu-i-i/overleaf-cep)
(Extended Community Edition) in namespace `kovacovsky-ns`, replacing the old
CERIT catalog chart (which is no longer used or installed).

- Public URL: https://overleaf-kovacovsky-ns.dyn.cloud.e-infra.cz
- Overleaf image: `overleafcep/sharelatex:6.2.0-ext-v5.0`
- MongoDB: `mongo:8.0` StatefulSet, single-node replica set `overleaf`, headless
  service (replica-set member registered under the pod-stable DNS name
  `mongo-0.mongo.kovacovsky-ns.svc.cluster.local` — this survives pod
  recreation; a ClusterIP member name would not)
- Redis: `redis:6.2` Deployment, ephemeral (no persistence yet)
- Storage: `zfs-csi` RWO PVCs — `overleaf-data` (20Gi), `mongo-data` (10Gi)
- Runs as non-root (www-data, uid 33) with a custom ConfigMap entrypoint,
  because the namespace enforces PodSecurity `restricted`

Do **not** upgrade to Overleaf 6.3 yet; the CE+ 6.3 port is still
undergoing upstream work. 6.2.0-ext is the stable CE+ base.

## Writing assistant (grammar + AI)

The `writing-assistant` CE+ module (in the custom image
`cerit.io/kovacoj1/overleaf-cep:6.2.0-ext-v5.0-k8s23`, built from
`k8s/image/Dockerfile`) adds:

1. **Grammar/style checking** via a self-hosted LanguageTool
   (`languagetool.yaml`, ClusterIP-only, backend-proxied at
   `POST /user/writing/grammar`). LaTeX-aware prose projection uses the
   CodeMirror Lezer syntax tree (comments/math/verbatim excluded) plus a
   command-level scanner; checks are debounced and cached per segment.
   Settings: editor settings → spell-check tab (Off / Grammar only /
   Grammar and style, language). Hunspell spelling remains untouched.
2. **AI actions** via each user's **own e-INFRA CZ LLM API key**
   (`https://llm.ai.e-infra.cz/v1`). Account Settings → AI Assistant:
   paste your personal key (generated at chat.ai.e-infra.cz, Settings →
   Account → API keys), pick a model (discovered dynamically via
   `/v1/models`). The key is stored **encrypted** in MongoDB
   (`writingAssistantSettings` collection) using the `AI_TOKEN_CIPHER_PASSWORD`
   secret; it is never returned to the browser, logged, or shared between
   users. AI requests are streamed (SSE) through the Overleaf backend
   (`POST /user/ai/:action`) and happen **only on explicit user action**.
   Editor: select text → AI menu (improve / concise / grammar / translate /
   explain / review / LaTeX fix+explain / equation / table / custom);
   compile errors get an "Explain" action in the log. Mutating results
   show a diff and apply only on Accept. An "AI Assistant" rail panel
   provides chat (context: selection / current file / none) and a
   structured "Review document" action, both streamed.

Build and deploy the custom image:

```bash
docker build -f k8s/image/Dockerfile \
  -t cerit.io/kovacoj1/overleaf-cep:6.2.0-ext-v5.0-k8s23 .
docker push cerit.io/kovacoj1/overleaf-cep:6.2.0-ext-v5.0-k8s23
# then update the image in overleaf-deployment.yaml and
# overleaf-history-flush-all-cronjob.yaml and kubectl apply
```

## Research Library

The `research-library` module adds a personal, project-independent
bibliography (rail panel "Research Library" in the editor):

- add references by pasting BibTeX (deduplicated by DOI / arXiv id /
  normalized title) or by resolving a DOI / arXiv id / title via Crossref
  and the arXiv API
- search the library; click a title to insert `\cite{key}` at the cursor
- "library.bib → project" materializes the whole library into the current
  project as `library.bib` (created on first use, updated in place after)
- `GET /user/research-library/references/export` downloads the full .bib
- PDFs can be attached to entries (stored on the PVC, text extracted
  with pdftotext) and used for grounded AI "ask paper" questions
- the LaTeX Assets tab stores reusable `.tex`, `.sty` and `.cls` files,
  extracts their commands/operators/theorem environments, and materializes
  them into projects with explicit update-available status
- the rail panel uses the same header, Material Symbols, icon buttons,
  tooltips, compact rows and theme tokens as the stock Overleaf editor

Data lives in MongoDB (`researchLibraryReferences` and
`researchLibraryAssets`), one personal scope per user. Group scopes and
shared figures are future extensions (see the research-workspace brief).

## Zotero

The CE+ Zotero module is compiled into the image. To activate it, register
an OAuth application at https://www.zotero.org/oauth/apps with callback:

```text
https://overleaf-kovacovsky-ns.dyn.cloud.e-infra.cz/user/zotero/oauth/callback
```

then fill `ZOTERO_CLIENT_KEY` and `ZOTERO_CLIENT_SECRET` in the
`overleaf-secrets` secret (read-only access to personal + group libraries
is requested; `ZOTERO_TOKEN_CIPHER_PASSWORD` is already set):

```bash
kubectl patch secret overleaf-secrets -n kovacovsky-ns \
  -p '{"stringData":{"ZOTERO_CLIENT_KEY":"<key>","ZOTERO_CLIENT_SECRET":"<secret>"}}'
kubectl rollout restart deployment/overleaf -n kovacovsky-ns
```

## GitHub Sync

Requires the secret `overleaf-secrets` with keys:

- `GITHUB_SYNC_CLIENT_ID`
- `GITHUB_SYNC_CLIENT_SECRET`
- `OVERLEAF_INVITE_TOKEN_SECRET`
- `CRYPTO_RANDOM` (session secret — stable across restarts)
- `WEB_API_PASSWORD`, `STAGING_PASSWORD`, `V1_HISTORY_PASSWORD`,
  `OT_JWT_AUTH_KEY`, `GITHUB_TOKEN_CIPHER_PASSWORD`

(the last group is normally generated by the stock root entrypoint, which
we bypass; generate each value once with `openssl rand -base64 32` and keep
it stable).

Create it from the repo-root `.env` (never committed):

```bash
export NS=kovacovsky-ns
set -a; source ../.env; set +a
kubectl create secret generic overleaf-secrets -n "$NS" \
  --from-literal=GITHUB_SYNC_CLIENT_ID="$GITHUB_SYNC_CLIENT_ID" \
  --from-literal=GITHUB_SYNC_CLIENT_SECRET="$GITHUB_SYNC_CLIENT_SECRET" \
  --from-literal=OVERLEAF_INVITE_TOKEN_SECRET="$OVERLEAF_INVITE_TOKEN_SECRET" \
  --from-literal=CRYPTO_RANDOM="$(openssl rand -base64 32 | tr -d '\n+/=')" \
  --from-literal=WEB_API_PASSWORD="$(openssl rand -base64 32 | tr -d '\n+/=')" \
  --from-literal=STAGING_PASSWORD="$(openssl rand -base64 32 | tr -d '\n+/=')" \
  --from-literal=V1_HISTORY_PASSWORD="$(openssl rand -base64 32 | tr -d '\n+/=')" \
  --from-literal=OT_JWT_AUTH_KEY="$(openssl rand -base64 32 | tr -d '\n+/=')" \
  --from-literal=GITHUB_TOKEN_CIPHER_PASSWORD="$(openssl rand -base64 32 | tr -d '\n+/=')"
```

The GitHub OAuth App callback URL must be:

```text
https://overleaf-kovacovsky-ns.dyn.cloud.e-infra.cz/user/github-sync/oauth2/callback
```

OAuth start endpoint: `/user/github-sync/oauth2` (redirects to GitHub).

The GitHub OAuth App's registered callback was verified to match this URL
(GitHub's authorize endpoint accepts our redirect_uri without a mismatch
error).

First-time setup (requires the GitHub account owner in a browser):

1. Activate the admin account via the `create-user.mjs` activation URL
2. Log in, open a project, menu → GitHub → **Create a Git token / connect**
   (OAuth consent screen appears)
3. Authorize the OAuth app
4. Import the disposable test repo
   https://github.com/kovacoj/overleaf-sync-test (`main.tex`), or push a
   project to it, then sync both directions and compare contents

Note: `STAGING_PASSWORD` and `V1_HISTORY_PASSWORD` in the secret must hold
the **same value** — the stock entrypoint generates one shared secret for
both; web/project-history authenticate to history-v1 with it.

## Deploy (staged)

Overleaf must not start before the Mongo replica set is initialized, so
apply in this order:

```bash
export NS=kovacovsky-ns

kubectl apply -f namespace-check.yaml
kubectl apply -f mongo-service.yaml
kubectl apply -f mongo-statefulset.yaml
kubectl apply -f redis.yaml

kubectl rollout status statefulset/mongo -n "$NS"

kubectl apply -f mongo-init-job.yaml
kubectl wait --for=condition=complete job/mongo-init -n "$NS" --timeout=300s

kubectl apply -f overleaf-pvc.yaml
kubectl apply -f overleaf-configmap-entrypoint.yaml
kubectl apply -f overleaf-deployment.yaml
kubectl apply -f overleaf-service.yaml
kubectl apply -f overleaf-ingress.yaml

kubectl rollout status deployment/overleaf -n "$NS" --timeout=600s
```

The `mongo-init` Job is idempotent — re-running it on an already
initialized replica set succeeds immediately.

## Creating the initial admin user

Registration is disabled by default in CE+. Create users from the CLI:

```bash
export NS=kovacovsky-ns
POD=$(kubectl get pod -n "$NS" -l app.kubernetes.io/name=overleaf -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n "$NS" "$POD" -- bash -c '
  cd /overleaf/services/web && node modules/server-ce-scripts/scripts/create-user.mjs --admin --email=you@example.com'
```

## Verify

```bash
kubectl get pods -n "$NS" -l app.kubernetes.io/part-of=overleaf -o wide

# replica set healthy (expect 1)
kubectl exec -n "$NS" mongo-0 -- mongosh --quiet --eval 'rs.status().ok'

# redis healthy (expect PONG)
kubectl exec -n "$NS" deployment/redis -- redis-cli ping

# Overleaf logs (startup includes migrations, takes a few minutes)
kubectl logs -n "$NS" deployment/overleaf -c sharelatex -f

# public HTTPS (expect 200/302)
curl -I https://overleaf-kovacovsky-ns.dyn.cloud.e-infra.cz
```

## Files

| File                                      | Purpose                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `namespace-check.yaml`                    | Documentation ConfigMap (cluster facts)                                                         |
| `secret.example.yaml`                     | Placeholder template for `overleaf-secrets` — never apply                                       |
| `mongo-service.yaml`                      | Headless service `mongo:27017` (stable pod DNS for the replica set)                             |
| `mongo-statefulset.yaml`                  | Mongo 8.0, `--replSet overleaf --bind_ip_all`, 10Gi zfs-csi PVC                                 |
| `mongo-init-job.yaml`                     | Idempotent `rs.initiate()` job                                                                  |
| `redis.yaml`                              | Redis 6.2 Deployment + Service, ephemeral                                                       |
| `overleaf-pvc.yaml`                       | 20Gi zfs-csi RWO PVC `overleaf-data`                                                            |
| `overleaf-configmap-entrypoint.yaml`      | Non-root entrypoint replacing phusion my_init + history-cron scheduler + graceful-shutdown trap |
| `overleaf-deployment.yaml`                | Overleaf CE+ 6.2.0-ext-v5.0 as www-data (uid 33), nginx on 8080, history-cron sidecar           |
| `overleaf-history-flush-all-cronjob.yaml` | 03:00 full project-history flush                                                                |
| `overleaf-service.yaml`                   | ClusterIP service `overleaf:80`                                                                 |
| `overleaf-ingress.yaml`                   | nginx ingress + cert-manager TLS                                                                |

## Deliberate limitations of this first deployment

- **No sandboxed compiles** — LaTeX compile jobs run unsandboxed inside the
  ShareLaTeX container (no docker.sock, no privileged containers). Instance
  is suitable for trusted users only.
- **Non-root entrypoint** — replaces phusion my_init/runit (required by
  PodSecurity `restricted`). Graceful shutdown flushes document-updater and
  project-history queues to MongoDB on SIGTERM (mirrors upstream
  `init_preshutdown_scripts/`); the upstream `00_close_site` step (site
  maintenance banner + user disconnect) is skipped because
  `/etc/overleaf/site_status` is root-owned and not writable as uid 33.
- **Resource-deletion crons disabled** — upstream also schedules
  `deactivate-projects` (:05), `expire deleted users` (:15) and
  `expire deleted projects` (:20) hourly, gated behind
  `ENABLE_CRON_RESOURCE_DELETION=true`. Deliberately NOT enabled while the
  deployment is new. To enable later: add the env var to the deployment and
  run the corresponding scripts (see `server-ce/config/crontab-deletion`)
  — they call web/admin endpoints and need a similar sidecar or CronJob
  translation.
- No Mongo authentication (namespace-internal networking only).
- No Redis persistence, no backups, no NetworkPolicies, no LDAP/OIDC/SAML,
  no SMTP, no git-bridge, single replica each.
- Overleaf 6.3 / custom CEP image / Helm chart: deferred.

## Project-history maintenance

Replaces `server-ce/config/crontab-history` (normally run by the root cron
inside the image, which we do not run):

| Upstream schedule | Task                                                           | Implementation                       |
| ----------------- | -------------------------------------------------------------- | ------------------------------------ |
| `*/20 * * * *`    | `POST :3054/flush/old?timeout=3600000&limit=5000&background=1` | `history-cron` sidecar               |
| `30 * * * *`      | `POST :3054/retry/failures?failureType=soft&...`               | `history-cron` sidecar               |
| `45 * * * *`      | `POST :3054/retry/failures?failureType=hard&...`               | `history-cron` sidecar               |
| `0 3 * * *`       | `project-history/scripts/flush_all.js`                         | `overleaf-history-flush-all` CronJob |

**Why a sidecar:** project-history listens on `127.0.0.1:3054` only
(upstream default via `env.sh`). Rebinding it to the pod interface would be
an application change and would expose unauthenticated internal endpoints
cluster-wide, so the three HTTP tasks run in a `history-cron` sidecar in
the same pod (shares the network namespace, loopback only, nothing
published). The sidecar (`history-cron.sh` in
`overleaf-configmap-entrypoint.yaml`) fires on minute boundaries with
de-duplication guards.

The 03:00 full flush runs as a proper Kubernetes CronJob
(`overleaf-history-flush-all-cronjob.yaml`, `concurrencyPolicy: Forbid`)
because `flush_all.js` talks to Mongo/Redis via Service DNS and needs no
loopback access; it runs as uid 33 with the same env/secrets as the
Overleaf deployment and must not run the normal entrypoint.

Check history maintenance:

```bash
kubectl logs -n kovacovsky-ns deployment/overleaf -c history-cron --tail=20
kubectl get cronjob,job -n kovacovsky-ns | grep history
```

## Backups (design, not implemented)

What must be backed up:

1. **`mongo-data` PVC** — all project metadata, users, doc contents
2. **`overleaf-data` PVC** — uploaded files, compile output, history
   blobs/chunks (`/var/lib/overleaf/data/history`)
3. **Kubernetes configuration** — the manifests in this directory
   (committed to git) + the actual namespace state
4. **`overleaf-secrets`** — secret names and the recreation procedure
   (README section above; values must NOT be committed to git)

VolumeSnapshots: the cluster has the `snapshot.storage.k8s.io` CRDs
(volumesnapshots etc.), but our user cannot list snapshot classes nor
create VolumeSnapshots (`kubectl auth can-i` → no). Contact
k8s@cerit-sc.cz for snapshot-based or scheduled backups (CERIT docs state
stored data is not backed up by default). A DIY alternative for later: a
CronJob running `mongodump` into a PVC (consistent, since Mongo runs as a
single-member replica set) plus a filesystem copy of `overleaf-data`.

## Updating the secret

```bash
export NS=kovacovsky-ns
set -a; source ../.env; set +a
kubectl create secret generic overleaf-secrets -n "$NS" \
  --from-literal=GITHUB_SYNC_CLIENT_ID="$GITHUB_SYNC_CLIENT_ID" \
  --from-literal=GITHUB_SYNC_CLIENT_SECRET="$GITHUB_SYNC_CLIENT_SECRET" \
  --from-literal=OVERLEAF_INVITE_TOKEN_SECRET="$OVERLEAF_INVITE_TOKEN_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deployment/overleaf -n "$NS"
```

# Derived image: stock CE+ 6.2.0-ext-v5.0 + writing-assistant + pandoc.
#
# Build from the repository root:
#   docker build -f k8s/image/Dockerfile -t cerit.io/kovacoj1/overleaf-cep:6.2.0-ext-v5.0-k8s20 .
#   docker push cerit.io/kovacoj1/overleaf-cep:6.2.0-ext-v5.0-k8s20
#
# Layering on the published CE+ image (instead of rebuilding from
# sharelatex/sharelatex-base) keeps everything except our own changes
# byte-identical to the known-good upstream build:
#   - pandoc for DOCX/Markdown conversion (executed by the CLSI service)
#   - writing-assistant module: LanguageTool grammar/style in the editor +
#     AI actions using each user's own e-INFRA CZ LLM API token
#   - settings.defaults.js: module registrations for the above
#
# The web frontend is rebuilt with webpack and dev dependencies are
# stripped again afterwards, mirroring the upstream `genScript compile`.
FROM overleafcep/sharelatex:6.2.0-ext-v5.0

# pandoc for DOCX/Markdown import + export (runs inside the CLSI), plus
# zip/unzip used by the conversion pipeline to package the output archive,
# and the TeXLive packages required by pandoc's default LaTeX template
# (the stock image ships only a minimal TeXLive subset)
RUN apt-get update \
    && apt-get install -y --no-install-recommends pandoc zip unzip \
    && rm -rf /var/lib/apt/lists/* \
    && tlmgr update --self \
    && tlmgr install unicode-math xcolor fontspec upquote microtype \
       parskip xurl footnotehyper selnolig csquotes luatexbase luaotfload ctablestack

# custom CE+ modules
COPY services/web/modules/writing-assistant /overleaf/services/web/modules/writing-assistant
COPY services/web/modules/research-library /overleaf/services/web/modules/research-library

# module registrations (sourceEditorExtensions, settings modal, editor
# modals, pdf log entry actions, account-settings linking widget)
COPY services/web/config/settings.defaults.js /overleaf/services/web/config/settings.defaults.js

# rebuild the web frontend, then strip dev dependencies again
WORKDIR /overleaf/services/web
RUN CYPRESS_INSTALL_BINARY=0 yarn install \
    && yarn run webpack:production

WORKDIR /overleaf
RUN yarn workspaces focus --all --production

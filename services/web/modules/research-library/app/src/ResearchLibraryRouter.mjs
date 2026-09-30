import { expressify } from "@overleaf/promise-utils";
import AuthenticationController from "../../../../app/src/Features/Authentication/AuthenticationController.mjs";
import AuthorizationMiddleware from "../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs";
import RateLimiterMiddleware from "../../../../app/src/Features/Security/RateLimiterMiddleware.mjs";
import { RateLimiter } from "../../../../app/src/infrastructure/RateLimiter.mjs";
import ResearchLibraryController from "./ResearchLibraryController.mjs";
import PdfController from "./PdfController.mjs";
import AssetsController from "./AssetsController.mjs";
import multer from "multer";
import Settings from "@overleaf/settings";

const pdfUpload = multer({
  dest: Settings.path.uploadFolder,
  limits: { fileSize: 25 * 1024 * 1024 },
});

const readLimiter = new RateLimiter("research-library-read", {
  points: 120,
  duration: 60,
});

const writeLimiter = new RateLimiter("research-library-write", {
  points: 60,
  duration: 60,
});

// external metadata lookups hit Crossref/arXiv: keep them tightly limited
const lookupLimiter = new RateLimiter("research-library-lookup", {
  points: 20,
  duration: 60,
});

export default {
  apply(webRouter) {
    webRouter.get(
      "/user/research-library/status",
      AuthenticationController.requireLogin(),
      expressify(ResearchLibraryController.status),
    );

    webRouter.get(
      "/user/research-library/references",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(readLimiter),
      expressify(ResearchLibraryController.listReferences),
    );

    webRouter.post(
      "/user/research-library/references",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(writeLimiter),
      expressify(ResearchLibraryController.addReferences),
    );

    webRouter.post(
      "/user/research-library/references/from-zotero",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(lookupLimiter),
      expressify(ResearchLibraryController.importFromZotero),
    );

    webRouter.post(
      "/user/research-library/references/lookup",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(lookupLimiter),
      expressify(ResearchLibraryController.lookup),
    );

    webRouter.post(
      "/user/research-library/references/from-lookup",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(writeLimiter),
      expressify(ResearchLibraryController.addFromLookup),
    );

    webRouter.delete(
      "/user/research-library/references/:referenceId",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(writeLimiter),
      expressify(ResearchLibraryController.deleteReference),
    );

    // PDFs attached to library entries (owner only)
    webRouter.post(
      "/user/research-library/references/:referenceId/pdf",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(writeLimiter),
      pdfUpload.single("qqfile"),
      expressify(PdfController.uploadPdf),
    );
    webRouter.get(
      "/user/research-library/references/:referenceId/pdf",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(readLimiter),
      expressify(PdfController.downloadPdf),
    );
    webRouter.get(
      "/user/research-library/references/:referenceId/text",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(readLimiter),
      expressify(PdfController.getText),
    );
    webRouter.delete(
      "/user/research-library/references/:referenceId/pdf",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(writeLimiter),
      expressify(PdfController.deletePdf),
    );

    // shared LaTeX assets (macros, notation, environments)
    webRouter.get(
      "/user/research-library/assets",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(readLimiter),
      expressify(AssetsController.listAssets),
    );
    webRouter.get(
      "/project/:project_id/research-library/assets",
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      RateLimiterMiddleware.rateLimit(readLimiter),
      expressify(AssetsController.listProjectAssets),
    );
    webRouter.get(
      "/user/research-library/assets/:assetId/content",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(readLimiter),
      expressify(AssetsController.getAssetContent),
    );
    webRouter.post(
      "/user/research-library/assets",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(writeLimiter),
      expressify(AssetsController.saveAsset),
    );
    webRouter.delete(
      "/user/research-library/assets/:assetId",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(writeLimiter),
      expressify(AssetsController.deleteAsset),
    );
    webRouter.post(
      "/project/:project_id/research-library/assets/:assetId/materialize",
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      RateLimiterMiddleware.rateLimit(writeLimiter),
      expressify(AssetsController.materializeAsset),
    );

    webRouter.get(
      "/user/research-library/references/export",
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(readLimiter),
      expressify(ResearchLibraryController.exportLibrary),
    );

    webRouter.get(
      "/project/:project_id/research-library/status",
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      RateLimiterMiddleware.rateLimit(readLimiter),
      expressify(ResearchLibraryController.projectStatus),
    );

    webRouter.post(
      "/project/:project_id/research-library/materialize",
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      RateLimiterMiddleware.rateLimit(writeLimiter),
      expressify(ResearchLibraryController.materialize),
    );
  },
};

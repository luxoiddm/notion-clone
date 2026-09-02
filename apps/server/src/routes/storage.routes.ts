import { Router } from 'express';
import multer from 'multer';
import { AuthService, requireAuth, requireOwnStorageOrShared } from '@core/auth';
import { FsEngine, FsEngineError, AccessLevel } from '@core/fs-engine';
import { asyncRoute } from '../middleware/errorHandler.js';
import { documentWriteLimiter, readLimiter } from '../middleware/rateLimiter.js';

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB per asset

/** Resolves whether `viewerId` may access a page at `level`, given its owner + sharing list. */
export function hasAccess(ownerId: string, viewerId: string, sharing: { userId: string; level: AccessLevel }[], required: AccessLevel): boolean {
  if (ownerId === viewerId) return true;
  const rank: Record<AccessLevel, number> = { read: 0, comment: 1, edit: 2, admin: 3 };
  const grant = sharing.find((s) => s.userId === viewerId || s.userId === '*');
  return !!grant && rank[grant.level] >= rank[required];
}

export function storageRoutes(auth: AuthService, engine: FsEngine) {
  const router = Router();
  router.use(requireAuth(auth));

  const ownerGuard = requireOwnStorageOrShared((req) => req.params.userId!);

  // ---- Projects ---------------------------------------------------------

  router.post(
    '/:userId/projects',
    documentWriteLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      if (req.requiresSharingCheck) return res.status(403).json({ error: 'Cannot create projects for another user' });
      const { name } = req.body as { name?: string };
      const project = await engine.createProject(req.params.userId!, name || 'Untitled Project');
      res.status(201).json(project);
    }),
  );

  router.get(
    '/:userId/projects',
    readLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      if (req.requiresSharingCheck) return res.status(403).json({ error: 'Cannot list another user\u2019s projects' });
      res.json(await engine.listProjects(req.params.userId!));
    }),
  );

  // ---- Pages --------------------------------------------------------------

  router.get(
    '/:userId/:projectId/pages',
    readLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      if (req.requiresSharingCheck) return res.status(403).json({ error: 'No access to this project' });
      res.json(await engine.listPages(req.params.userId!, req.params.projectId!));
    }),
  );

  router.post(
    '/:userId/:projectId/pages',
    documentWriteLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      if (req.requiresSharingCheck) return res.status(403).json({ error: 'No access to this project' });
      const { title, parentId, icon } = req.body as { title?: string; parentId?: string | null; icon?: string | null };
      const page = await engine.createPage(req.params.userId!, req.params.projectId!, {
        title: title || 'Untitled',
        parentId: parentId ?? null,
        icon: icon ?? null,
        authorId: req.user!.id,
      });
      res.status(201).json(page);
    }),
  );

  router.get(
    '/:userId/:projectId/pages/:pageId',
    readLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      const meta = await engine.getPageMeta(req.params.userId!, req.params.projectId!, req.params.pageId!);
      if (req.requiresSharingCheck && !hasAccess(req.params.userId!, req.user!.id, meta.sharing, 'read')) {
        throw new FsEngineError('You do not have access to this page', 'FORBIDDEN_PATH');
      }
      const content = await engine.getPageContent(req.params.userId!, req.params.projectId!, req.params.pageId!);
      res.json({ meta, content });
    }),
  );

  router.put(
    '/:userId/:projectId/pages/:pageId/content',
    documentWriteLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      const meta = await engine.getPageMeta(req.params.userId!, req.params.projectId!, req.params.pageId!);
      if (req.requiresSharingCheck && !hasAccess(req.params.userId!, req.user!.id, meta.sharing, 'edit')) {
        throw new FsEngineError('You do not have edit access to this page', 'FORBIDDEN_PATH');
      }
      const result = await engine.savePageContent(
        req.params.userId!,
        req.params.projectId!,
        req.params.pageId!,
        req.body,
        req.user!.id,
      );
      res.json(result);
    }),
  );

  router.patch(
    '/:userId/:projectId/pages/:pageId',
    documentWriteLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      const meta = await engine.getPageMeta(req.params.userId!, req.params.projectId!, req.params.pageId!);
      if (req.requiresSharingCheck && !hasAccess(req.params.userId!, req.user!.id, meta.sharing, 'edit')) {
        throw new FsEngineError('You do not have edit access to this page', 'FORBIDDEN_PATH');
      }

      const { title, parentId, order, icon, tags, coverImage } = req.body as {
        title?: string;
        parentId?: string | null;
        order?: number;
        icon?: string | null;
        tags?: string[];
        coverImage?: string | null;
      };
      let updated = meta;
      if (title !== undefined) {
        updated = await engine.renamePage(req.params.userId!, req.params.projectId!, req.params.pageId!, title, req.user!.id);
      }
      if (icon !== undefined) {
        updated = await engine.updatePageIcon(req.params.userId!, req.params.projectId!, req.params.pageId!, icon, req.user!.id);
      }
      if (coverImage !== undefined) {
        updated = await engine.updatePageCover(req.params.userId!, req.params.projectId!, req.params.pageId!, coverImage, req.user!.id);
      }
      if (tags !== undefined) {
        updated = await engine.updatePageTags(req.params.userId!, req.params.projectId!, req.params.pageId!, tags, req.user!.id);
      }
      if (parentId !== undefined || order !== undefined) {
        updated = await engine.movePage(
          req.params.userId!,
          req.params.projectId!,
          req.params.pageId!,
          parentId ?? meta.parentId,
          order ?? meta.order,
          req.user!.id,
        );
      }
      res.json(updated);
    }),
  );

  // ---- Sharing ------------------------------------------------------------

  router.put(
    '/:userId/:projectId/pages/:pageId/sharing',
    documentWriteLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      const meta = await engine.getPageMeta(req.params.userId!, req.params.projectId!, req.params.pageId!);

      const isOwner = req.params.userId! === req.user!.id;
      const isPlatformAdmin = req.user!.role === 'Admin';
      const holdsAdminGrant = hasAccess(req.params.userId!, req.user!.id, meta.sharing, 'admin');
      if (!isOwner && !isPlatformAdmin && !holdsAdminGrant) {
        throw new FsEngineError('Only the owner or an admin-level grant can manage sharing', 'FORBIDDEN_PATH');
      }

      const { sharing } = req.body as { sharing: { userId: string; level: AccessLevel }[] };
      if (!Array.isArray(sharing)) return res.status(400).json({ error: 'sharing must be an array' });

      const updated = await engine.updatePageSharing(
        req.params.userId!,
        req.params.projectId!,
        req.params.pageId!,
        sharing,
        req.user!.id,
      );
      res.json(updated);
    }),
  );

  router.delete(
    '/:userId/:projectId/pages/:pageId',
    documentWriteLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      if (req.requiresSharingCheck) return res.status(403).json({ error: 'No access to this page' });
      await engine.deletePage(req.params.userId!, req.params.projectId!, req.params.pageId!);
      res.status(204).end();
    }),
  );

  // ---- Search ---------------------------------------------------------

  router.get(
    '/:userId/:projectId/search',
    readLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      if (req.requiresSharingCheck) return res.status(403).json({ error: 'No access to this project' });
      const q = (req.query.q as string) || '';
      res.json(await engine.searchPages(req.params.userId!, req.params.projectId!, q));
    }),
  );

  // ---- History ---------------------------------------------------------

  router.get(
    '/:userId/:projectId/pages/:pageId/history',
    readLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      const meta = await engine.getPageMeta(req.params.userId!, req.params.projectId!, req.params.pageId!);
      if (req.requiresSharingCheck && !hasAccess(req.params.userId!, req.user!.id, meta.sharing, 'read')) {
        throw new FsEngineError('You do not have access to this page', 'FORBIDDEN_PATH');
      }
      res.json(await engine.listHistory(req.params.userId!, req.params.projectId!, req.params.pageId!));
    }),
  );

  router.get(
    '/:userId/:projectId/pages/:pageId/history/:file',
    readLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      const meta = await engine.getPageMeta(req.params.userId!, req.params.projectId!, req.params.pageId!);
      if (req.requiresSharingCheck && !hasAccess(req.params.userId!, req.user!.id, meta.sharing, 'read')) {
        throw new FsEngineError('You do not have access to this page', 'FORBIDDEN_PATH');
      }
      const content = await engine.getHistorySnapshot(req.params.userId!, req.params.projectId!, req.params.pageId!, req.params.file!);
      res.json(content);
    }),
  );

  router.post(
    '/:userId/:projectId/pages/:pageId/history/:file/restore',
    documentWriteLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      const meta = await engine.getPageMeta(req.params.userId!, req.params.projectId!, req.params.pageId!);
      if (req.requiresSharingCheck && !hasAccess(req.params.userId!, req.user!.id, meta.sharing, 'edit')) {
        throw new FsEngineError('You do not have edit access to this page', 'FORBIDDEN_PATH');
      }
      const content = await engine.restoreHistorySnapshot(
        req.params.userId!,
        req.params.projectId!,
        req.params.pageId!,
        req.params.file!,
        req.user!.id,
      );
      res.json(content);
    }),
  );

  // ---- Comments -----------------------------------------------------
  // Flat, page-level comments — see Comment's doc comment in
  // @core/fs-engine/types.ts for why there's no threading. Edit/delete
  // are author-only, enforced by FsEngine itself (throws
  // FsEngineError('FORBIDDEN_PATH') otherwise, mapped to 403 by the
  // global errorHandler — no local try/catch needed here at all).

  router.get(
    '/:userId/:projectId/pages/:pageId/comments',
    readLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      const meta = await engine.getPageMeta(req.params.userId!, req.params.projectId!, req.params.pageId!);
      if (req.requiresSharingCheck && !hasAccess(req.params.userId!, req.user!.id, meta.sharing, 'read')) {
        throw new FsEngineError('You do not have access to this page', 'FORBIDDEN_PATH');
      }
      res.json(await engine.listComments(req.params.userId!, req.params.projectId!, req.params.pageId!));
    }),
  );

  router.post(
    '/:userId/:projectId/pages/:pageId/comments',
    documentWriteLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      const meta = await engine.getPageMeta(req.params.userId!, req.params.projectId!, req.params.pageId!);
      if (req.requiresSharingCheck && !hasAccess(req.params.userId!, req.user!.id, meta.sharing, 'comment')) {
        throw new FsEngineError('You do not have comment access to this page', 'FORBIDDEN_PATH');
      }
      const { text } = req.body as { text?: string };
      if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

      const comment = await engine.addComment(req.params.userId!, req.params.projectId!, req.params.pageId!, req.user!.id, text);
      res.status(201).json(comment);
    }),
  );

  router.patch(
    '/:userId/:projectId/pages/:pageId/comments/:commentId',
    documentWriteLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      const { text } = req.body as { text?: string };
      if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

      const comment = await engine.editComment(
        req.params.userId!,
        req.params.projectId!,
        req.params.pageId!,
        req.params.commentId!,
        req.user!.id,
        text,
      );
      res.json(comment);
    }),
  );

  router.delete(
    '/:userId/:projectId/pages/:pageId/comments/:commentId',
    documentWriteLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      await engine.deleteComment(req.params.userId!, req.params.projectId!, req.params.pageId!, req.params.commentId!, req.user!.id);
      res.status(204).end();
    }),
  );

  // Toggle, not set — reacting again with the same emoji removes it.
  // Any user with comment-level access may react — unlike edit/delete,
  // this isn't restricted to the comment's own author.
  router.post(
    '/:userId/:projectId/pages/:pageId/comments/:commentId/reactions',
    documentWriteLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      const meta = await engine.getPageMeta(req.params.userId!, req.params.projectId!, req.params.pageId!);
      if (req.requiresSharingCheck && !hasAccess(req.params.userId!, req.user!.id, meta.sharing, 'comment')) {
        throw new FsEngineError('You do not have comment access to this page', 'FORBIDDEN_PATH');
      }
      const { emoji } = req.body as { emoji?: string };
      if (!emoji) return res.status(400).json({ error: 'emoji is required' });

      const comment = await engine.toggleCommentReaction(
        req.params.userId!,
        req.params.projectId!,
        req.params.pageId!,
        req.params.commentId!,
        req.user!.id,
        emoji,
      );
      res.json(comment);
    }),
  );

  // ---- Assets (drag-and-drop uploads) ----------------------------------

  // Serves the actual file bytes for an asset embedded in a page (e.g. the
  // <img src> the Editor renders). Note: browsers loading <img>/<a> don't
  // send an Authorization header, so requireAuth also accepts ?token=
  // here — see @core/auth/middleware.ts for the tradeoff.
  router.get(
    '/:userId/:projectId/pages/:pageId/assets/:fileName',
    readLimiter,
    ownerGuard,
    asyncRoute(async (req, res) => {
      const meta = await engine.getPageMeta(req.params.userId!, req.params.projectId!, req.params.pageId!);
      if (req.requiresSharingCheck && !hasAccess(req.params.userId!, req.user!.id, meta.sharing, 'read')) {
        throw new FsEngineError('You do not have access to this page', 'FORBIDDEN_PATH');
      }
      const filePath = engine.getAssetAbsolutePath(req.params.userId!, req.params.projectId!, req.params.pageId!, req.params.fileName!);
      res.sendFile(filePath);
    }),
  );

  router.post(
    '/:userId/:projectId/pages/:pageId/assets',
    documentWriteLimiter,
    ownerGuard,
    upload.single('file'),
    asyncRoute(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const meta = await engine.getPageMeta(req.params.userId!, req.params.projectId!, req.params.pageId!);
      if (req.requiresSharingCheck && !hasAccess(req.params.userId!, req.user!.id, meta.sharing, 'edit')) {
        throw new FsEngineError('You do not have edit access to this page', 'FORBIDDEN_PATH');
      }

      const asset = await engine.saveAsset(
        req.params.userId!,
        req.params.projectId!,
        req.params.pageId!,
        req.file.originalname,
        req.file.buffer,
        req.file.mimetype,
      );
      res.status(201).json(asset);
    }),
  );

  return router;
}

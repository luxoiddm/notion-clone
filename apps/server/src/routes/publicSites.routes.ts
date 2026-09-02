import { Router } from 'express';
import { AuthService, requireAuth, requireRole } from '@core/auth';
import { FsEngine, FsEngineError, PublicNode } from '@core/fs-engine';
import { asyncRoute } from '../middleware/errorHandler.js';
import { documentWriteLimiter, readLimiter } from '../middleware/rateLimiter.js';
import { hasAccess } from './storage.routes.js';

function mutationErrorStatus(err: unknown): number {
  if (err instanceof FsEngineError) {
    if (err.code === 'NOT_FOUND') return 404;
    if (err.code === 'ALREADY_EXISTS') return 409;
    if (err.code === 'INVALID_INPUT') return 400;
  }
  return 500;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

/**
 * Moderator management + moderation — Admin or Team-Lead (requireRole is
 * a minimum-rank check, so 'Team-Lead' here also lets Admin through, not
 * just Team-Lead specifically). Mounted at /api/moderation/public-sites.
 */
export function moderationPublicSitesRoutes(auth: AuthService, engine: FsEngine) {
  const router = Router();
  router.use(requireAuth(auth), requireRole('Team-Lead'));

  router.get(
    '/',
    readLimiter,
    asyncRoute(async (_req, res) => {
      res.json(await engine.listPublicSites());
    }),
  );

  router.post(
    '/',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { slug, title, description } = req.body as { slug?: string; title?: string; description?: string };
      if (!slug || !title) return res.status(400).json({ error: 'slug and title are required' });
      try {
        res.status(201).json(await engine.createPublicSite({ slug, title, description }));
      } catch (err) {
        res.status(mutationErrorStatus(err)).json({ error: errorMessage(err) });
      }
    }),
  );

  router.get(
    '/:id',
    readLimiter,
    asyncRoute(async (req, res) => {
      try {
        const result = await engine.getPublicSiteById(req.params.id!);
        const nodes = await Promise.all(
          result.nodes.map(async (n) => {
            try {
              const meta = await engine.getPageMeta(n.ownerId, n.projectId, n.pageId);
              return { ...n, pageTitle: meta.title, pageIcon: meta.icon, pageMissing: false };
            } catch {
              // The underlying page was deleted or is otherwise
              // unreadable — still shown (a moderator needs to see and
              // clean up stale nodes, not have them silently vanish
              // from the list), just flagged so the UI can say so
              // instead of showing a blank title.
              return { ...n, pageTitle: null, pageIcon: null, pageMissing: true };
            }
          }),
        );
        res.json({ site: result.site, nodes });
      } catch (err) {
        res.status(mutationErrorStatus(err)).json({ error: errorMessage(err) });
      }
    }),
  );

  router.patch(
    '/:id',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const body = req.body as { title?: string; description?: string; enabled?: boolean };
      // Only forwards keys the client actually sent — updatePublicSite()
      // spreads this patch over the current site record, and an
      // explicit `key: undefined` there overwrites the existing value
      // (object spread doesn't skip present-but-undefined keys), not
      // "leave it as is". Blindly destructuring req.body and passing
      // {title, description, enabled} straight through — where any
      // field the client omitted comes out undefined — silently wiped
      // the title/description on a toggle-only request that only meant
      // to flip `enabled`.
      const patch: { title?: string; description?: string; enabled?: boolean } = {};
      if (body.title !== undefined) patch.title = body.title;
      if (body.description !== undefined) patch.description = body.description;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      try {
        res.json(await engine.updatePublicSite(req.params.id!, patch));
      } catch (err) {
        res.status(mutationErrorStatus(err)).json({ error: errorMessage(err) });
      }
    }),
  );

  router.delete(
    '/:id',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      await engine.deletePublicSite(req.params.id!);
      res.status(204).end();
    }),
  );

  // Content preview for moderation — works for any node regardless of
  // status (pending/approved/rejected), since a moderator needs to
  // actually read a submission before deciding on it, not just see its
  // title. Deliberately not gated by the underlying page's own sharing
  // permissions — reviewing a submitted page is the whole point of
  // this role, independent of whether the moderator personally has
  // read/edit access to it through the normal sharing mechanism.
  router.get(
    '/:id/nodes/:nodeId/content',
    readLimiter,
    asyncRoute(async (req, res) => {
      const { nodes } = await engine.getPublicSiteById(req.params.id!);
      const node = nodes.find((n) => n.id === req.params.nodeId);
      if (!node) return res.status(404).json({ error: 'Not found' });
      try {
        const meta = await engine.getPageMeta(node.ownerId, node.projectId, node.pageId);
        const content = await engine.getPageContent(node.ownerId, node.projectId, node.pageId);
        res.json({ title: meta.title, icon: meta.icon, blocks: content.blocks });
      } catch {
        res.status(404).json({ error: 'The underlying page no longer exists' });
      }
    }),
  );

  router.post(
    '/:id/nodes/:nodeId/moderate',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { status, rejectionReason } = req.body as { status?: 'approved' | 'rejected'; rejectionReason?: string };
      if (status !== 'approved' && status !== 'rejected') {
        return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
      }
      try {
        const node = await engine.moderatePublicNode(req.params.id!, req.params.nodeId!, {
          status,
          moderatedBy: req.user!.id,
          rejectionReason,
        });
        res.json(node);
      } catch (err) {
        res.status(mutationErrorStatus(err)).json({ error: errorMessage(err) });
      }
    }),
  );

  router.patch(
    '/:id/nodes/:nodeId/move',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { parentId, order } = req.body as { parentId: string | null; order?: number };
      try {
        const node = await engine.movePublicNode(req.params.id!, req.params.nodeId!, { parentId, order: order ?? Date.now() });
        res.json(node);
      } catch (err) {
        res.status(mutationErrorStatus(err)).json({ error: errorMessage(err) });
      }
    }),
  );

  router.delete(
    '/:id/nodes/:nodeId',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      await engine.deletePublicNode(req.params.id!, req.params.nodeId!);
      res.status(204).end();
    }),
  );

  return router;
}

/**
 * Any authenticated user submitting one of their own — or shared-with-
 * edit-access — pages to a public site. Mounted at /api/public-sites.
 * Deliberately separate from the moderation router above: this needs
 * regular auth, not Admin/Team-Lead, and a different base path keeps
 * that distinction visible in the route table rather than mixed into
 * one router with per-route role checks scattered through it.
 */
export function publicSitesSubmitRoutes(auth: AuthService, engine: FsEngine) {
  const router = Router();
  router.use(requireAuth(auth));

  // Enabled sites only — this is "where can I submit to", not the
  // moderator's full management list (which also includes disabled ones).
  router.get(
    '/',
    readLimiter,
    asyncRoute(async (_req, res) => {
      const sites = await engine.listPublicSites();
      res.json(sites.filter((s) => s.enabled));
    }),
  );

  router.post(
    '/:siteId/submit',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { ownerId, projectId, pageId, parentId } = req.body as {
        ownerId?: string;
        projectId?: string;
        pageId?: string;
        parentId?: string | null;
      };
      if (!ownerId || !projectId || !pageId) {
        return res.status(400).json({ error: 'ownerId, projectId and pageId are required' });
      }
      try {
        const meta = await engine.getPageMeta(ownerId, projectId, pageId);
        if (!hasAccess(meta.ownerId, req.user!.id, meta.sharing, 'edit')) {
          return res.status(403).json({ error: 'You need edit access to this page to submit it' });
        }
        const site = await engine.getPublicSiteById(req.params.siteId!);
        if (!site.site.enabled) {
          return res.status(403).json({ error: 'This public site is currently disabled' });
        }

        const node = await engine.submitPageToPublicSite(req.params.siteId!, {
          ownerId,
          projectId,
          pageId,
          parentId: parentId ?? null,
          submittedBy: req.user!.id,
        });
        res.status(201).json(node);
      } catch (err) {
        res.status(mutationErrorStatus(err)).json({ error: errorMessage(err) });
      }
    }),
  );

  // Withdrawing your own submission — separate from the moderation
  // router's own delete, which can remove *any* node. A regular user
  // may only withdraw a node they themselves submitted.
  router.delete(
    '/:siteId/nodes/:nodeId',
    documentWriteLimiter,
    asyncRoute(async (req, res) => {
      const { nodes } = await engine.getPublicSiteById(req.params.siteId!);
      const node = nodes.find((n: PublicNode) => n.id === req.params.nodeId);
      if (!node) return res.status(404).json({ error: 'Not found' });
      if (node.submittedBy !== req.user!.id) {
        return res.status(403).json({ error: 'You can only withdraw your own submissions' });
      }
      await engine.deletePublicNode(req.params.siteId!, req.params.nodeId!);
      res.status(204).end();
    }),
  );

  return router;
}

/**
 * Unauthenticated public reading — no requireAuth middleware gating the
 * whole router, since most visitors won't have a token at all. The one
 * route that does need to know who's asking (to decide whether to offer
 * an edit link) checks the Authorization header manually and just treats
 * a missing/invalid/expired token as "not editable by this viewer"
 * rather than rejecting the request — an anonymous visitor gets the same
 * successful response as a logged-in one without edit access, just
 * without that link. Mounted at /api/public/:slug.
 */
export function publicSitesReadRoutes(engine: FsEngine, auth: AuthService) {
  const router = Router();

  router.get(
    '/:slug',
    readLimiter,
    asyncRoute(async (req, res) => {
      const result = await engine.getPublicSiteBySlug(req.params.slug!);
      if (!result) return res.status(404).json({ error: 'Not found' });

      const approved = result.nodes.filter((n) => n.status === 'approved');
      const tree = await Promise.all(
        approved.map(async (n) => {
          try {
            const meta = await engine.getPageMeta(n.ownerId, n.projectId, n.pageId);
            return { nodeId: n.id, parentId: n.parentId, ownerId: n.ownerId, projectId: n.projectId, pageId: n.pageId, title: meta.title, icon: meta.icon };
          } catch {
            // The underlying page was deleted after approval — skip it
            // rather than surface a broken entry with no title. Doesn't
            // clean up the stale node itself; a moderator will notice a
            // gap in the tree and can remove it explicitly.
            return null;
          }
        }),
      );

      res.json({
        site: { slug: result.site.slug, title: result.site.title, description: result.site.description },
        tree: tree.filter((t): t is NonNullable<typeof t> => t !== null),
      });
    }),
  );

  router.get(
    '/:slug/pages/:pageId',
    readLimiter,
    asyncRoute(async (req, res) => {
      const result = await engine.getPublicSiteBySlug(req.params.slug!);
      if (!result) return res.status(404).json({ error: 'Not found' });

      // Confirms the requested page is actually an *approved* node of
      // *this* site before returning anything — without this check,
      // the pageId param alone would let anyone read any page's content
      // through this unauthenticated endpoint, moderation status and
      // site membership be damned.
      const node = result.nodes.find((n) => n.pageId === req.params.pageId && n.status === 'approved');
      if (!node) return res.status(404).json({ error: 'Not found' });

      try {
        const meta = await engine.getPageMeta(node.ownerId, node.projectId, node.pageId);
        const content = await engine.getPageContent(node.ownerId, node.projectId, node.pageId);

        // Optional — a visitor with no token, or an expired/invalid
        // one, just gets canEdit: false, same as a logged-in visitor
        // without edit access to this specific page. Neither is an
        // error; this route stays reachable either way.
        let canEdit = false;
        const header = req.headers.authorization;
        const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
        if (token) {
          try {
            const payload = auth.verifyAccessToken(token);
            canEdit = hasAccess(meta.ownerId, payload.sub, meta.sharing, 'edit');
          } catch {
            // Invalid/expired — canEdit stays false, not an error here.
          }
        }

        const publicCoverImage =
          meta.coverImage && !meta.coverImage.startsWith('color:')
            ? `/api/public/${req.params.slug!}/pages/${node.pageId}/assets/${meta.coverImage.split('/').pop()}`
            : meta.coverImage;

        res.json({
          title: meta.title,
          icon: meta.icon,
          coverImage: publicCoverImage,
          blocks: content.blocks,
          canEdit,
          ownerId: node.ownerId,
          projectId: node.projectId,
          pageId: node.pageId,
        });
      } catch {
        res.status(404).json({ error: 'Not found' });
      }
    }),
  );

  // Serves an asset (e.g. a cover image) belonging to an approved page —
  // same "is this pageId actually an approved node of this exact site"
  // check as the content route right above, since an anonymous visitor
  // reading a public page's cover has no token/sharing access to the
  // underlying page at all otherwise. Doesn't (and can't) distinguish
  // "which asset" beyond that — any file already saved under this
  // page's own asset folder is fair game once the page itself is
  // established as legitimately public.
  router.get(
    '/:slug/pages/:pageId/assets/:fileName',
    readLimiter,
    asyncRoute(async (req, res) => {
      const result = await engine.getPublicSiteBySlug(req.params.slug!);
      if (!result) return res.status(404).json({ error: 'Not found' });

      const node = result.nodes.find((n) => n.pageId === req.params.pageId && n.status === 'approved');
      if (!node) return res.status(404).json({ error: 'Not found' });

      const filePath = engine.getAssetAbsolutePath(node.ownerId, node.projectId, node.pageId, req.params.fileName!);
      res.sendFile(filePath);
    }),
  );

  return router;
}

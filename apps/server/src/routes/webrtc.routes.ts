import { Router } from 'express';
import { AuthService, requireAuth } from '@core/auth';
import { buildIceServers } from '@core/webrtc';
import { asyncRoute } from '../middleware/errorHandler.js';
import { readLimiter } from '../middleware/rateLimiter.js';

const DEFAULT_TTL_SECONDS = 3600;

export function webrtcRoutes(auth: AuthService) {
  const router = Router();
  router.use(requireAuth(auth));

  router.get(
    '/ice-servers',
    readLimiter,
    asyncRoute(async (req, res) => {
      const turnHost = process.env.TURN_HOST;
      const turnSecret = process.env.TURN_SECRET;

      if (!turnHost || !turnSecret) {
        // No self-hosted TURN configured — hand back just a STUN-less
        // empty list rather than silently pointing at a third-party
        // server. Calls will still work between peers that don't need
        // NAT traversal help (same network, or both have public IPs);
        // anyone else will fail to connect until TURN_HOST/TURN_SECRET
        // are set — see install.md, "Видеозвонки".
        return res.json({ iceServers: [], turnConfigured: false });
      }

      const iceServers = buildIceServers({
        turnHost,
        turnPort: Number(process.env.TURN_PORT ?? 3478),
        turnTlsPort: process.env.TURN_TLS_PORT ? Number(process.env.TURN_TLS_PORT) : undefined,
        turnSecret,
        ttlSeconds: Number(process.env.TURN_CREDENTIAL_TTL_SECONDS ?? DEFAULT_TTL_SECONDS),
        userLabel: req.user!.id,
      });

      res.json({ iceServers, turnConfigured: true });
    }),
  );

  return router;
}

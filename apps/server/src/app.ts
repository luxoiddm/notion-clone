import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { AuthService } from '@core/auth';
import { FsEngine } from '@core/fs-engine';
import { ChatEngine } from '@core/chat';
import type { RealtimeServer } from '@core/realtime';
import { authRoutes } from './routes/auth.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { storageRoutes } from './routes/storage.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { usersRoutes } from './routes/users.routes.js';
import { sharedRoutes } from './routes/shared.routes.js';
import { filesRoutes } from './routes/files.routes.js';
import { webrtcRoutes } from './routes/webrtc.routes.js';
import { siteRoutes } from './routes/site.routes.js';
import { tileSetsRoutes } from './routes/tileSets.routes.js';
import { moderationPublicSitesRoutes, publicSitesSubmitRoutes, publicSitesReadRoutes } from './routes/publicSites.routes.js';
import { errorHandler } from './middleware/errorHandler.js';

export interface AppDeps {
  auth: AuthService;
  fs: FsEngine;
  chat: ChatEngine;
  io: RealtimeServer;
  webOrigin: string;
  version: string;
}

export function createApp({ auth, fs, chat, io, webOrigin, version }: AppDeps) {
  const app = express();

  app.use(cors({ origin: webOrigin, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) =>
    res.json({
      status: 'ok',
      time: new Date().toISOString(),
      adminEmailConfigured: Boolean(process.env.ADMIN_EMAIL),
      webOrigin,
      version,
    }),
  );

  app.use('/api/auth', authRoutes(auth, fs));
  app.use('/api/admin', adminRoutes(auth, fs));
  app.use('/api/storage', storageRoutes(auth, fs));
  app.use('/api/chats', chatRoutes(auth, chat, io));
  app.use('/api/users', usersRoutes(auth, fs));
  app.use('/api/shared', sharedRoutes(auth, fs));
  app.use('/api/files', filesRoutes(auth, fs));
  app.use('/api/webrtc', webrtcRoutes(auth));
  app.use('/api/site-settings', siteRoutes(fs, version));
  app.use('/api/tile-sets', tileSetsRoutes(fs));
  app.use('/api/moderation/public-sites', moderationPublicSitesRoutes(auth, fs));
  app.use('/api/public-sites', publicSitesSubmitRoutes(auth, fs));
  app.use('/api/public', publicSitesReadRoutes(fs, auth));

  // Centralized error handler — must be registered last.
  app.use(errorHandler);

  return app;
}

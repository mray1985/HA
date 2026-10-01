import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { authRoutes } from './routes/auth.js';
import { modelRoutes } from './routes/models.js';

/**
 * The preparer's server: sign-in, the local model routes, and the built site.
 * `createApp` builds it; `startServer` listens (the desktop app binds it to
 * 127.0.0.1 on a free port).
 */
export function createApp(options: { port: number | string; clientDist?: string | null }): express.Express {
  const app = express();
  const PORT = options.port;

  // Trust first proxy (when behind nginx/cloudflare/etc.) so req.ip is the real client IP.
  // Without this, rate limiting uses the proxy's IP and all users share one bucket.
  if (process.env.TRUST_PROXY === '1' || process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  // ─── Security Headers ────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'", "blob:", ...(process.env.API_ORIGIN ? [process.env.API_ORIGIN] : [])],
        imgSrc: ["'self'", "data:", "blob:"],
        workerSrc: ["'self'", "blob:"],
        frameSrc: ["'self'", "blob:"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
  }));

  // ─── CORS ────────────────────────────────────────
  const DEFAULT_ORIGINS = [
    'http://localhost:5174',   // Vite dev server
    'http://localhost:4174',   // Vite preview
    'http://127.0.0.1:5174',
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
  ];
  const ALLOWED_ORIGINS = [
    ...(process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
      : []),
    ...DEFAULT_ORIGINS,
  ];

  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, curl, etc.)
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('CORS: origin not allowed'));
      }
    },
    credentials: true,
  }));

  // A page image for the local models is larger than any other request.
  app.use('/api/models', express.json({ limit: '25mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/models', modelRoutes);

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Built site, when client/dist is present. Same origin as /api so sign-in works
  // without a separate dev proxy.
  function findClientDist(): string | null {
    const candidates = [
      process.env.CLIENT_DIST,
      resolve(process.cwd(), 'client', 'dist'),
      resolve(process.cwd(), '..', 'client', 'dist'),
    ].filter((dir): dir is string => Boolean(dir));
    return candidates.find((dir) => existsSync(resolve(dir, 'index.html'))) ?? null;
  }

  const clientDist = options.clientDist === undefined ? findClientDist() : options.clientDist;
  if (clientDist) {
    const preparerHtml = existsSync(resolve(clientDist, 'preparer.html'));
    app.use(express.static(clientDist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api')) return next();
      const preparer =
        preparerHtml && (req.path === '/preparer' || req.path.startsWith('/preparer/'));
      res.sendFile(resolve(clientDist, preparer ? 'preparer.html' : 'index.html'));
    });
  }

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Server error:', err);
    res.status(500).json({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } });
  });

  return app;
}

export interface StartedServer {
  port: number;
  close: () => Promise<void>;
}

export function startServer(options: { port?: number; host?: string; clientDist?: string | null } = {}): Promise<StartedServer> {
  const port = options.port ?? 3002;
  const host = options.host ?? '127.0.0.1';
  return new Promise((resolveStarted, reject) => {
    // Port 0 picks a free port; the site's CORS allows the port actually used.
    const probe = express();
    const server = probe.listen(port, host);
    server.once('error', reject);
    server.once('listening', () => {
      const actual = (server.address() as { port: number }).port;
      probe.use(createApp({ port: actual, clientDist: options.clientDist }));
      resolveStarted({
        port: actual,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

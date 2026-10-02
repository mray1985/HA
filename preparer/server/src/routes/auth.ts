import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'crypto';
import {
  DATA_DIR,
  activateSubscription,
  createSession,
  createUser,
  deleteExpiredSessions,
  deleteSession,
  deleteUser,
  getSession,
  getUserByEmail,
  getUserById,
  updateUserLastLogin,
} from '../database.js';
import { resolveJwtSecret } from '../jwtSecret.js';

const router = Router();

const JWT_SECRET = resolveJwtSecret(DATA_DIR);
const TOKEN_EXPIRY = '7d';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = 12;

/** HA Tax Preparer signs in preparers, and admins who manage their accounts. */
const ACCOUNT_ROLES = new Set(['preparer', 'admin']);
const NOT_A_PREPARER = 'This account is not a preparer account.';

interface TokenPayload {
  userId: number;
  email: string;
  role: string;
  /** Session the token belongs to; signing out deletes it, which revokes the token. */
  sid: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function verifyAccessToken(token: string): TokenPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as Partial<TokenPayload>;
    return typeof payload.userId === 'number' && typeof payload.sid === 'string' ? (payload as TokenPayload) : null;
  } catch {
    return null;
  }
}

/**
 * A signed token is accepted only while its session exists and was issued
 * with that exact token — so signing out (or deleting the user) ends it.
 */
function sessionFor(token: string): TokenPayload | null {
  const payload = verifyAccessToken(token);
  if (!payload) return null;
  const session = getSession.get(payload.sid);
  if (!session || session.user_id !== payload.userId || session.token_hash !== sha256(token)) return null;
  return payload;
}

/** Start a session for a user and issue its token (also set as a cookie). */
function startSession(res: Response, user: { id: number; email: string; role: string }): string {
  const sid = randomBytes(32).toString('hex');
  const token = jwt.sign({ userId: user.id, email: user.email, role: user.role, sid }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
  createSession.run(sid, user.id, sha256(token), new Date(Date.now() + SESSION_MS).toISOString());
  setTokenCookie(res, token);
  return token;
}

function requestToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return (header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined) || req.cookies?.access_token;
}

function setTokenCookie(res: Response, token: string): void {
  res.cookie('access_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearTokenCookie(res: Response): void {
  res.clearCookie('access_token', { path: '/' });
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = requestToken(req);
  if (!token) {
    res.status(401).json({ error: { message: 'Authentication required', code: 'UNAUTHORIZED' } });
    return;
  }

  const payload = sessionFor(token);
  if (!payload) {
    res.status(401).json({ error: { message: 'Invalid or expired token', code: 'INVALID_TOKEN' } });
    return;
  }
  if (!ACCOUNT_ROLES.has(payload.role)) {
    res.status(403).json({ error: { message: NOT_A_PREPARER, code: 'FORBIDDEN' } });
    return;
  }

  (req as any).user = payload;
  next();
}

function seasonEnd(now = new Date()): string {
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const year = month > 3 || (month === 3 && day > 15) ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  return `${year}-04-15T23:59:59.000Z`;
}

function publicUser(user: {
  id: number;
  email: string;
  name: string | null;
  role: string;
  subscription_status?: string | null;
  subscriptionStatus?: string | null;
  subscription_until?: string | null;
  subscriptionUntil?: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    subscriptionStatus: user.subscription_status || user.subscriptionStatus || 'inactive',
    subscriptionUntil: user.subscription_until || user.subscriptionUntil || null,
  };
}

function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!roles.includes((req as any).user?.role)) {
      res.status(403).json({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } });
      return;
    }
    next();
  };
}

router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: { message: 'Email and password required', code: 'VALIDATION_ERROR' } });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: { message: 'Invalid email format', code: 'VALIDATION_ERROR' } });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: { message: 'Password must be at least 8 characters', code: 'VALIDATION_ERROR' } });
    }

    const normalizedEmail = email.toLowerCase();
    const existing = getUserByEmail.get(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: { message: 'Email already registered', code: 'EMAIL_EXISTS' } });
    }

    if (role !== undefined && role !== 'preparer') {
      return res.status(400).json({ error: { message: 'Only preparer accounts can be registered', code: 'VALIDATION_ERROR' } });
    }
    const userRole = 'preparer';

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = createUser.run(normalizedEmail, passwordHash, name || '', userRole);

    const userId = Number(result.lastInsertRowid);
    updateUserLastLogin.run(userId);
    const accessToken = startSession(res, { id: userId, email: normalizedEmail, role: userRole });

    res.status(201).json({
      data: {
        user: publicUser({
          id: userId,
          email: normalizedEmail,
          name: name || '',
          role: userRole,
          subscription_status: 'inactive',
          subscription_until: null,
        }),
        accessToken,
      },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: { message: 'Registration failed', code: 'INTERNAL_ERROR' } });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: { message: 'Email and password required', code: 'VALIDATION_ERROR' } });
    }

    const user = getUserByEmail.get(email.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: { message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' } });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: { message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' } });
    }
    if (!ACCOUNT_ROLES.has(user.role)) {
      return res.status(403).json({ error: { message: NOT_A_PREPARER, code: 'FORBIDDEN' } });
    }

    updateUserLastLogin.run(user.id);
    const accessToken = startSession(res, user);

    res.json({
      data: {
        user: publicUser(user),
        accessToken,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: { message: 'Login failed', code: 'INTERNAL_ERROR' } });
  }
});

router.post('/logout', (req: Request, res: Response) => {
  const token = requestToken(req);
  const payload = token ? verifyAccessToken(token) : null;
  if (payload) deleteSession.run(payload.sid);
  deleteExpiredSessions.run();
  clearTokenCookie(res);
  res.json({ data: { message: 'Logged out' } });
});

router.get('/me', requireAuth, (req: Request, res: Response) => {
  const payload = (req as any).user as { userId: number };
  const user = getUserById.get(payload.userId);
  if (!user) {
    return res.status(401).json({ error: { message: 'Invalid or expired token', code: 'INVALID_TOKEN' } });
  }
  res.json({ data: { user: publicUser(user) } });
});

router.post('/subscription/activate', requireAuth, (req: Request, res: Response) => {
  const payload = (req as any).user as { userId: number };
  const until = seasonEnd();
  activateSubscription.run(until, payload.userId);
  const user = getUserById.get(payload.userId);
  if (!user) {
    return res.status(404).json({ error: { message: 'User not found', code: 'NOT_FOUND' } });
  }
  res.json({ data: { user: publicUser(user) } });
});

/** A positive integer user id from the route, or null. */
function userIdParam(req: Request): number | null {
  const id = Number(String(req.params.id));
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get('/user/:id', requireAuth, (req: Request, res: Response) => {
  const requestingUser = (req as any).user as TokenPayload;
  const targetId = userIdParam(req);
  if (targetId === null) {
    return res.status(400).json({ error: { message: 'Invalid user id', code: 'VALIDATION_ERROR' } });
  }

  if (requestingUser.role !== 'admin' && requestingUser.userId !== targetId) {
    return res.status(403).json({ error: { message: 'Forbidden', code: 'FORBIDDEN' } });
  }

  const user = getUserById.get(targetId);
  if (!user) {
    return res.status(404).json({ error: { message: 'User not found', code: 'NOT_FOUND' } });
  }

  res.json({ data: { user: publicUser(user) } });
});

router.delete('/user/:id', requireAuth, requireRole('admin'), (req: Request, res: Response) => {
  const targetId = userIdParam(req);
  const requestingUser = (req as any).user as TokenPayload;
  if (targetId === null) {
    return res.status(400).json({ error: { message: 'Invalid user id', code: 'VALIDATION_ERROR' } });
  }

  if (requestingUser.userId === targetId) {
    return res.status(400).json({ error: { message: 'Cannot delete yourself', code: 'SELF_DELETE' } });
  }

  const result = deleteUser.run(targetId);

  if (result.changes === 0) {
    return res.status(404).json({ error: { message: 'User not found', code: 'NOT_FOUND' } });
  }

  res.json({ data: { message: 'User deleted' } });
});

export { router as authRoutes, requireAuth, requireRole, JWT_SECRET };
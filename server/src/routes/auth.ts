import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { db, createUser, getUserByEmail, getUserById, updateUserLastLogin, createSession, getSession, deleteSession, deleteExpiredSessions } from '../database.js';
import { config } from '../config.js';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const TOKEN_EXPIRY = '7d';
const REFRESH_EXPIRY = '30d';
const BCRYPT_ROUNDS = 12;

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return bcrypt.hashSync(token, 1);
}

function createAccessToken(userId: number, email: string, role: string): string {
  return jwt.sign({ userId, email, role }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function verifyAccessToken(token: string): { userId: number; email: string; role: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { userId: number; email: string; role: string };
  } catch {
    return null;
  }
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
  const authHeader = req.headers.authorization;
  const cookieToken = req.cookies?.access_token;
  const token = authHeader?.replace('Bearer ', '') || cookieToken;

  if (!token) {
    res.status(401).json({ error: { message: 'Authentication required', code: 'UNAUTHORIZED' } });
    return;
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    res.status(401).json({ error: { message: 'Invalid or expired token', code: 'INVALID_TOKEN' } });
    return;
  }

  (req as any).user = payload;
  next();
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

    const existing = getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: { message: 'Email already registered', code: 'EMAIL_EXISTS' } });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = createUser.run(email.toLowerCase(), passwordHash, name || '', role || 'preparer');

    const userId = result.lastInsertRowid as number;
    updateUserLastLogin.run(userId);

    const accessToken = createAccessToken(userId, email.toLowerCase(), role || 'preparer');
    const sessionToken = generateToken();
    const tokenHash = hashToken(sessionToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    createSession.run(sessionToken, userId, tokenHash, expiresAt);

    setTokenCookie(res, accessToken);

    res.status(201).json({
      data: {
        user: { id: userId, email: email.toLowerCase(), name, role: role || 'preparer' },
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

    const user = getUserByEmail(email.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: { message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' } });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: { message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' } });
    }

    updateUserLastLogin.run(user.id);

    const accessToken = createAccessToken(user.id, user.email, user.role);
    const sessionToken = generateToken();
    const tokenHash = hashToken(sessionToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    createSession.run(sessionToken, user.id, tokenHash, expiresAt);

    setTokenCookie(res, accessToken);

    res.json({
      data: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        accessToken,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: { message: 'Login failed', code: 'INTERNAL_ERROR' } });
  }
});

router.post('/logout', (req: Request, res: Response) => {
  const cookieToken = req.cookies?.access_token;
  if (cookieToken) {
    const payload = jwt.decode(cookieToken) as any;
    if (payload?.userId) {
      deleteExpiredSessions.run();
    }
  }
  clearTokenCookie(res);
  res.json({ data: { message: 'Logged out' } });
});

router.get('/me', requireAuth, (req: Request, res: Response) => {
  const user = (req as any).user;
  res.json({ data: { user } });
});

router.get('/user/:id', requireAuth, (req: Request, res: Response) => {
  const requestingUser = (req as any).user;
  const targetId = parseInt(req.params.id, 10);

  if (requestingUser.role !== 'admin' && requestingUser.userId !== targetId) {
    return res.status(403).json({ error: { message: 'Forbidden', code: 'FORBIDDEN' } });
  }

  const user = getUserById(targetId);
  if (!user) {
    return res.status(404).json({ error: { message: 'User not found', code: 'NOT_FOUND' } });
  }

  res.json({ data: { user } });
});

router.delete('/user/:id', requireAuth, requireRole('admin'), (req: Request, res: Response) => {
  const targetId = parseInt(req.params.id, 10);
  const requestingUser = (req as any).user;

  if (requestingUser.userId === targetId) {
    return res.status(400).json({ error: { message: 'Cannot delete yourself', code: 'SELF_DELETE' } });
  }

  const stmt = db.prepare('DELETE FROM users WHERE id = ?');
  const result = stmt.run(targetId);

  if (result.changes === 0) {
    return res.status(404).json({ error: { message: 'User not found', code: 'NOT_FOUND' } });
  }

  res.json({ data: { message: 'User deleted' } });
});

export { router as authRoutes, requireAuth, requireRole, JWT_SECRET };
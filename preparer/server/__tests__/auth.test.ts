import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'hatax-auth-'));
process.env.HATAX_DB_PATH = join(dir, 'auth.db');
process.env.JWT_SECRET = 'test-jwt-secret';

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { authRoutes } = await import('../src/routes/auth.js');
const { closeDatabase, createUser } = await import('../src/database.js');
const { resolveJwtSecret } = await import('../src/jwtSecret.js');
const bcrypt = (await import('bcrypt')).default;
const jwt = (await import('jsonwebtoken')).default;

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json() };
}

describe('auth routes', () => {
  it('registers a preparer, rejects any other account, and reads /me from the token', async () => {
    const created = await post('/api/auth/register', {
      email: 'New.Preparer@Example.com',
      password: 'password1',
      name: 'New Preparer',
    });
    expect(created.res.status).toBe(201);
    expect(created.body.data.user.email).toBe('new.preparer@example.com');
    expect(created.body.data.user.role).toBe('preparer');
    expect(created.res.headers.get('set-cookie')).toContain('access_token');

    for (const role of ['admin', 'taxpayer']) {
      const rejected = await post('/api/auth/register', {
        email: `${role}-signup@example.com`,
        password: 'password1',
        name: role,
        role,
      });
      expect(rejected.res.status).toBe(400);
    }

    const me = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${created.body.data.accessToken}` },
    });
    expect(me.status).toBe(200);
    const meBody = await me.json();
    expect(meBody.data.user.role).toBe('preparer');
    expect(meBody.data.user.name).toBe('New Preparer');
  });

  it('refuses to sign in an account that is not a preparer account', async () => {
    createUser.run('household@example.com', await bcrypt.hash('password1', 4), 'Household', 'taxpayer');
    const login = await post('/api/auth/login', { email: 'household@example.com', password: 'password1' });
    expect(login.res.status).toBe(403);
    expect(login.body.error.message).toBe('This account is not a preparer account.');
    expect(login.res.headers.get('set-cookie')).toBeNull();
  });

  it('logs a preparer in and rejects a bad password', async () => {
    const created = await post('/api/auth/register', {
      email: 'preparer@example.com',
      password: 'password1',
      name: 'Prep Arer',
      role: 'preparer',
    });
    expect(created.res.status).toBe(201);

    const bad = await post('/api/auth/login', {
      email: 'preparer@example.com',
      password: 'wrong-password',
    });
    expect(bad.res.status).toBe(401);

    const good = await post('/api/auth/login', {
      email: 'preparer@example.com',
      password: 'password1',
    });
    expect(good.res.status).toBe(200);
    expect(good.body.data.user.role).toBe('preparer');

    const duplicate = await post('/api/auth/register', {
      email: 'preparer@example.com',
      password: 'password1',
      name: 'Prep Arer',
      role: 'preparer',
    });
    expect(duplicate.res.status).toBe(409);
  });

  it('keeps a new preparer inactive until the season seat is started', async () => {
    const created = await post('/api/auth/register', {
      email: 'seat@example.com',
      password: 'password1',
      name: 'Seat Holder',
      role: 'preparer',
    });
    expect(created.res.status).toBe(201);
    expect(created.body.data.user.subscriptionStatus).toBe('inactive');

    const denied = await fetch(`${base}/api/auth/subscription/activate`, { method: 'POST' });
    expect(denied.status).toBe(401);

    const started = await fetch(`${base}/api/auth/subscription/activate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.body.data.accessToken}` },
    });
    expect(started.status).toBe(200);
    const body = await started.json();
    expect(body.data.user.subscriptionStatus).toBe('active');
    expect(new Date(body.data.user.subscriptionUntil).getUTCMonth()).toBe(3);
    expect(new Date(body.data.user.subscriptionUntil).getUTCDate()).toBe(15);
  });

  it('ends the session on sign-out, so the same token no longer works', async () => {
    const created = await post('/api/auth/register', { email: 'signout@example.com', password: 'password1', name: 'Out', role: 'preparer' });
    const auth = { Authorization: `Bearer ${created.body.data.accessToken}` };
    expect((await fetch(`${base}/api/auth/me`, { headers: auth })).status).toBe(200);

    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: auth });
    expect(out.status).toBe(200);
    expect((await fetch(`${base}/api/auth/me`, { headers: auth })).status).toBe(401);

    // Signing in again starts a new session with its own token.
    const again = await post('/api/auth/login', { email: 'signout@example.com', password: 'password1' });
    expect((await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${again.body.data.accessToken}` } })).status).toBe(200);
  });

  it('rejects a token signed with another key, or without a session', async () => {
    const created = await post('/api/auth/register', { email: 'forge@example.com', password: 'password1', name: 'F', role: 'preparer' });
    const { userId, sid } = jwt.decode(created.body.data.accessToken) as { userId: number; sid: string };
    const forged = jwt.sign({ userId, email: 'forge@example.com', role: 'admin', sid }, 'change-me-in-production');
    expect((await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${forged}` } })).status).toBe(401);
    const noSession = jwt.sign({ userId, email: 'forge@example.com', role: 'preparer' }, 'test-jwt-secret');
    expect((await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${noSession}` } })).status).toBe(401);
  });

  it("lets an admin delete a user, and ends that user's sessions", async () => {
    createUser.run('admin@example.com', await bcrypt.hash('password1', 4), 'Admin', 'admin');
    const admin = await post('/api/auth/login', { email: 'admin@example.com', password: 'password1' });
    const adminAuth = { Authorization: `Bearer ${admin.body.data.accessToken}` };
    const target = await post('/api/auth/register', { email: 'leaving@example.com', password: 'password1', name: 'L', role: 'preparer' });
    const targetId = target.body.data.user.id;

    const self = await fetch(`${base}/api/auth/user/${admin.body.data.user.id}`, { method: 'DELETE', headers: adminAuth });
    expect(self.status).toBe(400);
    const bad = await fetch(`${base}/api/auth/user/abc`, { method: 'DELETE', headers: adminAuth });
    expect(bad.status).toBe(400);

    const removed = await fetch(`${base}/api/auth/user/${targetId}`, { method: 'DELETE', headers: adminAuth });
    expect(removed.status).toBe(200);
    expect((await fetch(`${base}/api/auth/user/${targetId}`, { method: 'DELETE', headers: adminAuth })).status).toBe(404);
    const targetAuth = { Authorization: `Bearer ${target.body.data.accessToken}` };
    expect((await fetch(`${base}/api/auth/me`, { headers: targetAuth })).status).toBe(401);
  });
});

describe('resolveJwtSecret', () => {
  it('uses JWT_SECRET when set, otherwise one random key per install that survives restarts', () => {
    const keyDir = mkdtempSync(join(tmpdir(), 'hatax-key-'));
    try {
      expect(resolveJwtSecret(keyDir, { JWT_SECRET: 'configured' })).toBe('configured');
      const first = resolveJwtSecret(keyDir, {});
      expect(first).toMatch(/^[0-9a-f]{96}$/);
      expect(resolveJwtSecret(keyDir, {})).toBe(first);
      const other = mkdtempSync(join(tmpdir(), 'hatax-key-'));
      expect(resolveJwtSecret(other, {})).not.toBe(first);
      rmSync(other, { recursive: true, force: true });
    } finally {
      rmSync(keyDir, { recursive: true, force: true });
    }
  });
});

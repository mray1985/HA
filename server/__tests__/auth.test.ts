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
const { closeDatabase } = await import('../src/database.js');

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
  it('registers a taxpayer, rejects admin, and reads /me from the token', async () => {
    const created = await post('/api/auth/register', {
      email: 'Taxpayer@Example.com',
      password: 'password1',
      name: 'Tax Payer',
      role: 'taxpayer',
    });
    expect(created.res.status).toBe(201);
    expect(created.body.data.user.email).toBe('taxpayer@example.com');
    expect(created.body.data.user.role).toBe('taxpayer');
    expect(created.res.headers.get('set-cookie')).toContain('access_token');

    const rejected = await post('/api/auth/register', {
      email: 'admin@example.com',
      password: 'password1',
      name: 'Admin',
      role: 'admin',
    });
    expect(rejected.res.status).toBe(400);

    const me = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${created.body.data.accessToken}` },
    });
    expect(me.status).toBe(200);
    const meBody = await me.json();
    expect(meBody.data.user.role).toBe('taxpayer');
    expect(meBody.data.user.name).toBe('Tax Payer');
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
});

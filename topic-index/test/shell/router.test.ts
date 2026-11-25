import { describe, expect, it } from 'vitest';
import { Router } from '../../src/http/router';

// hono を置き換えた小さな経路の仕組み（0023 の決定 7）

describe('Router', () => {
  type V = { who: string };

  const build = () => {
    const app = new Router<V>();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    app.use(async (c, next) => {
      c.set('who', c.req.header('x-who') ?? 'anon');
      await next();
    });
    app.get('/hello', (c) => c.text(`hi ${c.var.who}`));
    const api = new Router<V>();
    api.use(async (c, next) => {
      if (c.var.who === 'anon') return c.json({ error: 'unauthenticated' }, 401);
      await next();
    });
    api.get('/threads/:id', (c) => c.json({ id: c.req.param('id'), q: c.req.query() }));
    api.post('/threads/:id/claim', async (c) => c.json({ id: c.req.param('id'), raw: await c.req.text(), body: await c.req.json() }));
    api.get('/boom', () => {
      throw new Error('boom');
    });
    app.route('/api', api);
    return app;
  };

  it('パスの引数・クエリ・ミドルウェアの値を渡す（引数はデコードする）', async () => {
    const app = build();
    const res = await app.request('/api/threads/thr%2F1?since=x&filter=y', { headers: { 'x-who': 'u' } });
    expect(await res.json()).toEqual({ id: 'thr/1', q: { since: 'x', filter: 'y' } });
    expect(await (await app.request('/hello')).text()).toBe('hi anon');
  });

  it('下の Router のミドルウェアはその経路にだけ効き、応答を返せば先へ進まない', async () => {
    const app = build();
    expect((await app.request('/api/threads/1')).status).toBe(401);
    expect((await app.request('/hello')).status).toBe(200);
  });

  it('本文は text と json で使い回せる', async () => {
    const res = await build().request('/api/threads/1/claim', { method: 'POST', body: '{"a":1}', headers: { 'x-who': 'u' } });
    expect(await res.json()).toEqual({ id: '1', raw: '{"a":1}', body: { a: 1 } });
  });

  it('経路がない・メソッドが違うと 404、例外は onError', async () => {
    const app = build();
    expect((await app.request('/nope')).status).toBe(404);
    expect((await app.request('/hello', { method: 'POST' })).status).toBe(404);
    const boom = await app.request('/api/boom', { headers: { 'x-who': 'u' } });
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ error: 'Error: boom' });
  });
});

// HTTP の経路の小さな仕組み（0023 の決定 7: 実行時の依存を足さない。hono から置き換えた）。
// app.ts が使う口（経路・ミドルウェア・パスの引数・クエリ・JSON とテキストの応答）だけを持つ。

export type Handler<V> = (c: Context<V>) => Promise<Response> | Response;
export type Middleware<V> = (c: Context<V>, next: () => Promise<void>) => Promise<Response | void> | Response | void;
type Method = 'GET' | 'POST' | 'PATCH';

interface Route<V> {
  method: Method;
  pattern: RegExp;
  names: string[];
  handler: Handler<V>;
  middlewares: Middleware<V>[];
}

export class Context<V> {
  readonly req: RequestView;
  private readonly vars: Partial<V> = {};

  constructor(request: Request, params: Record<string, string>) {
    this.req = new RequestView(request, params);
  }

  /** ミドルウェアが置いた値 */
  get var(): V {
    return this.vars as V;
  }

  set<K extends keyof V>(key: K, value: V[K]): void {
    this.vars[key] = value;
  }

  json(body: unknown, status = 200): Response {
    return Response.json(body, { status });
  }

  text(body: string, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
  }

  html(body: string, status = 200): Response {
    return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  body(body: null, status: number): Response {
    return new Response(body, { status });
  }
}

export class RequestView {
  private readonly url: URL;
  private raw: Promise<string> | undefined;

  constructor(
    private readonly request: Request,
    private readonly params: Record<string, string>,
  ) {
    this.url = new URL(request.url);
  }

  param(name: string): string {
    const v = this.params[name];
    if (v === undefined) throw new Error(`no path parameter ${name}`);
    return v;
  }

  query(): Record<string, string>;
  query(name: string): string | undefined;
  query(name?: string): Record<string, string> | string | undefined {
    if (name !== undefined) return this.url.searchParams.get(name) ?? undefined;
    return Object.fromEntries(this.url.searchParams);
  }

  header(name: string): string | undefined {
    return this.request.headers.get(name) ?? undefined;
  }

  /** 本文は 1 回だけ読み、text と json で使い回す */
  text(): Promise<string> {
    this.raw ??= this.request.text();
    return this.raw;
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
}

export class Router<V> {
  private readonly routes: Route<V>[] = [];
  private readonly middlewares: Middleware<V>[] = [];
  private errorHandler: (err: unknown, c: Context<V>) => Response = () => new Response('internal error', { status: 500 });

  /** このあとに足す経路の前に動くミドルウェア（hono の use('*', ...) と同じ） */
  use(mw: Middleware<V>): this {
    this.middlewares.push(mw);
    return this;
  }

  onError(handler: (err: unknown, c: Context<V>) => Response): this {
    this.errorHandler = handler;
    return this;
  }

  get(path: string, handler: Handler<V>): this {
    return this.add('GET', path, handler);
  }

  post(path: string, handler: Handler<V>): this {
    return this.add('POST', path, handler);
  }

  patch(path: string, handler: Handler<V>): this {
    return this.add('PATCH', path, handler);
  }

  /** 別の Router の経路を prefix の下に載せる。その Router のミドルウェアはその経路にだけ効く */
  route(prefix: string, sub: Router<V>): this {
    for (const r of sub.routes) {
      const { pattern, names } = compile(escape(prefix) + r.pattern.source.replace(/^\^/, '').replace(/\$$/, ''), true);
      this.routes.push({ ...r, pattern, names: [...names, ...r.names], middlewares: [...this.middlewares, ...r.middlewares] });
    }
    return this;
  }

  private add(method: Method, path: string, handler: Handler<V>): this {
    const { pattern, names } = compile(path, false);
    this.routes.push({ method, pattern, names, handler, middlewares: [...this.middlewares] });
    return this;
  }

  async fetch(request: Request, ..._rest: unknown[]): Promise<Response> {
    const { pathname } = new URL(request.url);
    let matched: { route: Route<V>; params: Record<string, string> } | undefined;
    for (const route of this.routes) {
      if (route.method !== request.method) continue;
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1]!)));
      matched = { route, params };
      break;
    }
    if (!matched) return new Response('not found', { status: 404 });
    const c = new Context<V>(request, matched.params);
    try {
      return await run(c, matched.route.middlewares, matched.route.handler);
    } catch (err) {
      return this.errorHandler(err, c);
    }
  }

  /** テスト用: パスだけでリクエストを作って通す */
  request(path: string, init?: RequestInit): Promise<Response> {
    return this.fetch(new Request(new URL(path, 'http://localhost'), init));
  }
}

async function run<V>(c: Context<V>, middlewares: Middleware<V>[], handler: Handler<V>): Promise<Response> {
  let response: Response | undefined;
  const step = async (i: number): Promise<void> => {
    if (i === middlewares.length) {
      response = await handler(c);
      return;
    }
    const r = await middlewares[i]!(c, () => step(i + 1));
    if (r instanceof Response) response = r;
  };
  await step(0);
  if (!response) throw new Error('no response');
  return response;
}

/** "/threads/:id" → 正規表現と引数の名前。already が true なら path はもう正規表現の断片（route の合成） */
function compile(path: string, already: boolean): { pattern: RegExp; names: string[] } {
  if (already) return { pattern: new RegExp(`^${path}$`), names: [] };
  const names: string[] = [];
  const source = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return escape(seg);
    })
    .join('/');
  return { pattern: new RegExp(`^${source}$`), names };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

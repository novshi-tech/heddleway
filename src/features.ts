// Features: apps that run inside this Worker (the topic index, docs/adr/0005) instead of behind a
// Service Binding. The gateway core knows only this interface; the Worker's entry registers
// the features, and nothing else imports their code. A feature is off unless the
// deployment configures it, and each user turns it on for themselves (consent).
//
// What a feature gets from the gateway is decided by the entry: the gateway never hands it
// credentials or keys, only functions (see feature-port.ts).

export interface Feature {
  // Also the pseudo service name: the stand calls `/api/<name>/...` with a gateway token
  // that covers `identity:<name>`, and public routes live under `/<name>/...`.
  name: string;
  // Names the feature went by before (docs/adr/0009). Requests, tokens, consent and app ports that
  // still carry one reach the feature as if they named it: `/api/<old>/...` and `/<old>/...` are
  // served (webhooks registered upstream keep their URL until they are renewed), and
  // `/features/<old>/...` redirects to `/features/<name>/...`. Nothing new is issued under an old name.
  formerNames?: string[];
  displayName: string;
  // What turning the feature on lets it do, shown on the consent page.
  consentText: string;
  // Where the consent page sends the user back to, under `/<name>`.
  consentCallbackPath: string;
  // Pages for the signed-in user at `/features/<name>` and below (the topic index's 0048 and 0051), linked
  // from the home page. The gateway checks the session and passes the user's ID, the path under
  // the page's root ('' for the root itself) and the root (`/features/<name>`, for links); the
  // feature returns the page's title and body as HTML (escaping what it shows itself; it may use
  // the gateway's page classes such as list, row-*, badge, hint, empty, notice, tabs and
  // timeline), or null when there is no such page, and the gateway wraps it in its own layout.
  userPage?: {
    linkText: string;
    render(userId: string, page: { path: string; base: string }, ctx: ExecutionContext): Promise<{ title: string; body: string } | null>;
  };
  // Requests under `/api/<name>` arrive as `/api/...`, public ones under `/<name>` with the prefix removed.
  fetch(request: Request, ctx: ExecutionContext): Promise<Response>;
  scheduled?(controller: ScheduledController, ctx: ExecutionContext): Promise<void>;
  queue?(batch: MessageBatch<unknown>, ctx: ExecutionContext): Promise<void>;
}

type Factory = (env: Env) => Feature[];

let factory: Factory = () => [];

// Called once by the Worker's entry.
export function registerFeatures(f: Factory): void {
  factory = f;
}

export function features(env: Env): Feature[] {
  return factory(env);
}

// By its name or a former one.
export function feature(env: Env, name: string): Feature | undefined {
  return features(env).find((f) => namesOf(f).includes(name));
}

// The feature's name first, then its former names.
export function namesOf(f: Feature): string[] {
  return [f.name, ...(f.formerNames ?? [])];
}

// The service a name stands for now: a feature's former name becomes its name; anything else is itself.
export function currentName(env: Env, name: string): string {
  return feature(env, name)?.name ?? name;
}

// Rewrites the request's path, keeping method, headers and body.
export function withPath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}

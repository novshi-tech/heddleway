import { organizationName } from "../config";
import { features } from "../features";

// The gateway's pages as an installable app (docs/adr/0010). Pages stay server-rendered; a service
// worker shows the last copy of a feature's page at once and swaps in the fresh one when it arrives,
// so a page someone opens many times a day appears without waiting for the server. Only the
// signed-in user's own feature pages (`/features/<name>/...`) are kept; signing out clears them
// (Clear-Site-Data on /logout).

export const SW_PATH = "/sw.js";
export const MANIFEST_PATH = "/manifest.webmanifest";
export const PWA_JS_PATH = "/assets/pwa.js";
export const ICON_PATH = /^\/assets\/icon-(180|192|512)\.png$/;

// Bump when the worker's caching changes in a way old copies must not survive.
const CACHE = "pages-v1";

const SW_JS = `
const CACHE = ${JSON.stringify(CACHE)};
const PAGE = /^\\/features\\/[a-z0-9][a-z0-9-]*(?:\\/[A-Za-z0-9_\\/-]+)?$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

function keep(url) {
  return url.origin === self.location.origin && url.search === "" && PAGE.test(url.pathname) && !/\\/(consent|disable)$/.test(url.pathname);
}

function html(response) {
  return response.ok && !response.redirected && (response.headers.get("content-type") || "").startsWith("text/html");
}

// Fetch the page again and keep it. A redirect means the session is gone (the gateway sends the user to /login).
async function revalidate(url, client) {
  const response = await fetch(url, { credentials: "same-origin", redirect: "manual", cache: "no-store" });
  if (response.type === "opaqueredirect") {
    if (client) client.postMessage({ type: "signed-out" });
    return;
  }
  if (!html(response)) return;
  await (await caches.open(CACHE)).put(url, response);
  if (client) client.postMessage({ type: "updated", url });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") return;
  const url = new URL(request.url);
  url.hash = "";
  if (!keep(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(url.href);
    if (hit) {
      event.waitUntil((async () => {
        const client = event.resultingClientId ? await self.clients.get(event.resultingClientId) : null;
        await revalidate(url.href, client).catch(() => {});
      })());
      return hit;
    }
    const response = await fetch(request);
    if (html(response)) event.waitUntil(cache.put(url.href, response.clone()));
    return response;
  })());
});

// The page asks for a fresh copy when it comes back to the front.
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "refresh" || typeof data.url !== "string") return;
  const url = new URL(data.url);
  url.hash = "";
  if (!keep(url)) return;
  event.waitUntil(revalidate(url.href, event.source).catch(() => {}));
});
`;

const PWA_JS = `
// The top bar's menu closes when the user taps elsewhere.
document.addEventListener("click", (event) => {
  for (const menu of document.querySelectorAll("details.menu[open]")) if (!menu.contains(event.target)) menu.open = false;
});
if ("serviceWorker" in navigator) {
  const here = () => location.href.split("#")[0];
  // The first visit is not served by the worker yet: ask it to keep this page, so the next open is instant.
  const first = !navigator.serviceWorker.controller;
  navigator.serviceWorker.register(${JSON.stringify(SW_PATH)}, { scope: "/" }).catch(() => {});
  if (first) navigator.serviceWorker.ready.then((r) => r.active && r.active.postMessage({ type: "refresh", url: here() })).catch(() => {});
  navigator.serviceWorker.addEventListener("message", async (event) => {
    const data = event.data || {};
    const main = document.querySelector("main");
    if (!main) return;
    if (data.type === "updated" && data.url === here()) {
      const response = await caches.match(data.url);
      if (!response) return;
      const fresh = new DOMParser().parseFromString(await response.text(), "text/html");
      const body = fresh.querySelector("main");
      if (!body) return;
      main.replaceChildren(...body.childNodes);
      document.title = fresh.title;
    } else if (data.type === "signed-out" && !document.getElementById("signed-out")) {
      const note = document.createElement("p");
      note.id = "signed-out";
      note.className = "notice";
      note.setAttribute("role", "status");
      note.append("サインインが切れたため、前に開いたときの内容を表示しています。");
      const link = document.createElement("a");
      link.href = "/login?next=" + encodeURIComponent(location.pathname);
      link.textContent = "サインインし直す";
      note.append(" ", link);
      main.prepend(note);
    }
  });
  document.addEventListener("visibilitychange", () => {
    const worker = navigator.serviceWorker.controller;
    if (document.visibilityState === "visible" && worker) worker.postMessage({ type: "refresh", url: here() });
  });
}
`;

const ICONS: Record<string, string> = {
  "180": "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAABdUlEQVR42u3dUQ2AIBRAUXFEwSLYA7MZxCSWsYB/8PFg5wRgyO7eF5NUatvgz+4IEAfiQByIA3EgDsSBOBAH4gBxIA7EgTgQB+JAHIgDcSAOEAfiQByIA3EgDsSBOBAH4gBxIA7EgTgQB+JAHIgDcSAOxAHiQByIA3EgDmLJoXbzPnf/Isd52b/JgTgQB+JAHIgDcSAOEAfiQByIA3EgDsSBOBAH4gBxIA7EgTgQB+JAHIgDcSAOxAHiQByMkdf7pCE/ycDkQByIA3EgDsSBOBAH4kAciAPEgTgQB+JAHIgDcSAOVrbgHdLZ33gzORAH4kAciAPEgTgQB+JAHIgDcSAOxIE4EAeIA3EgDsSBOBAH4kAciANxgDgQB+JAHIgDcTCDVGpzCpgciANxIA7EgTgQB+JAHIgDxIE4EAfiQByIA3EgDsSBOEAciANxIA7EgTgQB+JAHIgDcYA4EAfiQByIA3EgDsSBOBAHiANxIA7EgTgI5APu6g4u3/O4jQAAAABJRU5ErkJggg==",
  "192": "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAABkElEQVR42u3dsQ2AIBBAUTGMgovAHjCbgziJy9haGkNBLu8NYIT8HBWaSu0b/LXbAgSEgBAQAgIBISAEhIBAQAgIASEgEBACQkAICASEgBAQAkJAICAEhIAQEAgIASEgBAQCQkAICAGBgBAQAkJACAgEhIAQEAICASEgBISAQEAICAERUF7wne7rnPWoow3LMYFwhCEgEBACQkAICASEgBAQAkJAICAEhIAQEAgIASEgBAQCQkAICAGBgBAQAkJACAgEhIAQEAKC73Ls5U38OhgmEAJCQAgIBISAEBACQkAgIASEgBAQCAgBISAEBAJCQAgIAcFb8FsZwf4bbwIhIBAQAkJACAgBgYAQEAJCQCAgBISAEBAICAEhIAQEAkJACAgBgYAQEAJCQAgIBISAEBACAgEhIJaWSu12ARMIASEgBAQCQkAICAGBgBAQAkJAICAEhIAQEAgIASEgBISAQEAICAEhIBAQAkJACAgEhIAQEAICASEgBISAEBAICAEhIAQEAkJACAgBgYAQEAIimgef4A5G5Qs/KwAAAABJRU5ErkJggg==",
  "512": "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAFyklEQVR42u3XDQ2AIBRGUXFEwSLSA7IRhCSUMYTo/DmngZ9sdy+kvSwA/M9qAgABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAAzokmeI7R29s/YcvVf/ROvBMXAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAgAAAIAAACAAAAgCAAADwEdEETDR6MwK4AAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAAZogmYKItVyNcbfRmBFwAAAgAAAIAgAAAIAAACAAAAgAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAMAdQtqLFQBcAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAIgAkABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAIATDrA7EMaaMNmZAAAAAElFTkSuQmCC",
};

export function swJs(): Response {
  // The browser checks for a new worker on navigation; no-cache keeps that check honest.
  return new Response(SW_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
}

export function pwaJs(): Response {
  return new Response(PWA_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });
}

export function icon(size: string): Response {
  const data = ICONS[size];
  if (!data) return new Response("not found", { status: 404 });
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
}

// Opens on the first feature page there is (the topic index's "now"), otherwise on the home page.
export function manifest(env: Env): Response {
  const first = features(env).find((f) => f.userPage);
  const body = {
    name: `Heddleway · ${organizationName(env)}`,
    short_name: "Heddleway",
    lang: "ja",
    start_url: first ? `/features/${first.name}` : "/",
    scope: "/",
    display: "standalone",
    background_color: "#e9edf0",
    theme_color: "#24425e",
    icons: [
      { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=300" } });
}

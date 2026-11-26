import { html, Html } from "./html";

// Quiet slate chrome: a list of connections, then one screen per step.
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #e9edf0;
  --panel: #f8fafb;
  --line: #cfd6dc;
  --ink: #1d2833;
  --muted: #5a6875;
  --action: #24425e;
  --action-ink: #ffffff;
  --alert: #a8232b;
  --alert-bg: #f9e3e4;
  --alert-ink: #ffffff;
  --focus: #2f7fd1;
  --ok: #1f5f3a;
  --ok-bg: #e2f1e7;
  --hover: #eef2f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161c22;
    --panel: #1f272f;
    --line: #34404b;
    --ink: #e4e9ee;
    --muted: #9aa8b5;
    --action: #9cc3e8;
    --action-ink: #0f1a24;
    --alert: #f08a8f;
    --alert-bg: #3a1f22;
    --alert-ink: #2a0e10;
    --focus: #7db7f0;
    --ok: #9bd6ae;
    --ok-bg: #1d3326;
    --hover: #26303a;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", Meiryo, system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.7;
}
main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
h1 { font-size: 1.75rem; line-height: 1.3; margin: 0 0 1rem; font-weight: 700; letter-spacing: .01em; }
h2 { font-size: 1.125rem; line-height: 1.4; margin: 2.75rem 0 1rem; font-weight: 700; }
p { margin: 0 0 1rem; max-width: 36em; }
a { color: var(--action); text-underline-offset: .2em; }
code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .85em; }
button {
  font: inherit;
  font-size: .9375rem;
  font-weight: 600;
  padding: .5rem 1.1rem;
  border-radius: .4rem;
  border: 1px solid var(--action);
  background: var(--action);
  color: var(--action-ink);
  cursor: pointer;
}
button.quiet { background: transparent; color: var(--action); }
button.danger { background: var(--alert); border-color: var(--alert); color: var(--alert-ink); }
button:hover { filter: brightness(1.1); }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
label { display: block; font-size: .875rem; color: var(--muted); margin: 0 0 .9rem; }
input[type=text], input[type=password], input[type=url] {
  display: block;
  width: 100%;
  margin-top: .3rem;
  font: inherit;
  color: var(--ink);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: .35rem;
  padding: .5rem .65rem;
}
form { margin: 0; }

[hidden] { display: none !important; }
.masthead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem 1rem; margin-bottom: 2rem; padding-bottom: .9rem; border-bottom: 1px solid var(--line); }
.masthead .home { font-weight: 700; color: var(--ink); text-decoration: none; }
.who { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; color: var(--muted); font-size: .875rem; }
.who button { padding: .3rem .8rem; font-size: .8125rem; }

a.button {
  display: inline-block;
  font-size: .9375rem;
  font-weight: 600;
  line-height: 1.7;
  padding: .5rem 1.1rem;
  border-radius: .4rem;
  border: 1px solid var(--action);
  background: var(--action);
  color: var(--action-ink);
  text-decoration: none;
  white-space: nowrap;
}
a.button.quiet { background: transparent; color: var(--action); }
.row-actions a.button, .row-actions button { padding: .3rem .8rem; font-size: .8125rem; }

.section-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem 1rem; margin-bottom: .75rem; }
.section-head h1 { margin: 0; }
.back { display: inline-block; margin-bottom: 1rem; font-size: .875rem; }

.list { list-style: none; margin: 0 0 1.5rem; padding: 0; background: var(--panel); border: 1px solid var(--line); border-radius: .6rem; }
.list > li { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; padding: .8rem 1rem; border-top: 1px solid var(--line); }
.list > li:first-child { border-top: 0; }
.row-main { display: block; flex: 1 1 14rem; min-width: 0; }
.row-title { display: block; margin: 0; font-weight: 700; line-height: 1.45; }
.row-sub { display: block; margin: 0; color: var(--muted); font-size: .875rem; overflow-wrap: anywhere; }
.row-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }

.choices > li { padding: 0; }
.choices a { display: flex; flex: 1; align-items: center; gap: 1rem; padding: .8rem 1rem; color: inherit; text-decoration: none; }
.choices a:hover { background: var(--hover); }
.choices > li:first-child a { border-radius: .6rem .6rem 0 0; }
.choices > li:last-child a { border-radius: 0 0 .6rem .6rem; }
.choices > li:only-child a { border-radius: .6rem; }
.chevron { color: var(--muted); font-size: 1.25rem; }
.group h2 { margin: 1.75rem 0 .6rem; font-size: 1rem; color: var(--muted); }
.filter { margin-bottom: 1.25rem; }
input[type=search] {
  display: block; width: 100%; margin-top: .3rem; font: inherit; color: var(--ink);
  background: var(--panel); border: 1px solid var(--line); border-radius: .35rem; padding: .5rem .65rem;
}

.badge { display: inline-block; padding: .1rem .55rem; border-radius: 999px; font-size: .75rem; font-weight: 600; background: var(--hover); color: var(--muted); white-space: nowrap; }
.badge.broken { background: var(--alert-bg); color: var(--alert); }
.notice { max-width: none; padding: .7rem 1rem; border-radius: .5rem; background: var(--ok-bg); color: var(--ok); font-weight: 600; }
.empty { max-width: none; padding: 1.25rem; border: 2px dashed var(--line); border-radius: .6rem; color: var(--muted); }
.hint { color: var(--muted); font-size: .875rem; }
.ports { width: 100%; border-collapse: collapse; margin: .5rem 0 1rem; font-size: .875rem; display: block; overflow-x: auto; }
.ports th, .ports td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
.ports code { overflow-wrap: anywhere; }
.examples { padding-left: 1.2rem; font-size: .875rem; }

fieldset { border: 1px solid var(--line); border-radius: .5rem; padding: .9rem 1rem .2rem; margin: 0 0 1.25rem; }
legend { padding: 0 .35rem; font-weight: 700; font-size: .9375rem; }
label.choice { display: flex; align-items: center; gap: .5rem; color: var(--ink); font-size: .9375rem; }
textarea {
  display: block; width: 100%; margin-top: .3rem; font: inherit; color: var(--ink);
  background: var(--panel); border: 1px solid var(--line); border-radius: .35rem; padding: .5rem .65rem;
}
.header-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 0 .75rem; }
.error { max-width: none; padding: .7rem 1rem; border-radius: .5rem; background: var(--alert-bg); color: var(--alert); font-weight: 600; }
a.button.danger-link { color: var(--alert); border-color: var(--alert); margin-left: auto; }
.who a { font-size: .875rem; }

.account { margin-top: 2.5rem; color: var(--muted); font-size: .8125rem; }
.account summary { cursor: pointer; width: max-content; }
.account p { margin: .4rem 0 0; overflow-wrap: anywhere; }

.card.start { margin-bottom: 2rem; }
.card.start p { max-width: none; }
.copy { display: flex; gap: .5rem; align-items: stretch; }
.copy input { flex: 1; min-width: 0; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .875rem; }
.copy button { margin-top: .3rem; padding: .3rem .8rem; font-size: .8125rem; }
.steps { margin: 0 0 1rem; padding-left: 1.25rem; }
.steps li { margin-bottom: .5rem; }
pre { margin: 0 0 1rem; padding: .7rem 1rem; overflow-x: auto; background: var(--bg); border: 1px solid var(--line); border-radius: .4rem; }
pre code { font-size: .8125rem; }
.version { font-weight: 400; color: var(--muted); font-size: .875rem; }
input[type=file] { display: block; margin-top: .4rem; font: inherit; color: var(--ink); }
.tabs { display: flex; gap: .25rem; margin: 0 0 1.5rem; border-bottom: 1px solid var(--line); }
.tab { padding: .45rem .9rem; margin-bottom: -1px; border: 1px solid transparent; border-radius: .4rem .4rem 0 0; color: var(--muted); font-weight: 600; font-size: .9375rem; text-decoration: none; }
.tab[aria-current=page] { color: var(--ink); background: var(--panel); border-color: var(--line); border-bottom-color: var(--panel); }
.count { display: inline-block; min-width: 1.6em; padding: 0 .45rem; border-radius: 999px; background: var(--hover); color: var(--muted); font-size: .75rem; line-height: 1.6; text-align: center; }
.badge.warn { background: var(--ok-bg); color: var(--ok); }
a.row-title { color: var(--ink); text-decoration: none; }
a.row-title:hover { text-decoration: underline; }

/* A dense list of items (the topic index's "now" page): one tappable row per item, title up to two lines, one line of meta. */
.now .tabs { margin-bottom: 1rem; }
.now-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: .25rem .75rem; margin-bottom: .5rem; }
.now-head h1 { font-size: 1.375rem; margin: 0; }
.now-sub { margin: 0; color: var(--muted); font-size: .8125rem; }
.sec-empty { margin: 0 0 .25rem; color: var(--muted); font-size: .8125rem; }
.items { list-style: none; margin: .25rem 0 0; padding: 0; background: var(--panel); border: 1px solid var(--line); border-radius: .5rem; overflow: hidden; }
.items > li + li { border-top: 1px solid var(--line); }
a.item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .1rem .5rem; padding: .45rem .75rem; color: inherit; text-decoration: none; }
a.item:hover { background: var(--hover); }
.item-title { font-size: .9375rem; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.item-tags { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: flex-start; gap: .25rem; }
.item-tags .badge { font-size: .6875rem; padding: 0 .45rem; line-height: 1.6; }
.item-meta { grid-column: 1 / -1; color: var(--muted); font-size: .75rem; line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.now .hint { margin-top: 1rem; font-size: .75rem; }
/* The first view of the "now" page (topic index 0052): fits one phone screen; each block opens its own page. */
.block { margin: 0 0 1rem; }
.block-head { display: flex; align-items: center; gap: .5rem; margin: 0 0 .35rem; }
.block-head h2 { margin: 0; font-size: 1rem; }
a.alert { display: block; margin: 0 0 1rem; padding: .55rem .75rem; border-radius: .5rem; background: var(--hover); color: var(--ink); font-size: .875rem; text-decoration: none; }
a.alert.broken { background: var(--alert-bg); color: var(--alert); }
a.more { display: block; padding: .45rem .75rem; font-size: .8125rem; text-align: right; }
a.item.group { align-items: center; }
a.item.group .item-title { font-weight: 600; }
a.item.group .item-tags { align-items: center; }
.now-more { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0 0 1rem; }
.now-more a { flex: 1 1 8rem; padding: .55rem .75rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--panel); color: var(--ink); font-size: .875rem; text-decoration: none; }
.now-more a b { margin-left: .2rem; }
.group-head { display: flex; align-items: center; gap: .5rem; margin: 1.25rem 0 .35rem; font-size: 1rem; }
.now-head .count { align-self: center; }
.topic h1 { font-size: 1.375rem; }
.topic .facts { font-size: .875rem; }
.topic .entry { padding: .55rem .8rem; }
.badges { display: flex; flex-wrap: wrap; gap: .35rem; }
.facts { list-style: none; margin: 0 0 1.25rem; padding: 0; color: var(--muted); font-size: .9375rem; }
.facts li { overflow-wrap: anywhere; }
.timeline { list-style: none; margin: 0 0 1.25rem; padding: 0; }
.entry { margin: 0 0 .75rem; padding: .7rem 1rem; background: var(--panel); border: 1px solid var(--line); border-radius: .6rem; }
.entry.outbound { border-left: 4px solid var(--action); }
.entry.note { border-style: dashed; }
.entry.op { background: transparent; border: 0; padding: .1rem 1rem; }
.entry-meta { margin: 0 0 .3rem; color: var(--muted); font-size: .8125rem; overflow-wrap: anywhere; max-width: none; }
.entry.op .entry-meta { margin: 0; }
.entry-subject { margin: 0 0 .3rem; font-weight: 700; max-width: none; }
.entry-body { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .9375rem; }
.entry-more > summary { cursor: pointer; color: var(--action); font-size: .875rem; margin-top: .3rem; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: .6rem; padding: 1.5rem; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; margin-top: 1.25rem; }

@media (max-width: 30rem) {
  main { padding-top: 1.5rem; }
}
`;

export function page(title: string, body: Html, headers?: HeadersInit, status = 200): Response {
  const document = html`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${new Html(STYLE)}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'");
  h.set("x-frame-options", "DENY");
  h.set("cache-control", "no-store");
  return new Response(document.value, { status, headers: h });
}

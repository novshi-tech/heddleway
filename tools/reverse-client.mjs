#!/usr/bin/env node
// A reference client for reverse connections (docs/adr/0003, docs/reverse-protocol.md): it pairs
// a local HTTP service with its owner's account at a gateway, then keeps a WebSocket open and
// relays the owner's calls to the service. Node 22 or later, no dependencies.
//
//   node tools/reverse-client.mjs pair <gateway URL> --name <name> --key <key file> [--description <text>]
//   node tools/reverse-client.mjs connect --key <key file> --target <http://127.0.0.1:PORT> [--describe <file>]
//
// The key file holds the private key (standard mode: ADR 0003 decision 4). It is written 0600;
// keep it away from agents. `connect` reconnects by itself after sleep, network changes and
// gateway deploys.
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const [command, ...args] = process.argv.slice(2);

function option(name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const json64 = (value) => b64url(Buffer.from(JSON.stringify(value)));

async function thumbprint(jwk) {
  // RFC 7638: the required members in lexicographic order.
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", Buffer.from(canonical))));
}

async function signJwt(privateJwk, claims) {
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, ["sign"]);
  const input = `${json64({ alg: "EdDSA", typ: "JWT" })}.${json64(claims)}`;
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, Buffer.from(input));
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "heddleway-reverse-client" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function pair() {
  const gateway = (args[0] ?? "").replace(/\/+$/, "");
  const name = option("name");
  const keyFile = option("key");
  if (!gateway.startsWith("http") || !name || !keyFile) fail("usage: pair <gateway URL> --name <name> --key <key file> [--description <text>]");
  if (existsSync(keyFile)) fail(`${keyFile} exists; pick another file, or delete it to pair again`);

  const pairKey = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pairKey.privateKey);
  const publicJwk = { kty: "OKP", crv: "Ed25519", x: privateJwk.x };
  const started = await postJson(`${gateway}/reverse/pair`, { name, public_key: publicJwk, description: option("description") });
  if (started.status !== 201) fail(`pairing was refused (${started.status}): ${started.body.error ?? ""}`);

  console.log(`Open ${started.body.verification_uri_complete}`);
  console.log(`and approve the code ${started.body.code} (it expires in ${started.body.expires_in / 60} minutes).`);
  console.log(`Key thumbprint: ${await thumbprint(publicJwk)}`);
  const deadline = Date.now() + started.body.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, started.body.interval * 1000));
    const polled = await postJson(`${gateway}/reverse/pair/status`, { pairing_id: started.body.pairing_id });
    if (polled.body.status === "pending") continue;
    if (polled.body.status !== "approved") fail(`pairing ${polled.body.status}`);
    writeFileSync(keyFile, JSON.stringify({ gateway, service_id: polled.body.service_id, name: polled.body.name, private_jwk: privateJwk }, null, 2), { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    console.log(`Paired as "${polled.body.name}". Saved the key to ${keyFile}.`);
    return;
  }
  fail("the code expired");
}

async function relay(target, frame) {
  const url = new URL(frame.path, target);
  const headers = new Headers();
  for (const [n, v] of frame.headers ?? []) {
    if (n.toLowerCase() !== "host") headers.append(n, v);
  }
  try {
    const res = await fetch(url, {
      method: frame.method,
      headers,
      body: frame.body ? Buffer.from(frame.body, "base64") : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(25_000),
    });
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: [...res.headers].filter(([n]) => n !== "content-encoding"), body: body.length ? body.toString("base64") : null };
  } catch (error) {
    return { status: 502, headers: [["content-type", "application/json"]], body: Buffer.from(JSON.stringify({ error: `the local service did not answer: ${error.message}` })).toString("base64") };
  }
}

async function connect() {
  const keyFile = option("key");
  const target = option("target");
  if (!keyFile || !target) fail("usage: connect --key <key file> --target <http://127.0.0.1:PORT> [--describe <file>]");
  const saved = JSON.parse(readFileSync(keyFile, "utf8"));
  const describe = option("describe");
  const description = describe ? readFileSync(describe, "utf8") : undefined;
  let delay = 1000;

  for (;;) {
    const opened = await new Promise(async (resolve) => {
      let open = false;
      try {
        const { body } = await postJson(`${saved.gateway}/reverse/challenge`, {});
        const now = Math.floor(Date.now() / 1000);
        const assertion = await signJwt(saved.private_jwk, {
          iss: saved.service_id,
          aud: `${saved.gateway}/reverse/connect`,
          nonce: body.challenge,
          iat: now,
          exp: now + 60,
        });
        const ws = new WebSocket(`${saved.gateway.replace(/^http/, "ws")}/reverse/connect`, { headers: { authorization: `Bearer ${assertion}` } });
        let ping;
        ws.onopen = () => {
          open = true;
          console.log(`connected as "${saved.name}"`);
          ws.send(JSON.stringify({ type: "hello", version: "reverse-client", ...(description ? { description } : {}) }));
          ping = setInterval(() => ws.send("ping"), 30_000);
        };
        ws.onmessage = async (event) => {
          if (event.data === "pong") return;
          const frame = JSON.parse(event.data);
          if (frame.type === "request") ws.send(JSON.stringify({ type: "response", id: frame.id, ...(await relay(target, frame)) }));
          else if (frame.type === "error") console.error(`gateway: ${frame.message}`);
        };
        ws.onclose = (event) => {
          clearInterval(ping);
          console.log(`disconnected (${event.code} ${event.reason})`);
          // Removed at the gateway: pairing again is the only way back.
          if (event.code === 4003) fail("the registration was removed; pair again");
          resolve(open);
        };
        ws.onerror = () => {};
      } catch (error) {
        console.error(`could not connect: ${error.message}`);
        resolve(false);
      }
    });
    delay = opened ? 1000 : Math.min(delay * 2, 60_000);
    await new Promise((r) => setTimeout(r, delay));
  }
}

if (command === "pair") await pair();
else if (command === "connect") await connect();
else fail("usage: reverse-client.mjs pair|connect ... (see the top of the file)");

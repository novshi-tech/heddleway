"""Shared helpers for scripts that call upstream APIs through the API gateway.

Every skill that calls the gateway carries its own copy next to its scripts,
so `import gwlib` finds it in the script's directory however Claude Code or
Cowork installs the plugin. The original is lib/plugin/gwlib.py in the
heddleway repository; `npm run plugin:sync` copies it into the skills.
"""
import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Cloudflare rejects Python's default User-Agent with error 1010.
USER_AGENT = "heddleway-client/1"
# Left as they are when percent-encoding a path or query; "%" is included so
# encoded input is not encoded twice.
URL_SAFE = "/%:@!$&'()*+,;=-._~"


def gateway_env():
    """Returns (base_url, token) from the environment set after issue_token."""
    token = os.environ.get("GW_TOKEN")
    base = os.environ.get("GW_BASE_URL", "").rstrip("/")
    if not token or not base:
        raise SystemExit("GW_TOKEN and GW_BASE_URL must be set (from the issue_token tool)")
    return base, token


def split_pair(value):
    if "=" not in value:
        raise SystemExit(f"expected key=value, got {value!r}")
    return tuple(value.split("=", 1))


def quote_path(path):
    path = path if path.startswith("/") else "/" + path
    return urllib.parse.quote(path, safe=URL_SAFE + "?")


def encode_query(pairs):
    # %20 rather than "+" for spaces, and "$" kept for OData parameters.
    return urllib.parse.urlencode(list(pairs), quote_via=urllib.parse.quote, safe="$")


def service_url(base, service, path, pairs=()):
    url = f"{base}/{service}{quote_path(path)}"
    query = encode_query(pairs)
    return url + (("&" if "?" in url else "?") + query if query else "")


def request_json(url, token, body=None, headers=None, retries=4):
    """Sends a request expecting JSON back, retrying on 429 and 503 (honoring
    Retry-After). GET by default; a body (JSON-serializable) makes it a POST.
    Returns (data, headers)."""
    request_headers = {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT, "Accept": "application/json"}
    data = None
    if body is not None:
        request_headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    request_headers.update(headers or {})
    for attempt in range(retries + 1):
        try:
            request = urllib.request.Request(url, data=data, headers=request_headers)
            with urllib.request.urlopen(request) as response:
                return json.load(response), response.headers
        except urllib.error.HTTPError as error:
            if error.code in (429, 503) and attempt < retries:
                retry_after = error.headers.get("Retry-After", "")
                time.sleep(int(retry_after) if retry_after.isdigit() else 2 ** attempt)
                continue
            body_text = error.read().decode(errors="replace")
            raise SystemExit(f"HTTP {error.code} for {url}: {body_text}")


def get_json(url, token, retries=4):
    """GETs JSON, retrying on 429 and 503 (honoring Retry-After). Returns (data, headers)."""
    return request_json(url, token, retries=retries)


def list_parser(doc, path_help, max_pages=100):
    """An argument parser with the options every *_all.py script shares."""
    parser = argparse.ArgumentParser(description=doc, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", help=path_help)
    parser.add_argument("-q", "--query", action="append", default=[], type=split_pair, help="query parameter key=value")
    parser.add_argument("--max-pages", type=int, default=max_pages)
    parser.add_argument("--csv", help="comma-separated fields to write as CSV instead of JSON; dots reach into nested objects")
    parser.add_argument("-o", "--out")
    return parser


def pick(item, field):
    value = item
    for key in field.split("."):
        value = value.get(key) if isinstance(value, dict) else None
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return "" if value is None else value


def write_items(items, out_path=None, csv_fields=None):
    """Writes items as a JSON array, or as CSV with the given fields, to a file or stdout."""
    out = open(out_path, "w", encoding="utf-8", newline="") if out_path else sys.stdout
    if csv_fields:
        fields = csv_fields.split(",")
        writer = csv.writer(out)
        writer.writerow(fields)
        for item in items:
            writer.writerow([pick(item, f) for f in fields])
    else:
        json.dump(items, out, ensure_ascii=False, indent=2)
        out.write("\n")
    if out_path:
        out.close()
        print(f"wrote {len(items)} items to {out_path}", file=sys.stderr)


def pace(started, min_interval):
    """Sleeps so that consecutive requests are at least min_interval seconds apart."""
    time.sleep(max(0.0, min_interval - (time.monotonic() - started)))

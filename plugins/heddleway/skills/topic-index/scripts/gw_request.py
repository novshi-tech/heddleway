#!/usr/bin/env python3
"""Sends one HTTP request to an upstream service through the API gateway.

Reads the gateway token and base URL from the environment, as returned by the
connector's `issue_token` tool:

    export GW_TOKEN=...            # "token"
    export GW_BASE_URL=...         # "base_url", e.g. https://gw.example.com/api

Examples:
    gw_request.py GET freee /api/1/companies
    gw_request.py POST freee /api/1/partners --json '{"company_id": 1, "name": "..."}'
    gw_request.py GET graph /v1.0/drives/ID/items/ID/content -o invoice.pdf
    gw_request.py POST freee /api/1/receipts -f company_id=1 --file receipt=invoice.pdf

Prints the status line to stderr and the body to stdout (JSON is
pretty-printed), or writes the body to --out. Exits non-zero on HTTP errors.
"""
import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gwlib import USER_AGENT, gateway_env, service_url, split_pair  # noqa: E402


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    """Follows redirects without sending the gateway token to another host
    (e.g. a signed download URL returned by the upstream)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urllib.parse.urlsplit(newurl).netloc != urllib.parse.urlsplit(req.full_url).netloc:
            new.remove_header("Authorization")
        return new


def multipart(fields, files):
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    for name, path in files:
        filename = os.path.basename(path)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            data = f.read()
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n".encode()
            + data
            + b"\r\n"
        )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("method")
    parser.add_argument("service")
    parser.add_argument("path", help="upstream path, e.g. /v1/projects")
    parser.add_argument("-q", "--query", action="append", default=[], help="query parameter key=value")
    parser.add_argument("-H", "--header", action="append", default=[], help="extra header Name=value")
    body = parser.add_mutually_exclusive_group()
    body.add_argument("--json", help="JSON body (string, or @file)")
    body.add_argument("--data", help="raw body from a file (use with -H Content-Type=...)")
    parser.add_argument("-f", "--form", action="append", default=[], help="multipart field key=value")
    parser.add_argument("--file", action="append", default=[], help="multipart file field=path")
    parser.add_argument("-o", "--out", help="write the response body to this file")
    parser.add_argument("--no-follow", action="store_true", help="do not follow redirects")
    args = parser.parse_args()

    base, token = gateway_env()
    url = service_url(base, args.service, args.path, [split_pair(q) for q in args.query])

    headers = {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT, "Accept": "application/json, */*"}
    data = None
    if args.json is not None:
        raw = open(args.json[1:], encoding="utf-8").read() if args.json.startswith("@") else args.json
        data = json.dumps(json.loads(raw), ensure_ascii=False).encode()
        headers["Content-Type"] = "application/json"
    elif args.data:
        with open(args.data, "rb") as f:
            data = f.read()
    elif args.form or args.file:
        data, headers["Content-Type"] = multipart(
            [split_pair(v) for v in args.form], [split_pair(v) for v in args.file]
        )
    for h in args.header:
        name, value = split_pair(h)
        headers[name] = value

    request = urllib.request.Request(url, data=data, method=args.method.upper(), headers=headers)
    opener = urllib.request.build_opener(NoRedirect if args.no_follow else SafeRedirect)
    try:
        response = opener.open(request)
        status, reason, resp_headers, payload = response.status, response.reason, response.headers, response.read()
        ok = True
    except urllib.error.HTTPError as error:
        status, reason, resp_headers, payload = error.code, error.reason, error.headers, error.read()
        ok = False

    print(f"HTTP {status} {reason}", file=sys.stderr)
    for name in ("X-Total-Count", "X-Page", "X-Per-Page", "Location", "Retry-After"):
        if resp_headers.get(name):
            print(f"{name}: {resp_headers[name]}", file=sys.stderr)

    if args.out:
        with open(args.out, "wb") as f:
            f.write(payload)
        print(f"wrote {len(payload)} bytes to {args.out}", file=sys.stderr)
    elif "json" in (resp_headers.get("Content-Type") or ""):
        try:
            print(json.dumps(json.loads(payload), ensure_ascii=False, indent=2))
        except ValueError:
            sys.stdout.buffer.write(payload)
    else:
        sys.stdout.buffer.write(payload)
    return 0 if ok or (args.no_follow and 300 <= status < 400) else 1


if __name__ == "__main__":
    sys.exit(main())

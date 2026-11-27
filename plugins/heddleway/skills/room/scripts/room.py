#!/usr/bin/env python3
"""Heddleway Room through the API gateway (service "room", credential identity:room).

    export GW_TOKEN=... GW_BASE_URL=...      # issue_token with identity:room

    room.py rooms                                  # list rooms
    room.py create "日次定例"                       # create a room
    room.py upload <room> photo.jpg clip.mp4       # put files beside the agenda
    room.py put-agenda <room> agenda.json          # start a new meeting with this agenda
    room.py meetings <room>                        # meetings, newest first
    room.py result <room> [meeting|latest] [-o result.json]
    room.py recordings <room> [meeting|latest] -d recordings/

`upload` prints a JSON manifest (name, path) so agenda HTML can reference
/r/<room>/files/<name>. `recordings` downloads every finished recording of the
meeting and writes recordings.json next to them (who, startedAt, file).
"""
import argparse
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gwlib import USER_AGENT, gateway_env, service_url  # noqa: E402

NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def call(method, path, body=None, headers=None, raw=False):
    base, token = gateway_env()
    h = {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
    data = None
    if isinstance(body, (bytes, bytearray)):
        data = bytes(body)
    elif body is not None:
        data = json.dumps(body, ensure_ascii=False).encode()
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    request = urllib.request.Request(service_url(base, "room", path), data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(request) as response:
            payload = response.read()
            return payload if raw else json.loads(payload or b"null")
    except urllib.error.HTTPError as error:
        raise SystemExit(f"HTTP {error.code} {method} {path}: {error.read().decode(errors='replace')[:500]}")


def out(data, path=None):
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if path:
        open(path, "w", encoding="utf-8").write(text)
        print(f"wrote {path}", file=sys.stderr)
    else:
        print(text)


def upload(room, files, prefix):
    manifest = []
    for path in files:
        name = prefix + re.sub(r"[^A-Za-z0-9._-]", "-", os.path.basename(path)).lstrip(".-_")
        if not NAME.match(name):
            raise SystemExit(f"cannot make a file name from {path!r}; rename it to letters, digits, . _ -")
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            data = f.read()
        r = call("PUT", f"/rooms/{room}/files/{name}", data, {"Content-Type": ctype})
        manifest.append({"source": path, **r["file"]})
        print(f"{name} {len(data)} bytes", file=sys.stderr)
    return manifest


def recordings(room, meeting, directory):
    result = call("GET", f"/rooms/{room}/meetings/{meeting}/result")
    os.makedirs(directory, exist_ok=True)
    listed = []
    for r in result.get("recordings", []):
        entry = {k: r[k] for k in ("recId", "user", "startedAt", "endedAt", "seconds", "state")}
        if r["state"] == "done":
            data = call("GET", r["path"].removeprefix("/api"), raw=True)
            file = os.path.join(directory, f"{r['recId']}.wav")
            open(file, "wb").write(data)
            entry["file"] = file
            print(f"{file} {r['user']['name']} {r['seconds']}s", file=sys.stderr)
        listed.append(entry)
    out({"meeting": result["meeting"], "recordings": listed}, os.path.join(directory, "recordings.json"))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("rooms")
    s = sub.add_parser("create"); s.add_argument("name")
    s = sub.add_parser("upload"); s.add_argument("room"); s.add_argument("files", nargs="+"); s.add_argument("--prefix", default="")
    s = sub.add_parser("put-agenda"); s.add_argument("room"); s.add_argument("agenda")
    s = sub.add_parser("meetings"); s.add_argument("room")
    s = sub.add_parser("result"); s.add_argument("room"); s.add_argument("meeting", nargs="?", default="latest"); s.add_argument("-o")
    s = sub.add_parser("recordings"); s.add_argument("room"); s.add_argument("meeting", nargs="?", default="latest"); s.add_argument("-d", default="recordings")
    a = p.parse_args()
    if a.cmd == "rooms":
        out(call("GET", "/rooms"))
    elif a.cmd == "create":
        out(call("POST", "/rooms", {"name": a.name}))
    elif a.cmd == "upload":
        out(upload(a.room, a.files, a.prefix))
    elif a.cmd == "put-agenda":
        agenda = json.load(open(a.agenda, encoding="utf-8"))
        out(call("PUT", f"/rooms/{a.room}/agenda", agenda))
    elif a.cmd == "meetings":
        out(call("GET", f"/rooms/{a.room}/meetings"))
    elif a.cmd == "result":
        out(call("GET", f"/rooms/{a.room}/meetings/{a.meeting}/result"), a.o)
    elif a.cmd == "recordings":
        recordings(a.room, a.meeting, a.d)


if __name__ == "__main__":
    main()

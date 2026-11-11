"""Tests the skill scripts against a local fake gateway.

Run: python3 -m unittest discover -s test/scripts
"""
import csv
import glob
import base64
from email import policy
from email.parser import BytesParser
import http.server
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# Every skill of every plugin, by skill name.
SKILLS = {os.path.basename(p): p for p in sorted(glob.glob(os.path.join(ROOT, "plugins", "*", "skills", "*")))}
GW_REQUEST = os.path.join(SKILLS["heddleway"], "scripts", "gw_request.py")
GRAPH_ALL = os.path.join(SKILLS["microsoft-graph"], "scripts", "graph_all.py")
FREEE_ALL = os.path.join(SKILLS["freee"], "scripts", "freee_all.py")
GMAIL_ALL = os.path.join(SKILLS["gmail"], "scripts", "gmail_all.py")
GMAIL_MIME = os.path.join(SKILLS["gmail"], "scripts", "gmail_mime.py")
DRIVE_ALL = os.path.join(SKILLS["google-drive"], "scripts", "drive_all.py")
CALENDAR_ALL = os.path.join(SKILLS["google-calendar"], "scripts", "calendar_all.py")
TASKS_ALL = os.path.join(SKILLS["google-tasks"], "scripts", "tasks_all.py")
DOCS_TEXT = os.path.join(SKILLS["google-docs"], "scripts", "docs_text.py")
BOARD_ALL = os.path.join(SKILLS["board"], "scripts", "board_all.py")
GW_GIT = os.path.join(SKILLS["git"], "scripts", "gw_git.py")

TOTAL_ITEMS = 250


GRAPH_PAGE = 100


def run(text, start, style=None):
    return {"startIndex": start, "endIndex": start + len(text), "textRun": {"content": text, "textStyle": style or {}}}


def para(start, *texts, style="NORMAL_TEXT", bullet=None):
    elements, i = [], start
    for t in texts:
        elements.append(run(t, i))
        i += len(t)
    p = {"elements": elements, "paragraphStyle": {"namedStyleType": style}}
    if bullet is not None:
        p["bullet"] = {"listId": "l1", "nestingLevel": bullet}
    return {"startIndex": start, "endIndex": i, "paragraph": p}


# A documents.get response with two tabs, one nested, covering headings,
# bullets, a table, and a person chip.
DOCUMENT = {
    "documentId": "doc-1",
    "title": "議事録",
    "revisionId": "rev-9",
    "tabs": [
        {
            "tabProperties": {"tabId": "t.0", "title": "本文"},
            "documentTab": {"body": {"content": [
                {"endIndex": 1, "sectionBreak": {}},
                para(1, "定例会\n", style="TITLE"),
                para(5, "決定事項\n", style="HEADING_2"),
                para(10, "見積を出す\n", bullet=0),
                para(16, "期限は来週\n", bullet=1),
                {"startIndex": 22, "endIndex": 40, "table": {"rows": 2, "columns": 2, "tableRows": [
                    {"tableCells": [{"content": [para(24, "担当\n")]}, {"content": [para(28, "内容\n")]}]},
                    {"tableCells": [{"content": [para(32, "A|B\n")]}, {"content": [{"startIndex": 37, "endIndex": 39, "paragraph": {"elements": [
                        {"startIndex": 37, "endIndex": 38, "person": {"personProperties": {"name": "山田", "email": "y@example.com"}}},
                        run("\n", 38)], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}}]}]},
                ]}},
                para(40, "以上\n"),
            ]}},
            "childTabs": [{
                "tabProperties": {"tabId": "t.1", "title": "メモ", "parentTabId": "t.0"},
                "documentTab": {"body": {"content": [{"endIndex": 1, "sectionBreak": {}}, para(1, "子タブ😀\n")]}},
            }],
        }
    ],
}


class FakeGateway(http.server.BaseHTTPRequestHandler):
    requests = []
    throttled = False

    def log_message(self, *args):
        pass

    def record(self, body=b""):
        FakeGateway.requests.append(
            {"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body}
        )

    def send(self, status, body, content_type="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.record()
        url = urllib.parse.urlsplit(self.path)
        query = dict(urllib.parse.parse_qsl(url.query))
        if url.path == "/api/board/v1/projects":
            page, per_page = int(query.get("page", 1)), int(query.get("per_page", 10))
            start = (page - 1) * per_page
            items = [{"id": i, "name": f"p{i}"} for i in range(start, min(start + per_page, TOTAL_ITEMS))]
            self.send(200, json.dumps(items).encode(), headers={"X-Total-Count": str(TOTAL_ITEMS)})
        elif url.path == "/api/graph/redirect":
            port = self.server.server_address[1]
            self.send(302, b"", headers={"Location": f"http://127.0.0.1:{port}/download/file.pdf"})
        elif url.path == "/download/file.pdf":
            self.send(200, bytes(range(256)), content_type="application/pdf")
        elif url.path == "/api/graph/v1.0/me/messages":
            if query.get("throttle") and not FakeGateway.throttled:
                FakeGateway.throttled = True
                self.send(429, b"{}", headers={"Retry-After": "0"})
                return
            start = int(query.get("$skiptoken", 0))
            body = {"value": [{"id": i, "from": {"address": f"u{i}@example.com"}} for i in range(start, min(start + GRAPH_PAGE, TOTAL_ITEMS))]}
            if start + GRAPH_PAGE < TOTAL_ITEMS:
                body["@odata.nextLink"] = (
                    f"https://graph.microsoft.com/v1.0/me/messages?%24select=id,from&%24skiptoken={start + GRAPH_PAGE}"
                )
            self.send(200, json.dumps(body).encode())
        elif url.path == "/api/graph/v1.0/me/elsewhere":
            self.send(200, json.dumps({"value": [], "@odata.nextLink": "https://evil.example.com/v1.0/x"}).encode())
        elif url.path in ("/api/gmail/gmail/v1/users/me/messages", "/api/drive/drive/v3/files", "/api/calendar/calendar/v3/calendars/primary/events", "/api/calendar/calendar/v3/users/me/calendarList", "/api/calendar/calendar/v3/calendars/primary/events/series1/instances", "/api/tasks/tasks/v1/users/@me/lists", "/api/tasks/tasks/v1/lists/L1/tasks"):
            if query.get("throttle") and not FakeGateway.throttled:
                FakeGateway.throttled = True
                self.send(429, b"{}", headers={"Retry-After": "0"})
                return
            key = "items" if "/api/calendar/" in url.path or "/api/tasks/" in url.path else ("messages" if "/api/gmail/" in url.path else "files")
            start = int(query.get("pageToken", 0))
            rows = [{"id": i, "name": f"file{i}", "threadId": f"thread{i}"} for i in range(start, min(start + 100, TOTAL_ITEMS))]
            if query.get("empty") and start == 100:
                rows = []
            body = {key: rows}
            if start + 100 < TOTAL_ITEMS:
                body["nextPageToken"] = str(start + 100)
            if query.get("loop"):
                body["nextPageToken"] = "100"
            if query.get("incomplete"):
                body["incompleteSearch"] = True
            # Model Google's partial-response field selection for the cursor.
            if "fields" in query and query["fields"] != "*" and "nextPageToken" not in query["fields"]:
                body.pop("nextPageToken", None)
            self.send(200, json.dumps(body).encode())
        elif url.path == "/api/docs/v1/documents/doc-1":
            self.send(200, json.dumps(DOCUMENT).encode())
        elif url.path == "/api/freee/api/1/deals":
            offset, limit = int(query.get("offset", 0)), int(query.get("limit", 20))
            deals = [{"id": i, "amount": i * 10} for i in range(offset, min(offset + limit, TOTAL_ITEMS))]
            self.send(200, json.dumps({"deals": deals, "meta": {"total_count": TOTAL_ITEMS}}).encode())
        elif url.path == "/api/freee/api/1/ambiguous":
            self.send(200, json.dumps({"a": [], "b": []}).encode())
        elif url.path == "/api/board/v1/forbidden":
            self.send(403, json.dumps({"message": "許可されていません。"}).encode())
        else:
            self.send(404, b"{}")

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.record(body)
        self.send(201, json.dumps({"ok": True}).encode())


class SkillScriptsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeGateway)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        port = cls.server.server_address[1]
        cls.env = {**os.environ, "GW_TOKEN": "tok", "GW_BASE_URL": f"http://127.0.0.1:{port}/api/"}

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeGateway.requests = []
        FakeGateway.throttled = False
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, *args, check=True):
        result = subprocess.run([sys.executable, *args], env=self.env, capture_output=True, cwd=self.tmp.name)
        if check and result.returncode != 0:
            self.fail(result.stderr.decode())
        return result

    def test_get_sends_token_user_agent_and_query(self):
        out = self.run_script(GW_REQUEST, "GET", "board", "/v1/projects", "-q", "per_page=2", "-q", "name_cont=保守")
        self.assertEqual(len(json.loads(out.stdout)), 2)
        req = FakeGateway.requests[0]
        self.assertEqual(req["headers"]["Authorization"], "Bearer tok")
        self.assertTrue(req["headers"]["User-Agent"].startswith("heddleway-client"))
        self.assertIn("name_cont=%E4%BF%9D%E5%AE%88", req["path"])
        self.assertIn("X-Total-Count: 250", out.stderr.decode())

    def test_json_body(self):
        self.run_script(GW_REQUEST, "POST", "board", "/v1/clients", "--json", '{"name": "株式会社テスト"}')
        req = FakeGateway.requests[0]
        self.assertEqual(req["headers"]["Content-Type"], "application/json")
        self.assertEqual(json.loads(req["body"]), {"name": "株式会社テスト"})

    def test_multipart_upload(self):
        path = os.path.join(self.tmp.name, "invoice.pdf")
        with open(path, "wb") as f:
            f.write(bytes(range(256)))
        self.run_script(GW_REQUEST, "POST", "freee", "/api/1/receipts", "-f", "company_id=1", "--file", f"receipt={path}")
        req = FakeGateway.requests[0]
        self.assertTrue(req["headers"]["Content-Type"].startswith("multipart/form-data; boundary="))
        self.assertIn(b'name="company_id"\r\n\r\n1\r\n', req["body"])
        self.assertIn(b'filename="invoice.pdf"\r\nContent-Type: application/pdf\r\n\r\n' + bytes(range(256)), req["body"])

    def test_download_follows_redirect_without_token_on_other_host(self):
        self.env_other_host = dict(self.env)
        # Same server under another host name, so the redirect crosses hosts.
        self.env["GW_BASE_URL"] = self.env["GW_BASE_URL"].replace("127.0.0.1", "localhost")
        try:
            self.run_script(GW_REQUEST, "GET", "graph", "/redirect", "-o", "out.pdf")
        finally:
            self.env = self.env_other_host
        with open(os.path.join(self.tmp.name, "out.pdf"), "rb") as f:
            self.assertEqual(f.read(), bytes(range(256)))
        first, second = FakeGateway.requests
        self.assertEqual(first["headers"]["Authorization"], "Bearer tok")
        self.assertNotIn("Authorization", second["headers"])

    def test_http_error_exits_non_zero(self):
        result = self.run_script(GW_REQUEST, "GET", "board", "/v1/forbidden", check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("HTTP 403", result.stderr.decode())

    def test_requires_token(self):
        env = {k: v for k, v in self.env.items() if k != "GW_TOKEN"}
        result = subprocess.run([sys.executable, GW_REQUEST, "GET", "board", "/v1"], env=env, capture_output=True)
        self.assertNotEqual(result.returncode, 0)

    def test_path_and_query_are_percent_encoded(self):
        self.run_script(
            GW_REQUEST, "GET", "graph", "/v1.0/me/drive/root:/請求書 2026:/children", "-q", "$filter=isRead eq false",
            check=False,
        )
        path = FakeGateway.requests[0]["path"]
        self.assertTrue(path.startswith("/api/graph/v1.0/me/drive/root:/%E8%AB%8B%E6%B1%82%E6%9B%B8%202026:/children?"))
        self.assertTrue(path.endswith("?$filter=isRead%20eq%20false"))

    def test_already_encoded_path_is_not_encoded_twice(self):
        self.run_script(GW_REQUEST, "GET", "graph", "/v1.0/me/drive/root:/a%20b:/children", check=False)
        self.assertEqual(FakeGateway.requests[0]["path"], "/api/graph/v1.0/me/drive/root:/a%20b:/children")

    def test_graph_all_follows_next_link_through_gateway(self):
        self.run_script(GRAPH_ALL, "/v1.0/me/messages", "-q", "$select=id,from", "-o", "all.json")
        with open(os.path.join(self.tmp.name, "all.json"), encoding="utf-8") as f:
            items = json.load(f)
        self.assertEqual([i["id"] for i in items], list(range(TOTAL_ITEMS)))
        self.assertEqual(len(FakeGateway.requests), 3)
        for req in FakeGateway.requests:
            self.assertTrue(req["path"].startswith("/api/graph/v1.0/me/messages?"))
            self.assertEqual(req["headers"]["Authorization"], "Bearer tok")
            self.assertTrue(req["headers"]["User-Agent"].startswith("heddleway-client"))
        self.assertIn("skiptoken=100", FakeGateway.requests[1]["path"])

    def test_graph_all_csv_with_nested_field(self):
        out = self.run_script(GRAPH_ALL, "/v1.0/me/messages", "--csv", "id,from.address")
        rows = list(csv.reader(io.StringIO(out.stdout.decode())))
        self.assertEqual(rows[:2], [["id", "from.address"], ["0", "u0@example.com"]])
        self.assertEqual(len(rows), TOTAL_ITEMS + 1)

    def test_graph_all_retries_after_429(self):
        self.run_script(GRAPH_ALL, "/v1.0/me/messages", "-q", "throttle=1", "--max-pages", "1", "-o", "one.json")
        self.assertEqual(len(FakeGateway.requests), 2)

    def test_graph_all_refuses_next_link_to_other_host(self):
        result = self.run_script(GRAPH_ALL, "/v1.0/me/elsewhere", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unexpected nextLink host", result.stderr.decode())
        self.assertEqual(len(FakeGateway.requests), 1)

    def test_freee_all_pages_with_offset_and_limit(self):
        self.run_script(FREEE_ALL, "/api/1/deals", "-q", "company_id=123", "-o", "deals.json")
        with open(os.path.join(self.tmp.name, "deals.json"), encoding="utf-8") as f:
            items = json.load(f)
        self.assertEqual([i["id"] for i in items], list(range(TOTAL_ITEMS)))
        offsets = [dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(r["path"]).query)) for r in FakeGateway.requests]
        self.assertEqual([o["offset"] for o in offsets], ["0", "100", "200"])
        self.assertTrue(all(o["company_id"] == "123" and o["limit"] == "100" for o in offsets))
        self.assertEqual(FakeGateway.requests[0]["headers"]["Authorization"], "Bearer tok")

    def test_freee_all_csv(self):
        out = self.run_script(FREEE_ALL, "/api/1/deals", "-q", "company_id=1", "--limit", "250", "--csv", "id,amount")
        rows = list(csv.reader(io.StringIO(out.stdout.decode())))
        self.assertEqual(rows[:2], [["id", "amount"], ["0", "0"]])
        self.assertEqual(len(rows), TOTAL_ITEMS + 1)
        self.assertEqual(len(FakeGateway.requests), 1)

    def test_freee_all_needs_key_when_ambiguous(self):
        result = self.run_script(FREEE_ALL, "/api/1/ambiguous", "-q", "company_id=1", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--key", result.stderr.decode())

    def test_board_all_fetches_every_page(self):
        self.run_script(BOARD_ALL, "/v1/projects", "-q", "order_status_in[]=4", "-o", "all.json")
        with open(os.path.join(self.tmp.name, "all.json"), encoding="utf-8") as f:
            items = json.load(f)
        self.assertEqual([i["id"] for i in items], list(range(TOTAL_ITEMS)))
        self.assertEqual(len(FakeGateway.requests), 3)
        self.assertTrue(all("order_status_in%5B%5D=4" in r["path"] for r in FakeGateway.requests))

    def test_gw_git_prints_the_repository_url_on_the_gateway(self):
        base = self.env["GW_BASE_URL"].rstrip("/")
        for repo in ("owner/repo", "/owner/repo.git"):
            out = self.run_script(GW_GIT, "--url", "github-git", repo)
            self.assertEqual(out.stdout.decode().strip(), f"{base}/github-git/owner/repo.git")

    def test_gw_git_sends_the_token_only_to_the_gateway_without_helpers_or_prompts(self):
        base = self.env["GW_BASE_URL"].rstrip("/")

        def urlmatch(key, url):
            return self.run_script(GW_GIT, "config", "--get-urlmatch", key, url, check=False).stdout.decode().strip()

        self.assertEqual(urlmatch("http.extraHeader", f"{base}/github-git/owner/repo.git"), "Authorization: Bearer tok")
        self.assertEqual(urlmatch("http.extraHeader", "https://github.com/owner/repo.git"), "")
        self.assertEqual(urlmatch("credential.helper", f"{base}/github-git/owner/repo.git"), "")
        sys.path.insert(0, os.path.dirname(GW_GIT))
        try:
            import gw_git
        finally:
            sys.path.pop(0)
        git_env = gw_git.git_env(base, "tok", {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.editor", "GIT_CONFIG_VALUE_0": "vi"})
        self.assertEqual(git_env["GIT_TERMINAL_PROMPT"], "0")
        self.assertEqual(git_env["GIT_CONFIG_COUNT"], "3")
        self.assertEqual(git_env["GIT_CONFIG_KEY_0"], "core.editor")

    def test_gw_git_requires_token(self):
        env = {k: v for k, v in self.env.items() if k != "GW_TOKEN"}
        result = subprocess.run([sys.executable, GW_GIT, "ls-remote", "x"], env=env, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"GW_TOKEN", result.stderr)

    def test_board_all_csv(self):
        out = self.run_script(BOARD_ALL, "/v1/projects", "--csv", "id,name")
        rows = list(csv.reader(io.StringIO(out.stdout.decode())))
        self.assertEqual(rows[0], ["id", "name"])
        self.assertEqual(rows[1], ["0", "p0"])
        self.assertEqual(len(rows), TOTAL_ITEMS + 1)

    def test_google_lists_keep_query_and_gateway_auth_across_pages(self):
        for script, path, key in ((GMAIL_ALL, "/gmail/v1/users/me/messages", "messages"), (DRIVE_ALL, "/drive/v3/files", "files"), (CALENDAR_ALL, "/calendar/v3/calendars/primary/events", "items")):
            with self.subTest(script=script):
                FakeGateway.requests = []
                out = self.run_script(script, path, "-q", "q=請求書", "-q", f"fields={key}(id)")
                self.assertEqual([row["id"] for row in json.loads(out.stdout)], list(range(TOTAL_ITEMS)))
                queries = [dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(r["path"]).query)) for r in FakeGateway.requests]
                self.assertEqual([q.get("pageToken") for q in queries], [None, "100", "200"])
                self.assertTrue(all(q["q"] == "請求書" and "nextPageToken" in q["fields"] for q in queries))
                self.assertTrue(all(r["headers"]["Authorization"] == "Bearer tok" for r in FakeGateway.requests))
                self.assertTrue(all(r["headers"]["User-Agent"].startswith("heddleway-client") for r in FakeGateway.requests))

    def test_google_lists_continue_after_empty_page(self):
        for script, path in ((DRIVE_ALL, "/drive/v3/files"), (CALENDAR_ALL, "/calendar/v3/calendars/primary/events")):
            with self.subTest(script=script):
                FakeGateway.requests = []
                out = self.run_script(script, path, "-q", "empty=1")
                self.assertEqual([r["id"] for r in json.loads(out.stdout)], list(range(100)) + list(range(200, 250)))
                self.assertEqual(len(FakeGateway.requests), 3)

    def test_calendar_lists_and_instances_use_items_array(self):
        for path in ("/calendar/v3/users/me/calendarList", "/calendar/v3/calendars/primary/events/series1/instances"):
            with self.subTest(path=path):
                out = self.run_script(CALENDAR_ALL, path, "--csv", "id", "--max-pages", "1")
                rows = list(csv.reader(io.StringIO(out.stdout.decode())))
                self.assertEqual(rows[:2], [["id"], ["0"]])
                self.assertEqual(len(rows), 101)
                self.assertIn("more items remain", out.stderr.decode())

    def test_tasks_lists_and_tasks_use_items_array(self):
        for path in ("/tasks/v1/users/@me/lists", "/tasks/v1/lists/L1/tasks"):
            with self.subTest(path=path):
                out = self.run_script(TASKS_ALL, path, "--csv", "id", "--max-pages", "1")
                rows = list(csv.reader(io.StringIO(out.stdout.decode())))
                self.assertEqual(rows[:2], [["id"], ["0"]])
                self.assertEqual(len(rows), 101)
                self.assertIn("more items remain", out.stderr.decode())

    def test_tasks_keep_filters_and_gateway_auth_on_every_page(self):
        params = {"showCompleted": "true", "showHidden": "true", "updatedMin": "2026-11-01T00:00:00Z", "maxResults": "100"}
        args = [arg for key, value in params.items() for arg in ("-q", f"{key}={value}")]
        out = self.run_script(TASKS_ALL, "/tasks/v1/lists/L1/tasks", *args, "-q", "fields=items(id,title)")
        self.assertEqual([row["id"] for row in json.loads(out.stdout)], list(range(TOTAL_ITEMS)))
        self.assertEqual(len(FakeGateway.requests), 3)
        for req in FakeGateway.requests:
            query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(req["path"]).query))
            self.assertEqual({key: query[key] for key in params}, params)
            self.assertIn("nextPageToken", query["fields"])
            self.assertEqual(req["headers"]["Authorization"], "Bearer tok")

    def test_calendar_preserves_period_and_timezone_on_every_page(self):
        params = {"timeMin": "2026-10-01T00:00:00+09:00", "timeMax": "2026-10-08T00:00:00+09:00", "timeZone": "Asia/Tokyo", "singleEvents": "true", "orderBy": "startTime"}
        args = [arg for key, value in params.items() for arg in ("-q", f"{key}={value}")]
        out = self.run_script(CALENDAR_ALL, "/calendar/v3/calendars/primary/events", *args)
        self.assertEqual(len(json.loads(out.stdout)), TOTAL_ITEMS)
        self.assertEqual(len(FakeGateway.requests), 3)
        for req in FakeGateway.requests:
            query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(req["path"]).query))
            self.assertEqual({key: query[key] for key in params}, params)

    def test_google_list_csv_and_partial_result_warnings(self):
        out = self.run_script(DRIVE_ALL, "/drive/v3/files", "--max-pages", "1", "--csv", "id,name", "-q", "incomplete=1")
        rows = list(csv.reader(io.StringIO(out.stdout.decode())))
        self.assertEqual(rows[:2], [["id", "name"], ["0", "file0"]])
        self.assertIn("incompleteSearch=true", out.stderr.decode())
        self.assertIn("more items remain", out.stderr.decode())

    def test_google_list_retries_and_stops_cursor_loop(self):
        self.run_script(GMAIL_ALL, "/gmail/v1/users/me/messages", "-q", "throttle=1", "--max-pages", "1")
        self.assertEqual(len(FakeGateway.requests), 2)
        FakeGateway.requests = []
        result = self.run_script(DRIVE_ALL, "/drive/v3/files", "-q", "loop=1", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("repeated nextPageToken", result.stderr.decode())
        self.assertEqual(len(FakeGateway.requests), 2)

    def test_google_list_rejects_invalid_page_limit_before_requests(self):
        result = self.run_script(GMAIL_ALL, "/gmail/v1/users/me/messages", "--max-pages", "0", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(FakeGateway.requests, [])

    def test_docs_text_renders_every_tab_as_markdown(self):
        out = self.run_script(DOCS_TEXT, "https://docs.google.com/document/d/doc-1/edit?tab=t.0").stdout.decode()
        self.assertEqual(
            out,
            "<!-- 議事録 documentId=doc-1 revisionId=rev-9 -->\n\n"
            "<!-- tab: 本文 tabId=t.0 -->\n\n"
            "# 定例会\n## 決定事項\n- 見積を出す\n  - 期限は来週\n"
            "| 担当 | 内容 |\n| --- | --- |\n| A\\|B | 山田 |\n以上\n\n"
            "<!-- tab: メモ tabId=t.1 -->\n\n子タブ😀\n",
        )
        self.assertIn("/api/docs/v1/documents/doc-1?includeTabsContent=true", FakeGateway.requests[0]["path"])

    def test_docs_text_lists_paragraphs_with_tab_and_table_positions(self):
        self.run_script(DOCS_TEXT, "doc-1", "--paragraphs", "-o", "p.json")
        with open(os.path.join(self.tmp.name, "p.json"), encoding="utf-8") as f:
            doc = json.load(f)
        self.assertEqual(doc["revisionId"], "rev-9")
        paragraphs = doc["paragraphs"]
        self.assertEqual([p["text"] for p in paragraphs], ["定例会\n", "決定事項\n", "見積を出す\n", "期限は来週\n", "担当\n", "内容\n", "A|B\n", "山田\n", "以上\n", "子タブ😀\n"])
        self.assertEqual(paragraphs[1], {"tabId": "t.0", "startIndex": 5, "endIndex": 10, "namedStyleType": "HEADING_2", "text": "決定事項\n"})
        self.assertEqual(paragraphs[3]["bullet"], {"listId": "l1", "nestingLevel": 1})
        self.assertEqual(paragraphs[7]["table"], {"startIndex": 22, "row": 1, "column": 1})
        self.assertEqual(paragraphs[9]["tabId"], "t.1")

    def test_gmail_mime_builds_unicode_reply_draft_with_attachment_locally(self):
        body_path = os.path.join(self.tmp.name, "body.txt")
        attachment = os.path.join(self.tmp.name, "請求書.pdf")
        with open(body_path, "w", encoding="utf-8") as f:
            f.write("請求書をお送りします。")
        with open(attachment, "wb") as f:
            f.write(bytes(range(256)))
        out = self.run_script(GMAIL_MIME, "build", "--from", "sender@example.com", "--to", "user@example.com", "--to", "other@example.com", "--subject", "Re: 請求書", "--body", "@" + body_path, "--attach", attachment, "--thread-id", "thread1", "--in-reply-to", "<original@example.com>", "--draft")
        data = json.loads(out.stdout)["message"]
        self.assertEqual(data["threadId"], "thread1")
        message = BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(data["raw"]))
        self.assertEqual(str(message["Subject"]), "Re: 請求書")
        self.assertEqual(str(message["References"]), "<original@example.com>")
        self.assertIn("other@example.com", str(message["To"]))
        self.assertEqual(message.get_body(preferencelist=("plain",)).get_content().strip(), "請求書をお送りします。")
        part = next(message.iter_attachments())
        self.assertEqual(part.get_filename(), "請求書.pdf")
        self.assertEqual(part.get_payload(decode=True), bytes(range(256)))
        self.assertEqual(FakeGateway.requests, [])

    def test_gmail_decode_restores_unpadded_binary_attachment(self):
        payload = bytes(range(256))
        path = os.path.join(self.tmp.name, "attachment.json")
        with open(path, "w") as f:
            json.dump({"data": base64.urlsafe_b64encode(payload).decode().rstrip("=")}, f)
        self.run_script(GMAIL_MIME, "decode", path, "-o", "attachment.pdf")
        with open(os.path.join(self.tmp.name, "attachment.pdf"), "rb") as f:
            self.assertEqual(f.read(), payload)

    def test_gmail_reply_requires_thread_and_rfc_message_id(self):
        result = self.run_script(GMAIL_MIME, "build", "--from", "a@example.com", "--to", "b@example.com", "--subject", "Reply", "--body", "body", "--thread-id", "thread", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--in-reply-to", result.stderr.decode())

    def test_scripts_run_from_a_skill_copied_on_its_own(self):
        # Claude Code installs each plugin in its own tree, and Cowork names skill
        # directories "<plugin>:<skill>": a skill must not reach outside its directory.
        scripts = [
            ("board", "board_all.py", ["/v1/projects", "--max-pages", "1"]),
            ("freee", "freee_all.py", ["/api/1/deals", "-q", "company_id=1", "--max-pages", "1"]),
            ("microsoft-graph", "graph_all.py", ["/v1.0/me/messages", "--max-pages", "1"]),
            ("gmail", "gmail_all.py", ["/gmail/v1/users/me/messages", "--max-pages", "1"]),
            ("google-drive", "drive_all.py", ["/drive/v3/files", "--max-pages", "1"]),
            ("google-calendar", "calendar_all.py", ["/calendar/v3/users/me/calendarList", "--max-pages", "1"]),
            ("google-tasks", "tasks_all.py", ["/tasks/v1/lists/L1/tasks", "--max-pages", "1"]),
            ("google-docs", "docs_text.py", ["doc-1"]),
        ]
        for skill, script, args in scripts:
            with self.subTest(script=script):
                alone = os.path.join(self.tmp.name, skill, f"heddleway-x:{skill}")
                shutil.copytree(SKILLS[skill], alone, ignore=shutil.ignore_patterns("__pycache__"))
                self.run_script(os.path.join(alone, "scripts", script), *args)
                self.run_script(os.path.join(alone, "scripts", "gw_request.py"), "GET", "board", "/v1/projects")


class SkillDocsTest(unittest.TestCase):
    def skill_docs(self):
        for skill in SKILLS.values():
            for root, _, files in os.walk(skill):
                for name in files:
                    if name.endswith(".md"):
                        yield os.path.join(root, name)

    def test_every_skill_has_a_name_and_description(self):
        for skill, path in SKILLS.items():
            with self.subTest(skill=skill), open(os.path.join(path, "SKILL.md"), encoding="utf-8") as f:
                head = f.read().split("---")[1]
                self.assertIn(f"\nname: {skill}\n", head)
                self.assertRegex(head, r"\ndescription: \S")

    def test_relative_links_point_at_files(self):
        for path in self.skill_docs():
            with open(path, encoding="utf-8") as f:
                text = f.read()
            for target in re.findall(r"\]\(([^)#]+)(?:#[^)]*)?\)", text):
                if "://" not in target:
                    with self.subTest(doc=os.path.relpath(path, ROOT), link=target):
                        self.assertTrue(os.path.exists(os.path.join(os.path.dirname(path), target)))


    def test_skills_use_their_own_copy_of_gw_request(self):
        for path in self.skill_docs():
            with open(path, encoding="utf-8") as f:
                text = f.read()
            with self.subTest(doc=os.path.relpath(path, ROOT)):
                self.assertNotIn("${CLAUDE_SKILL_DIR}/..", text.replace('"${CLAUDE_SKILL_DIR}"/..', "${CLAUDE_SKILL_DIR}/.."))
                if "GW=" in text:
                    self.assertIn('GW="${CLAUDE_SKILL_DIR}/scripts/gw_request.py"', text)

    def test_shared_scripts_are_in_sync_with_lib(self):
        result = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "sync-plugin-libs.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_marketplace_lists_every_plugin_at_its_version(self):
        with open(os.path.join(ROOT, ".claude-plugin", "marketplace.json"), encoding="utf-8") as f:
            entries = {e["name"]: e for e in json.load(f)["plugins"]}
        plugins = sorted(os.listdir(os.path.join(ROOT, "plugins")))
        self.assertEqual(sorted(entries), plugins)
        for name in plugins:
            with self.subTest(plugin=name), open(os.path.join(ROOT, "plugins", name, ".claude-plugin", "plugin.json"), encoding="utf-8") as f:
                manifest = json.load(f)
                self.assertEqual(manifest["name"], name)
                self.assertEqual(entries[name]["version"], manifest["version"])
                self.assertEqual(entries[name]["source"], {"source": "git-subdir", "url": "novshi-tech/heddleway", "path": f"plugins/{name}"})


if __name__ == "__main__":
    unittest.main()

"""Shared nextPageToken pagination for Google API list scripts."""
import sys

import gwlib


def main(service, keys, doc, default_key=None):
    parser = gwlib.list_parser(doc, "upstream list path; put query parameters in -q")
    parser.add_argument("--key", help="response array key (inferred from the last path component)")
    args = parser.parse_args()
    if args.max_pages < 1:
        parser.error("--max-pages must be positive")
    if "?" in args.path or "://" in args.path:
        parser.error("use an upstream path and put query parameters in -q")
    key = args.key or default_key or args.path.rstrip("/").rsplit("/", 1)[-1]
    if key not in keys:
        parser.error(f"unsupported list key: {key}; choose --key from {', '.join(keys)}")
    base, token = gwlib.gateway_env()
    query = list(args.query)
    # Partial responses must retain the cursor or a list silently ends early.
    query = [(k, ("nextPageToken," + v if k == "fields" and v != "*" else v)) for k, v in query]
    seen = {v for k, v in query if k == "pageToken"}
    items = []
    for page in range(1, args.max_pages + 1):
        data, _ = gwlib.get_json(gwlib.service_url(base, service, args.path, query), token)
        rows = data.get(key, [])
        if not isinstance(rows, list):
            raise SystemExit(f"expected an array in {key}")
        items.extend(rows)
        print(f"page {page}: {len(items)} items", file=sys.stderr)
        if data.get("incompleteSearch"):
            print("warning: incompleteSearch=true; narrow the search to a specific corpus/drive", file=sys.stderr)
        cursor = data.get("nextPageToken")
        if not cursor:
            break
        if cursor in seen:
            raise SystemExit("repeated nextPageToken; stopped to avoid a pagination loop")
        seen.add(cursor)
        query = [(k, v) for k, v in query if k != "pageToken"] + [("pageToken", cursor)]
        if page == args.max_pages:
            print(f"stopped at --max-pages {args.max_pages}; more items remain", file=sys.stderr)
    gwlib.write_items(items, args.out, args.csv)

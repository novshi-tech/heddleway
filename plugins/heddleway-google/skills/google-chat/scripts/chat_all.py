#!/usr/bin/env python3
"""Fetch Google Chat list pages through the API gateway.

chat_all.py /v1/spaces -q pageSize=1000 -q 'filter=spaceType = "SPACE"' -o spaces.json
chat_all.py /v1/spaces/{space}/messages -q pageSize=1000
    -q 'filter=createTime > "2026-11-01T00:00:00Z"' -o messages.json
chat_all.py /v1/spaces/{space}/members --key memberships -q pageSize=1000
Uses the spaces / messages / memberships array and nextPageToken; writes JSON or
CSV (--csv name,createTime,text). The members list returns "memberships", so
pass --key memberships for it.
"""

from google_paging import main

if __name__ == "__main__":
    main("chat", ("spaces", "messages", "memberships"), __doc__)

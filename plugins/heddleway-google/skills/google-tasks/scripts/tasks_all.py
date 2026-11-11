#!/usr/bin/env python3
"""Fetch Google Tasks list pages through the API gateway.

tasks_all.py /tasks/v1/users/@me/lists -o lists.json
tasks_all.py /tasks/v1/lists/{tasklist}/tasks -q maxResults=100
    -q showCompleted=true -q showHidden=true -o tasks.json
Uses the items array and nextPageToken. Supports task lists and tasks; writes
JSON or CSV (--csv id,title,status,due). maxResults is at most 100; the API
default for tasks is 20, so pass -q maxResults=100 to cut the number of calls.
"""

from google_paging import main

if __name__ == "__main__":
    main("tasks", ("items",), __doc__, default_key="items")

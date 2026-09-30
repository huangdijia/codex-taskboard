---
name: manage-taskboard
description: Manage boards and tasks in the installed TaskBoard plugin when the user names TaskBoard or clearly asks to use its local boards.
---

# Manage TaskBoard

Use the TaskBoard MCP tools for requests about this plugin's boards and tasks. Do not treat a generic request about GitHub, another tracker, or Codex chats as a TaskBoard request.

- Start with `list_boards` and `list_tasks` when the board or task is unclear. Use returned IDs; do not infer IDs from names.
- Before `update_task`, call `get_task` and pass its current `version` as `expected_version`. If a conflict occurs, read the task again and reconcile with the user's request before retrying.
- Show the resulting task ID, status, and version after a write. Report a failed write as failed rather than assuming it succeeded.
- Only mark a task `done` when the user asks to complete it or has accepted the result. Do not delete data; this plugin has no delete tool.
- The boards live on the machine running the MCP server. They are separate from Codex chats and other task trackers.

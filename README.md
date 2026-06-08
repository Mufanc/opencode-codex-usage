# @mufanc/opencode-codex-usage

OpenCode TUI plugin that shows Codex usage in the sidebar footer.

## Install

```json
{
  "plugin": [
    "@mufanc/opencode-codex-usage"
  ]
}
```

Then restart OpenCode.

## Notes

- Reads the OpenAI OAuth token from `~/.local/share/opencode/auth.json`.
- Fetches usage data from `https://chatgpt.com/backend-api/wham/usage`.

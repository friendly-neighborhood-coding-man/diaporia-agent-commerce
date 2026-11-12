#!/bin/bash
# isolated Haiku 5.5 call: stdin prompt -> stdout JSON (claude -p result)
HERE="$(cd "$(dirname "$0")" && pwd)"; CWD="${KCAT_CWD:-$(mktemp -d)}"; cd "$CWD"
exec env -u CLAUDE_COWORK_MEMORY_PATH_OVERRIDE -u CLAUDE_MEMORY_STORES -u CLAUDE_CODE_USER_EMAIL -u CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD -u CLAUDE_ADDITIONAL_DIRECTORIES -u CLAUDE_CODE_PROJECTS_SESSION -u GH_TOKEN -u GITHUB_TOKEN -u CLOUDSDK_AUTH_ACCESS_TOKEN \
  CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 MAX_THINKING_TOKENS=0 \
  claude -p --model claude-haiku-5-5 --output-format json --tools "" --strict-mcp-config --setting-sources "" \
  --exclude-dynamic-system-prompt-sections --system-prompt-file "$HERE/system.txt" "$@"

#!/bin/sh
# Deterministic secret scan for staged changes. Never prints matched values.
# Lifted from thinkfeet's proven pre-commit guard and generalized.
set -eu

if [ "${SKIP_SECRET_SCAN:-0}" = "1" ]; then
  echo "pre-commit: WARNING: secret scan bypassed via SKIP_SECRET_SCAN=1" >&2
  exit 0
fi

staged_files=$(git diff --cached --name-only || true)
if [ -z "$staged_files" ]; then
  exit 0
fi

status=0

env_paths=$(printf '%s\n' "$staged_files" \
  | grep -E '(^|/)\.env(\.|$)' \
  | grep -vE '(^|/)\.env\.example$' \
  | grep -vE '(^|/)\.env\.sample$' || true)

if [ -n "$env_paths" ]; then
  printf '%s\n' "$env_paths" | while IFS= read -r path; do
    echo "pre-commit: BLOCKED [env-file-staged] $path" >&2
  done
  status=1
fi

if ! git -c diff.noprefix=false -c diff.mnemonicPrefix=false \
  diff --cached -U0 --no-color --no-ext-diff \
  | awk '
    function report(name) {
      printf "pre-commit: BLOCKED [%s] %s:%d\n", name, file, line >> "/dev/stderr"
      found = 1
    }
    function dummy_value(text, name,    v) {
      v = text
      sub(".*" name "[[:space:]]*=[[:space:]]*", "", v)
      return v ~ /^["'\'']?(test|dummy|fake|example|placeholder|mock)[A-Za-z0-9_-]*["'\'']?[);,]*[[:space:]]*$/
    }
    BEGIN {
      found = 0; file = "(unknown)"; line = 0
      nvars = split("ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY AI_GATEWAY_API_KEY SUPABASE_SERVICE_ROLE_KEY SENTRY_AUTH_TOKEN AWS_SECRET_ACCESS_KEY STRIPE_SECRET_KEY GITHUB_TOKEN GH_TOKEN", vars, " ")
    }
    /^\+\+\+ / {
      file = $0
      sub(/^\+\+\+ b\//, "", file)
      if (file == "+++ /dev/null") file = "(deleted)"
      next
    }
    /^@@ / {
      split($3, parts, ",")
      line = substr(parts[1], 2) + 0
      next
    }
    /^\+/ {
      text = substr($0, 2)
      if (index(text, "secret-scan:allow") > 0) { line++; next }
      if (text ~ /sk-ant-[A-Za-z0-9_-]{10,}/)
        report("anthropic-key-shaped")
      if (text ~ /sk-[A-Za-z0-9]{20,}/)
        report("sk-key-shaped")
      if (text ~ /AKIA[0-9A-Z]{16}/)
        report("aws-access-key-id-shaped")
      if (text ~ /ghp_[A-Za-z0-9]{20,}/)
        report("github-pat-shaped")
      for (i = 1; i <= nvars; i++)
        if (text ~ vars[i] "[[:space:]]*=[[:space:]]*[^[:space:]]{8,}" && !dummy_value(text, vars[i]))
          report("env-assignment:" vars[i])
      line++
      next
    }
    END { exit found ? 1 : 0 }
  '; then
  status=1
fi

if [ "$status" -ne 0 ]; then
  echo "pre-commit: commit blocked — remove the secret from the staged changes." >&2
  echo "pre-commit: dummy fixture? annotate the line with: secret-scan:allow" >&2
fi

exit "$status"

#!/usr/bin/env bash
# Argus — SessionStart hook for Claude Code web sessions
# Installs Python dependencies and configures the environment so that
# pytest, flake8, mypy, and the argus package are available immediately.
set -euo pipefail

# -------------------------------------------------------------------
# Only run the heavy install path inside remote (web) containers.
# Local sessions already have the developer's venv.
# -------------------------------------------------------------------
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Use the system Python explicitly so deps are on the default PATH python.
PIP="python3 -m pip"

# ── 1. Install production dependencies ────────────────────────────
$PIP install --quiet --disable-pip-version-check \
  -r "$REPO_ROOT/requirements.txt"

# ── 2. Install dev / test tooling ─────────────────────────────────
$PIP install --quiet --disable-pip-version-check \
  pytest flake8 mypy httpx

# ── 3. Export PYTHONPATH so `import argus` resolves ───────────────
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "PYTHONPATH=$REPO_ROOT" >> "$CLAUDE_ENV_FILE"
fi

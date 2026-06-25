#!/usr/bin/env bash
set -euo pipefail

MODE="dry-run"
SKIP_TESTS=0
REMOTE="origin"
BRANCH=""
MESSAGE=""

usage() {
  cat <<'EOF'
Usage:
  scripts/release.sh [--dry-run]
  scripts/release.sh --publish [--skip-tests] [--remote origin] [--branch main] [--message "Release ..."]

What it does:
  --dry-run   Run checks, build, and npm pack --dry-run only. This is the default.
  --publish   Run checks, commit current changes if any, create a tag, push branch + tag, then npm publish.

Version source:
  packages/bizagent/package.json

Tag format:
  bizagent-v<version>

Notes:
  - The script does not bump versions. Edit packages/bizagent/package.json first.
  - npm publish requires `npm adduser` / a valid npm token before running.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      MODE="dry-run"
      shift
      ;;
    --publish)
      MODE="publish"
      shift
      ;;
    --skip-tests)
      SKIP_TESTS=1
      shift
      ;;
    --remote)
      REMOTE="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --message|-m)
      MESSAGE="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
PKG_DIR="$ROOT/packages/bizagent"
cd "$ROOT"

VERSION="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("packages/bizagent/package.json","utf8")).version)')"
TAG="bizagent-v$VERSION"
CURRENT_BRANCH="$(git branch --show-current)"
BRANCH="${BRANCH:-$CURRENT_BRANCH}"
MESSAGE="${MESSAGE:-Release bizagent v$VERSION}"

if [[ -z "$CURRENT_BRANCH" ]]; then
  echo "Not on a branch; refusing to release from detached HEAD." >&2
  exit 1
fi

if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  echo "Current branch is '$CURRENT_BRANCH', expected '$BRANCH'." >&2
  exit 1
fi

echo "bizagent version: $VERSION"
echo "git branch:       $CURRENT_BRANCH"
echo "git remote:       $REMOTE"
echo "git tag:          $TAG"
echo "mode:             $MODE"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag already exists locally: $TAG" >&2
  exit 1
fi

if git ls-remote --exit-code --tags "$REMOTE" "$TAG" >/dev/null 2>&1; then
  echo "Tag already exists on $REMOTE: $TAG" >&2
  exit 1
fi

export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$ROOT/.npm-cache}"

echo
echo "==> Build"
npm --prefix "$PKG_DIR" run build

echo
echo "==> Typecheck"
npm --prefix "$PKG_DIR" run typecheck

if [[ "$SKIP_TESTS" == "0" ]]; then
  echo
  echo "==> Test"
  npm --prefix "$PKG_DIR" test
else
  echo
  echo "==> Test skipped"
fi

echo
echo "==> Pack dry-run"
(cd "$PKG_DIR" && npm pack --dry-run)

if [[ "$MODE" == "dry-run" ]]; then
  echo
  echo "Dry run complete. To publish:"
  echo "  scripts/release.sh --publish"
  exit 0
fi

echo
echo "==> npm auth"
npm whoami >/dev/null

echo
echo "==> Commit"
git add -A
if git diff --cached --quiet; then
  echo "No staged changes; tagging current HEAD."
else
  git commit -m "$MESSAGE"
fi

echo
echo "==> Tag"
git tag "$TAG"

echo
echo "==> Push git"
git push "$REMOTE" "$CURRENT_BRANCH"
git push "$REMOTE" "$TAG"

echo
echo "==> Publish npm"
(cd "$PKG_DIR" && npm publish --access public)

echo
echo "Published bizagent@$VERSION and pushed $TAG."

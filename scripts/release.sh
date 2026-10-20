#!/usr/bin/env bash
set -euo pipefail

MODE="dry-run"
SKIP_TESTS=0
REMOTE="origin"
BRANCH="main"

usage() {
  cat <<'EOF'
Usage:
  scripts/release.sh [--dry-run]
  scripts/release.sh --publish [--skip-tests] [--remote origin] [--branch main]

What it does:
  --dry-run   Check, build, test, and npm pack --dry-run. This is the default.
  --publish   Same checks, then tag the current commit, push the tag, and npm publish.

Rules:
  - Releases packages/dsh (@bizagent/dsh-plugin). The version comes from its package.json;
    bump it and update CHANGELOG.md in a normal reviewed commit first.
  - The working tree must be clean and HEAD must match <remote>/<branch>.
    This script never stages or commits files.
  - Tag format: v<version>. Prerelease versions publish under the "next" dist-tag.
  - npm publish requires a logged-in npm account with access to the @bizagent scope.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --publish) MODE="publish"; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
PKG_DIR="$ROOT/packages/dsh"
cd "$ROOT"

NAME="$(node -p 'require("./packages/dsh/package.json").name')"
VERSION="$(node -p 'require("./packages/dsh/package.json").version')"
TAG="v$VERSION"
if [[ "$VERSION" == *-* ]]; then DIST_TAG="next"; else DIST_TAG="latest"; fi

echo "package:  $NAME@$VERSION"
echo "git tag:  $TAG"
echo "npm tag:  $DIST_TAG"
echo "mode:     $MODE"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean; commit or stash changes first." >&2
  exit 1
fi

if [[ "$(git branch --show-current)" != "$BRANCH" ]]; then
  echo "Not on branch '$BRANCH'." >&2
  exit 1
fi

git fetch --quiet "$REMOTE" "$BRANCH"
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse "$REMOTE/$BRANCH")" ]]; then
  echo "HEAD does not match $REMOTE/$BRANCH; push or pull first." >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null \
  || git ls-remote --exit-code --tags "$REMOTE" "$TAG" >/dev/null 2>&1; then
  echo "Tag already exists: $TAG" >&2
  exit 1
fi

if ! grep -Eq "^## \[?$VERSION\]?" "$PKG_DIR/CHANGELOG.md"; then
  echo "packages/dsh/CHANGELOG.md has no section for $VERSION." >&2
  exit 1
fi

echo
echo "==> Install"
npm --prefix "$PKG_DIR" ci

echo
echo "==> Documentation"
node scripts/check-docs.mjs
git diff --check

echo
echo "==> Typecheck"
npm --prefix "$PKG_DIR" run typecheck

if [[ "$SKIP_TESTS" == "0" ]]; then
  echo
  echo "==> Test"
  npm --prefix "$PKG_DIR" test
else
  echo
  echo "==> Build (tests skipped)"
  npm --prefix "$PKG_DIR" run build
fi

echo
echo "==> Tool reference"
(cd "$PKG_DIR" && node scripts/tools-reference.mjs --check)

echo
echo "==> Pack dry-run"
(cd "$PKG_DIR" && npm pack --dry-run)

if [[ "$MODE" == "dry-run" ]]; then
  echo
  echo "Dry run complete. To publish: scripts/release.sh --publish"
  exit 0
fi

echo
echo "==> npm auth"
npm whoami >/dev/null

echo
echo "==> Tag and push"
git tag -a "$TAG" -m "$NAME $VERSION"
git push "$REMOTE" "$TAG"

echo
echo "==> Publish"
(cd "$PKG_DIR" && npm publish --access public --tag "$DIST_TAG")

echo
echo "Published $NAME@$VERSION ($DIST_TAG) and pushed $TAG."

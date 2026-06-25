#!/usr/bin/env bash
# Build a throwaway sandbox root you can poke at by hand.
#   run:  npm run sandbox        (from packages/bizagent)
# Then:   cd examples/sandbox/lines/commerce/businesses/webstore && biz   # bare biz launches the agent
# The sandbox/ dir is gitignored; delete it anytime.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(dirname "$HERE")"
SANDBOX="$HERE/sandbox"
BIZ() { npx --prefix "$PKG" tsx "$PKG/src/cli.ts" "$@"; }

rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"

echo "### 1) init root"
BIZ init "$SANDBOX"

cd "$SANDBOX"
echo; echo "### 2) two businesses on the 'commerce' line"
BIZ new webstore --line commerce --name "Webstore"
BIZ new marketplace --line commerce

echo; echo "### 3) write business memory"
BIZ mem add webstore "GMV excludes cancelled orders" --confidence 0.9
BIZ mem add webstore "Push CTR uses deduped users" --session 4081

echo; echo "### 3b) link a module, seed knowledge + a task (so the web demo has content to show)"
BIZ module new pricing --line commerce --type strategy --source "git clone git@github.com:acme/pricing.git" --deploy "ships via the standard CI pipeline"
BIZ link webstore pricing
mkdir -p lines/commerce/businesses/webstore/knowledge/business lines/commerce/knowledge
cat > lines/commerce/businesses/webstore/knowledge/business/gmv.md <<'KDOC'
---
description: GMV caliber and the daily pipeline — read before any GMV question
---
# GMV
GMV excludes cancelled and refunded orders. The daily table is `commerce.webstore_gmv_daily`, refreshed 06:00 (+08:00).
KDOC
cat > lines/commerce/knowledge/commerce-glossary.md <<'KDOC'
---
description: Shared commerce-line vocabulary (GMV, cohort, holdout)
---
# Commerce glossary
- **GMV**: gross merchandise value, the standard revenue caliber.
- **holdout**: a randomized control group excluded from a campaign to measure its incremental effect.
KDOC
mkdir -p lines/commerce/businesses/webstore/requirements/q3-uplift
cat > lines/commerce/businesses/webstore/requirements/q3-uplift/requirement.md <<'RDOC'
---
status: active
---
# Q3 uplift analysis
## Goal
Quantify the incremental GMV from the Q3 promo campaign vs a holdout control.
## State
- [ ] pull campaign + control cohorts
- [ ] compute uplift on the standard GMV caliber
RDOC

echo; echo "### 4) simulate a task worklog, then promote (the Stop hook)"
mkdir -p lines/commerce/businesses/webstore/.bizagent/deliverables/20260605-120000-demo0001
cat > lines/commerce/businesses/webstore/.bizagent/deliverables/20260605-120000-demo0001/worklog.md <<'EOF'
---
description: demo worklog with conclusions
---

# Worklog
## Steps
- queried GMV by day
## Conclusions
- GMV caliber must exclude refunded orders
- Push ROI turns negative after the 3rd wave
EOF
echo '{}' | npx tsx "$PKG/src/cli.ts" hook promote --business lines/commerce/businesses/webstore

echo; echo "### 5) try the write guard (PreToolUse) — malformed memory is blocked"
echo "--- valid (exit 0):"
printf '%s' '{"tool_name":"Write","tool_input":{"file_path":"memory/ok.md","content":"---\nscope: business\ndescription: fine summary\n---\n\nfine"}}' \
  | npx tsx "$PKG/src/cli.ts" hook guard --business lines/commerce/businesses/webstore; echo "    exit=$?"
echo "--- missing scope (deny JSON, exit 0):"
set +e
printf '%s' '{"tool_name":"Write","tool_input":{"file_path":"memory/bad.md","content":"---\nconfidence: 0.5\n---\n\nno scope"}}' \
  | npx tsx "$PKG/src/cli.ts" hook guard --business lines/commerce/businesses/webstore; echo "    exit=$?"
set -e

echo; echo "### result: injected context preview"
echo "------------------------------------------------------------"
BIZ context webstore
echo "------------------------------------------------------------"
echo; echo "sandbox ready at: $SANDBOX"
echo "launch :  cd '$SANDBOX/lines/commerce/businesses/webstore' && biz       (bare biz launches the agent)"
echo "memory :  biz mem list webstore                          (run from inside the sandbox)"

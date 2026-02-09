#!/usr/bin/env bash
# full-test.sh — Run all test categories: type-check, unit, E2E, fuzz, coverage, mutation
set -uo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
RESET='\033[0m'

passed=0
failed=0
results=()

run_step() {
  local label="$1"
  shift
  printf "\n${BOLD}${CYAN}━━━ %s ━━━${RESET}\n" "$label"
  if "$@" 2>&1; then
    results+=("${GREEN}PASS${RESET}  $label")
    ((passed++)) || true
  else
    results+=("${RED}FAIL${RESET}  $label")
    ((failed++)) || true
  fi
}

# ── Type Check ──────────────────────────────────────────────────────────────
run_step "Type Check (tsc --noEmit)" npx tsc --noEmit

# ── Unit Tests ──────────────────────────────────────────────────────────────
run_step "Unit Tests" npx vitest run --exclude 'src/e2e/**' --exclude 'src/fuzz/**'

# ── E2E Integration Tests ──────────────────────────────────────────────────
run_step "E2E Integration Tests" npx vitest run src/e2e/

# ── Property-Based Fuzz Tests ──────────────────────────────────────────────
run_step "Property-Based Fuzz Tests" npx vitest run src/fuzz/

# ── Coverage Report ─────────────────────────────────────────────────────────
run_step "Coverage (all tests)" npx vitest run --coverage

# ── Mutation Testing ────────────────────────────────────────────────────────
run_step "Mutation Testing (StrykerJS)" npx stryker run

# ── Summary ─────────────────────────────────────────────────────────────────
printf "\n${BOLD}${CYAN}━━━ Summary ━━━${RESET}\n"
for r in "${results[@]}"; do
  printf "  %b\n" "$r"
done

total=$((passed + failed))
printf "\n${BOLD}%d/%d passed${RESET}" "$passed" "$total"
if [ "$failed" -gt 0 ]; then
  printf " ${RED}(%d failed)${RESET}\n" "$failed"
  exit 1
else
  printf " ${GREEN}(all passed)${RESET}\n"
  exit 0
fi

#!/usr/bin/env bash
# test.sh — GreedySearch test suite
#
# Usage:
#   ./test.sh           # run all tests
#   ./test.sh parallel  # run only parallel test
#   ./test.sh quick     # skip slow tests (parallel + stress)
#
# Tests verify:
#   - No crashes/errors from extractors
#   - All engines complete in "all" mode
#   - Correct queries in results (not mixed up)
#   - Parallel searches don't race on shared tabs

set -e

cd "$(dirname "$0")"
RESULTS_DIR="results/test_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RESULTS_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); echo -e "  ${GREEN}✓${NC} $1"; }
fail() { FAIL=$((FAIL+1)); echo -e "  ${RED}✗${NC} $1"; }

check_no_errors() {
  local file="$1"
  local errors=$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$file','utf8'));
    const errs = [];
    if (d.perplexity?.error) errs.push('perplexity: ' + d.perplexity.error);
    if (d.bing?.error) errs.push('bing: ' + d.bing.error);
    if (d.google?.error) errs.push('google: ' + d.google.error);
    console.log(errs.join('; ') || '');
  " 2>/dev/null)
  echo "$errors"
}

check_correct_queries() {
  local file="$1"
  local expected="$2"
  local result=$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$file','utf8'));
    const queries = [d.perplexity?.query, d.bing?.query, d.google?.query].filter(Boolean);
    const allMatch = queries.every(q => q === '$expected');
    console.log(allMatch ? 'ok' : 'queries: ' + queries.join(', '));
  " 2>/dev/null)
  echo "$result"
}

check_all_engines_completed() {
  local file="$1"
  local result=$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$file','utf8'));
    const hasAnswer = (e) => d[e]?.answer && d[e].answer.length > 10;
    const engines = ['perplexity', 'bing', 'google'];
    const ok = engines.every(hasAnswer);
    console.log(ok ? 'ok' : 'missing: ' + engines.filter(e => !hasAnswer(e)).join(', '));
  " 2>/dev/null)
  echo "$result"
}

# ─────────────────────────────────────────────────────────
echo -e "\n${YELLOW}═══ GreedySearch Test Suite ═══${NC}\n"

# ── Test 1: Single engine mode ──────────────────────────
if [[ "$1" != "parallel" ]]; then
  echo "Test 1: Single engine mode"
  
  for engine in perplexity bing google; do
    outfile="$RESULTS_DIR/single_${engine}.json"
    node search.mjs "$engine" "explain $engine attention mechanism" --out "$outfile" 2>/dev/null
    if [[ $? -eq 0 && -f "$outfile" ]]; then
      errors=$(check_no_errors "$outfile")
      if [[ -z "$errors" ]]; then
        pass "$engine completed without errors"
      else
        fail "$engine errors: $errors"
      fi
    else
      fail "$engine failed to run"
    fi
  done
fi

# ── Test 2: Sequential "all" mode ───────────────────────
if [[ "$1" != "parallel" ]]; then
  echo -e "\nTest 2: Sequential 'all' mode (3 runs)"
  
  for i in 1 2 3; do
    outfile="$RESULTS_DIR/seq_${i}.json"
    query="LLM inference optimization techniques $i"
    node search.mjs all "$query" --out "$outfile" 2>/dev/null
    
    if [[ $? -eq 0 && -f "$outfile" ]]; then
      errors=$(check_no_errors "$outfile")
      if [[ -z "$errors" ]]; then
        pass "Run $i: no errors"
      else
        fail "Run $i errors: $errors"
      fi
      
      correct=$(check_correct_queries "$outfile" "$query")
      if [[ "$correct" == "ok" ]]; then
        pass "Run $i: correct queries"
      else
        fail "Run $i: $correct"
      fi
    else
      fail "Run $i: failed to run"
    fi
  done
fi

# ── Test 3: Parallel "all" mode (race condition test) ───
if [[ "$1" != "quick" && "$1" != "sequential" ]]; then
  echo -e "\nTest 3: Parallel 'all' mode (5 concurrent searches)"
  
  PARALLEL_QUERIES=(
    "what are transformer architectures in LLMs"
    "explain RLHF fine-tuning process"
    "difference between GPT and BERT models"
    "how does chain of thought prompting work"
    "what is retrieval augmented generation"
  )
  
  PIDS=()
  for i in "${!PARALLEL_QUERIES[@]}"; do
    outfile="$RESULTS_DIR/parallel_${i}.json"
    query="${PARALLEL_QUERIES[$i]}"
    node search.mjs all "$query" --out "$outfile" 2>/dev/null &
    PIDS+=($!)
  done
  
  # Wait for all to complete
  FAILED=0
  for i in "${!PIDS[@]}"; do
    if ! wait "${PIDS[$i]}"; then
      fail "Parallel $i: process exited with error"
      ((FAILED++))
    fi
  done
  
  if [[ $FAILED -eq 0 ]]; then
    # Check results
    for i in "${!PARALLEL_QUERIES[@]}"; do
      outfile="$RESULTS_DIR/parallel_${i}.json"
      query="${PARALLEL_QUERIES[$i]}"
      
      if [[ -f "$outfile" ]]; then
        errors=$(check_no_errors "$outfile")
        if [[ -z "$errors" ]]; then
          pass "Parallel $i: no errors"
        else
          fail "Parallel $i: $errors"
        fi
        
        correct=$(check_correct_queries "$outfile" "$query")
        if [[ "$correct" == "ok" ]]; then
          pass "Parallel $i: correct query"
        else
          fail "Parallel $i: $correct (TAB RACE DETECTED)"
        fi
        
        all_done=$(check_all_engines_completed "$outfile")
        if [[ "$all_done" == "ok" ]]; then
          pass "Parallel $i: all engines answered"
        else
          fail "Parallel $i: $all_done"
        fi
      else
        fail "Parallel $i: no result file"
      fi
    done
  fi
fi

# ── Test 4: Synthesis mode ──────────────────────────────
if [[ "$1" != "parallel" && "$1" != "quick" ]]; then
  echo -e "\nTest 4: Synthesis mode"
  
  outfile="$RESULTS_DIR/synthesis.json"
  node search.mjs all "what is Mixture of Experts in neural networks" --synthesize --out "$outfile" 2>/dev/null
  
  if [[ $? -eq 0 && -f "$outfile" ]]; then
    has_synthesis=$(node -e "
      const d = JSON.parse(require('fs').readFileSync('$outfile','utf8'));
      console.log(d._synthesis?.answer ? 'ok' : 'missing');
    " 2>/dev/null)
    
    if [[ "$has_synthesis" == "ok" ]]; then
      pass "Synthesis completed"
    else
      fail "Synthesis missing"
    fi
    
    errors=$(check_no_errors "$outfile")
    if [[ -z "$errors" ]]; then
      pass "Synthesis: no engine errors"
    else
      fail "Synthesis: $errors"
    fi
  else
    fail "Synthesis failed to run"
  fi
fi

# ─────────────────────────────────────────────────────────
echo -e "\n${YELLOW}═══ Results ═══${NC}"
echo -e "  ${GREEN}Passed: $PASS${NC}"
[[ $FAIL -gt 0 ]] && echo -e "  ${RED}Failed: $FAIL${NC}" || echo "  Failed: 0"
echo "  Results in: $RESULTS_DIR"
echo ""

[[ $FAIL -eq 0 ]] && exit 0 || exit 1

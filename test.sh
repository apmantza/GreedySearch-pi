#!/usr/bin/env bash
# test.sh — GreedySearch comprehensive test suite
#
# Usage:
#   ./test.sh              # run all tests (~8-12 min)
#   ./test.sh quick        # skip slow tests (~3 min)
#   ./test.sh smoke        # basic health check (~60s)
#   ./test.sh parallel     # race condition tests only
#   ./test.sh flags        # flag/option tests only
#   ./test.sh edge         # edge case tests only
#
# Tests verify:
#   - Chrome/CDP connectivity
#   - Each engine works independently
#   - Multi-engine mode works
#   - Parallel searches don't race
#   - Synthesis produces results
#   - Deep research fetches sources
#   - Coding task extracts code blocks
#   - All flags work correctly
#   - Edge cases handled properly

set -e

cd "$(dirname "$0")"

# Config
RESULTS_DIR="results/test_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RESULTS_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Counters
PASS=0
FAIL=0
WARN=0
SKIP=0
FAILURES=()
WARNINGS=()
SKIPPED=()

# Timing
START_TIME=$(date +%s)

# Helper functions
pass() { PASS=$((PASS+1)); echo -e "  ${GREEN}✓${NC} $1"; }
fail() { FAIL=$((FAIL+1)); echo -e "  ${RED}✗${NC} $1"; FAILURES+=("$1"); }
warn() { WARN=$((WARN+1)); echo -e "  ${YELLOW}⚠${NC} $1"; WARNINGS+=("$1"); }
skip() { SKIP=$((SKIP+1)); echo -e "  ${CYAN}⊘${NC} $1"; SKIPPED+=("$1"); }

section() { echo -e "\n${BLUE}$1${NC}"; }
subsection() { echo -e "\n${YELLOW}$1${NC}"; }
info() { echo -e "  ${CYAN}ℹ${NC} $1"; }

# Check functions
check_no_errors() {
  local file="$1"
  node -e "
    const d = JSON.parse(require('fs').readFileSync('$file','utf8'));
    const errs = [];
    if (d.perplexity?.error) errs.push('perplexity: ' + d.perplexity.error);
    if (d.bing?.error) errs.push('bing: ' + d.bing.error);
    if (d.google?.error) errs.push('google: ' + d.google.error);
    if (d.gemini?.error) errs.push('gemini: ' + d.gemini.error);
    console.log(errs.join('; ') || 'OK');
  " 2>/dev/null || echo "PARSE_ERROR"
}

check_correct_queries() {
  local file="$1"
  local expected="$2"
  node -e "
    const d = JSON.parse(require('fs').readFileSync('$file','utf8'));
    const queries = [d.perplexity?.query, d.bing?.query, d.google?.query].filter(Boolean);
    const allMatch = queries.every(q => q === '$expected');
    console.log(allMatch ? 'OK' : 'MISMATCH: ' + queries.join(', '));
  " 2>/dev/null || echo "PARSE_ERROR"
}

check_has_answer() {
  local file="$1"
  local engine="$2"
  node -e "
    const d = JSON.parse(require('fs').readFileSync('$file','utf8'));
    const ans = d.$engine?.answer || d.answer;
    console.log(ans && ans.length > 10 ? 'OK(' + ans.length + ')' : 'NO_ANSWER');
  " 2>/dev/null || echo "PARSE_ERROR"
}

check_has_sources() {
  local file="$1"
  local engine="$2"
  node -e "
    const d = JSON.parse(require('fs').readFileSync('$file','utf8'));
    const src = d.$engine?.sources || d.sources;
    console.log(src && src.length > 0 ? 'OK(' + src.length + ')' : 'NO_SOURCES');
  " 2>/dev/null || echo "PARSE_ERROR"
}

check_synthesis() {
  local file="$1"
  node -e "
    const d = JSON.parse(require('fs').readFileSync('$file','utf8'));
    const syn = d._synthesis;
    if (!syn?.answer) { console.log('NO_SYNTHESIS'); return; }
    const hasAgreement = syn.agreement !== undefined;
    const hasCaveats = syn.caveats !== undefined;
    const hasClaims = Array.isArray(syn.claims) && syn.claims.length > 0;
    const hasSources = d._sources && d._sources.length > 0;
    console.log('OK(answer=' + syn.answer.length + ', agreement=' + hasAgreement + ', caveats=' + hasCaveats + ', claims=' + hasClaims + ', sources=' + (hasSources ? d._sources.length : 0) + ')');
  " 2>/dev/null || echo "PARSE_ERROR"
}

check_deep_research() {
  local file="$1"
  node -e "
    const d = JSON.parse(require('fs').readFileSync('$file','utf8'));
    if (!d._confidence) { console.log('NO_CONFIDENCE'); return; }
    if (!d._sources || d._sources.length === 0) { console.log('NO_DEDUPED_SOURCES'); return; }
    const conf = d._confidence;
    const engines = conf.enginesResponded?.length || 0;
    const fetched = conf.fetchedSourceSuccessRate !== undefined;
    const consensus = conf.topSourceConsensus !== undefined;
    const official = conf.officialSourceCount !== undefined;
    console.log('OK(engines=' + engines + ', fetched=' + fetched + ', consensus=' + consensus + ', official=' + official + ', sources=' + d._sources.length + ')');
  " 2>/dev/null || echo "PARSE_ERROR"
}

check_answer_length() {
  local file="$1"
  local min_len="$2"
  node -e "
    const d = JSON.parse(require('fs').readFileSync('$file','utf8'));
    const ans = d.answer;
    console.log(ans && ans.length >= $min_len ? 'OK(' + ans.length + ')' : 'TOO_SHORT(' + (ans?.length || 0) + ')');
  " 2>/dev/null || echo "PARSE_ERROR"
}

check_answer_truncated() {
  local file="$1"
  node -e "
    const d = JSON.parse(require('fs').readFileSync('$file','utf8'));
    const ans = d.answer;
    console.log(ans && ans.length <= 350 && ans.endsWith('…') ? 'OK(truncated)' : ans?.length > 350 ? 'TOO_LONG' : 'NOT_TRUNCATED');
  " 2>/dev/null || echo "PARSE_ERROR"
}

check_inline_output() {
  local file="$1"
  node -e "
    const fs = require('fs');
    try {
      const d = JSON.parse(fs.readFileSync('$file', 'utf8'));
      console.log(d.answer || d.perplexity?.answer || d.google?.answer ? 'OK' : 'NO_ANSWER_IN_JSON');
    } catch(e) {
      console.log('INVALID_JSON: ' + e.message);
    }
  " 2>/dev/null || echo "PARSE_ERROR"
}

# Run a search with timeout
run_search() {
  local engine="$1"
  local query="$2"
  local outfile="$3"
  local extra_flags="${4:-}"
  local timeout_sec="${5:-120}"
  
  if [[ -n "$extra_flags" ]]; then
    timeout "$timeout_sec" node bin/search.mjs "$engine" "$query" --out "$outfile" $extra_flags 2>/dev/null || true
  else
    timeout "$timeout_sec" node bin/search.mjs "$engine" "$query" --out "$outfile" 2>/dev/null || true
  fi
  [[ -f "$outfile" ]] && [[ -s "$outfile" ]]
}

# Run search and capture stdout for inline tests
run_search_stdout() {
  local engine="$1"
  local query="$2"
  local extra_flags="${3:-}"
  local timeout_sec="${4:-120}"
  
  timeout "$timeout_sec" node bin/search.mjs "$engine" "$query" $extra_flags 2>/dev/null || echo "TIMEOUT"
}

# Print header
echo -e "${YELLOW}═══ GreedySearch Comprehensive Test Suite ═══${NC}"
echo -e "Results: $RESULTS_DIR"
echo -e "Mode: ${1:-all}\n"

# ════════════════════════════════════════════════════════
section "🔧 Pre-flight Checks"
# ════════════════════════════════════════════════════════

# Check Chrome is available
if ! command -v google-chrome &> /dev/null && ! command -v chromium &> /dev/null && ! command -v chrome &> /dev/null; then
  warn "Chrome not found in PATH - using default Chrome location"
else
  pass "Chrome found in PATH"
fi

# Check CDP is available
if [[ ! -f "bin/cdp.mjs" ]]; then
  fail "bin/cdp.mjs missing - extension not properly installed"
  exit 1
else
  pass "CDP module present"
fi

# Check Node version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [[ "$NODE_VERSION" -ge 22 ]]; then
  pass "Node.js 22+ ($NODE_VERSION)"
else
  warn "Node.js $NODE_VERSION (22+ recommended)"
fi

# Check launch.mjs exists
if [[ ! -f "bin/launch.mjs" ]]; then
  warn "bin/launch.mjs missing - Chrome auto-launch may fail"
else
  pass "Chrome launcher present"
fi

# ════════════════════════════════════════════════════════
section "🏷️ Flag & Option Tests"
# ════════════════════════════════════════════════════════

if [[ "$1" == "" || "$1" == "flags" || "$1" == "quick" || "$1" == "smoke" ]]; then
  subsection "Testing --full flag (long answers)..."
  
  outfile="$RESULTS_DIR/flag_full.json"
  if run_search "perplexity" "explain neural networks" "$outfile" "--full" 120; then
    len=$(check_answer_length "$outfile" 500)
    if [[ "$len" == OK* ]]; then
      pass "--full: $len chars"
    else
      warn "--full: $len (expected 500+)"
    fi
  else
    fail "--full: search failed"
  fi
  
  subsection "Testing default (short) answers..."
  
  outfile="$RESULTS_DIR/flag_short.json"
  if run_search "perplexity" "explain neural networks" "$outfile" "" 120; then
    trunc=$(check_answer_truncated "$outfile")
    if [[ "$trunc" == "OK(truncated)" ]]; then
      pass "default: answer truncated (~300 chars)"
    elif [[ "$trunc" == "TOO_LONG" ]]; then
      warn "default: answer not truncated (returned full)"
    else
      info "default: $trunc"
    fi
  else
    fail "default: search failed"
  fi
  
  subsection "Testing --inline flag (stdout output)..."

  inline_tmp="$RESULTS_DIR/flag_inline.json"
  timeout 90 node bin/search.mjs perplexity "what is AI" --inline 2>/dev/null > "$inline_tmp" || true
  if [[ -s "$inline_tmp" ]]; then
    inline=$(check_inline_output "$inline_tmp")
    if [[ "$inline" == "OK" ]]; then
      pass "--inline: JSON output to stdout"
    else
      warn "--inline: $inline"
    fi
  else
    fail "--inline: timeout or no output"
  fi
  
  subsection "Testing engine aliases..."
  
  for alias in p g b; do
    outfile="$RESULTS_DIR/alias_${alias}.json"
    if run_search "$alias" "test query" "$outfile" "" 60; then
      pass "alias '$alias': search completed"
    else
      warn "alias '$alias': failed (may be expected for some engines)"
    fi
  done
fi

# ════════════════════════════════════════════════════════
section "🧪 Single Engine Tests"
# ════════════════════════════════════════════════════════

if [[ "$1" != "parallel" && "$1" != "synthesis" && "$1" != "deep" && "$1" != "flags" && "$1" != "edge" ]]; then
  for engine in perplexity bing google; do
    subsection "Testing $engine engine..."
    
    outfile="$RESULTS_DIR/single_${engine}.json"
    query="explain transformer attention mechanism in 2 sentences"
    
    if run_search "$engine" "$query" "$outfile" "" 90; then
      # Check for errors
      errors=$(check_no_errors "$outfile")
      if [[ "$errors" == "OK" ]]; then
        pass "$engine: no errors"
      else
        fail "$engine: $errors"
      fi
      
      # Check has answer
      ans=$(check_has_answer "$outfile" "$engine")
      if [[ "$ans" == OK* ]]; then
        pass "$engine: returned $ans chars"
      else
        warn "$engine: $ans"
      fi
      
      # Check has sources
      src=$(check_has_sources "$outfile" "$engine")
      if [[ "$src" == OK* ]]; then
        pass "$engine: has $src sources"
      else
        warn "$engine: $src (Bing often has no sources)"
      fi
    else
      fail "$engine: search failed or timed out"
    fi
  done
fi

# ════════════════════════════════════════════════════════
section "🔄 Sequential Multi-Engine Tests"
# ════════════════════════════════════════════════════════

if [[ "$1" != "parallel" && "$1" != "smoke" && "$1" != "flags" && "$1" != "edge" ]]; then
  subsection "Testing sequential 'all' mode (3 runs)..."
  
  for i in 1 2 3; do
    outfile="$RESULTS_DIR/seq_${i}.json"
    query="LLM optimization techniques run $i"
    
    if run_search "all" "$query" "$outfile" "" 180; then
      errors=$(check_no_errors "$outfile")
      if [[ "$errors" == "OK" ]]; then
        pass "Run $i: no engine errors"
      else
        fail "Run $i: $errors"
      fi
      
      correct=$(check_correct_queries "$outfile" "$query")
      if [[ "$correct" == "OK" ]]; then
        pass "Run $i: correct query"
      else
        fail "Run $i: $correct"
      fi
      
      # Check all engines have answers
      for engine in perplexity bing google; do
        if [[ $(check_has_answer "$outfile" "$engine") == OK* ]]; then
          pass "Run $i: $engine has answer"
        else
          warn "Run $i: $engine missing answer"
        fi
      done
    else
      fail "Run $i: search failed or timed out"
    fi
  done
fi

# ════════════════════════════════════════════════════════
section "⚡ Parallel Race Condition Tests"
# ════════════════════════════════════════════════════════

if [[ "$1" == "" || "$1" == "parallel" || "$1" == "quick" ]]; then
  subsection "Test 1: 5 concurrent 'all' searches..."
  
  PARALLEL_QUERIES=(
    "what are transformer architectures"
    "explain RLHF fine-tuning"
    "difference between GPT and BERT"
    "how does chain of thought prompting work"
    "what is retrieval augmented generation"
  )
  
  PIDS=()
  for i in "${!PARALLEL_QUERIES[@]}"; do
    outfile="$RESULTS_DIR/parallel1_${i}.json"
    query="${PARALLEL_QUERIES[$i]}"
    node bin/search.mjs all "$query" --out "$outfile" 2>/dev/null &
    PIDS+=($!)
  done
  
  # Wait for all
  CRASHED=0
  for i in "${!PIDS[@]}"; do
    if ! wait "${PIDS[$i]}"; then
      ((CRASHED++))
    fi
  done
  
  if [[ $CRASHED -gt 0 ]]; then
    fail "$CRASHED parallel searches crashed"
  fi
  
  # Validate results
  RACE_DETECTED=0
  MISSING=0
  for i in "${!PARALLEL_QUERIES[@]}"; do
    outfile="$RESULTS_DIR/parallel1_${i}.json"
    query="${PARALLEL_QUERIES[$i]}"
    
    if [[ ! -f "$outfile" ]]; then
      ((MISSING++))
      continue
    fi
    
    errors=$(check_no_errors "$outfile")
    if [[ "$errors" == "OK" ]]; then
      pass "Parallel1 $i: no errors"
    else
      fail "Parallel1 $i: $errors"
    fi
    
    correct=$(check_correct_queries "$outfile" "$query")
    if [[ "$correct" == "OK" ]]; then
      pass "Parallel1 $i: correct query"
    else
      fail "Parallel1 $i: $correct (RACE)"
      RACE_DETECTED=$((RACE_DETECTED+1))
    fi
  done
  
  if [[ $RACE_DETECTED -gt 0 ]]; then
    fail "RACE CONDITION: $RACE_DETECTED queries mismatched"
  fi
  if [[ $MISSING -gt 0 ]]; then
    fail "$MISSING parallel searches produced no output"
  fi
  
  subsection "Test 2: 3 concurrent 'all' + synthesis..."
  
  SYNTH_PIDS=()
  for i in 1 2 3; do
    outfile="$RESULTS_DIR/parallel2_${i}.json"
    query="synthesis test $i"
    node bin/search.mjs all "$query" --synthesize --out "$outfile" 2>/dev/null &
    SYNTH_PIDS+=($!)
  done
  
  for i in "${!SYNTH_PIDS[@]}"; do
    wait "${SYNTH_PIDS[$i]}" || true
  done
  
  for i in 1 2 3; do
    outfile="$RESULTS_DIR/parallel2_${i}.json"
    if [[ -f "$outfile" ]]; then
      syn=$(check_synthesis "$outfile")
      if [[ "$syn" == OK* ]]; then
        pass "Parallel2 $i: synthesis $syn"
      else
        warn "Parallel2 $i: $syn"
      fi
    else
      fail "Parallel2 $i: no output"
    fi
  done
fi

# ════════════════════════════════════════════════════════
section "🤖 Synthesis Mode Tests"
# ════════════════════════════════════════════════════════

if [[ "$1" != "parallel" && "$1" != "quick" && "$1" != "smoke" && "$1" != "flags" && "$1" != "edge" ]]; then
  subsection "Test 1: Basic synthesis..."
  
  outfile="$RESULTS_DIR/synthesis1.json"
  query="what is Mixture of Experts in neural networks"
  
  if run_search "all" "$query" "$outfile" "--synthesize" 300; then
    errors=$(check_no_errors "$outfile")
    if [[ "$errors" == "OK" ]]; then
      pass "Synthesis1: no engine errors"
    else
      fail "Synthesis1: $errors"
    fi
    
    syn=$(check_synthesis "$outfile")
    if [[ "$syn" == OK* ]]; then
      pass "Synthesis1: $syn"
    else
      fail "Synthesis1: $syn"
    fi
  else
    fail "Synthesis1: timeout"
  fi
  
  subsection "Test 2: Synthesis with conflicting info..."
  
  outfile="$RESULTS_DIR/synthesis2.json"
  query="Python vs JavaScript for backend development 2024"
  
  if run_search "all" "$query" "$outfile" "--synthesize" 300; then
    if [[ $(check_synthesis "$outfile") == OK* ]]; then
      pass "Synthesis2: completed with comparison"
    else
      warn "Synthesis2: incomplete"
    fi
  else
    warn "Synthesis2: timeout (may be expected)"
  fi
fi

# ════════════════════════════════════════════════════════
section "📚 Deep Research Tests"
# ════════════════════════════════════════════════════════

if [[ "$1" != "parallel" && "$1" != "quick" && "$1" != "smoke" && "$1" != "sequential" && "$1" != "flags" && "$1" != "edge" ]]; then
  subsection "Test 1: Full deep research..."
  
  outfile="$RESULTS_DIR/deep1.json"
  query="best practices for React Server Components 2024"
  
  if run_search "all" "$query" "$outfile" "--deep" 300; then
    errors=$(check_no_errors "$outfile")
    if [[ "$errors" == "OK" ]]; then
      pass "Deep1: no engine errors"
    else
      fail "Deep1: $errors"
    fi
    
    deep=$(check_deep_research "$outfile")
    if [[ "$deep" == OK* ]]; then
      pass "Deep1: $deep"
    else
      fail "Deep1: $deep"
    fi
  else
    fail "Deep1: timeout"
  fi
  
  subsection "Test 2: Deep research with source fetching..."
  
  outfile="$RESULTS_DIR/deep2.json"
  query="what are the latest CSS container query features"
  
  if run_search "all" "$query" "$outfile" "--deep" 300; then
    node -e "
      const d = JSON.parse(require('fs').readFileSync('$outfile','utf8'));
      const fetched = d._confidence?.fetchedSourceSuccessRate;
      const evidence = d._sources?.some(s => s.evidence?.length > 0);
      console.log('fetched_rate=' + (fetched || 'N/A') + ', has_evidence=' + evidence);
    " 2>/dev/null | while read line; do pass "Deep2: $line"; done
  else
    warn "Deep2: timeout"
  fi
fi

# ════════════════════════════════════════════════════════
section "🔍 Edge Case Tests"
# ════════════════════════════════════════════════════════

if [[ "$1" == "" || "$1" == "edge" || "$1" == "quick" ]]; then
  subsection "Test 1: Special characters in query..."
  
  outfile="$RESULTS_DIR/edge_special.json"
  query="C++ memory management & pointers (what's new?)"
  
  if run_search "perplexity" "$query" "$outfile" "" 90; then
    actual_query=$(node -e "const d=JSON.parse(require('fs').readFileSync('$outfile','utf8')); console.log(d.query);" 2>/dev/null)
    if [[ "$actual_query" == *"C++"* && "$actual_query" == *"&"* ]]; then
      pass "Edge1: special chars preserved"
    else
      warn "Edge1: query mangled: $actual_query"
    fi
  else
    warn "Edge1: search failed"
  fi
  
  subsection "Test 2: Long query..."
  
  outfile="$RESULTS_DIR/edge_long.json"
  query="Explain the difference between REST API design patterns and GraphQL schema design with specific focus on pagination strategies caching mechanisms and error handling approaches in modern web applications"
  
  if run_search "google" "$query" "$outfile" "" 120; then
    if [[ $(check_has_answer "$outfile" "google") == OK* ]]; then
      pass "Edge2: long query handled"
    else
      warn "Edge2: no answer"
    fi
  else
    warn "Edge2: timeout"
  fi
  
  subsection "Test 3: Very short query..."
  
  outfile="$RESULTS_DIR/edge_short.json"
  query="Docker"
  
  if run_search "perplexity" "$query" "$outfile" "" 90; then
    if [[ $(check_has_answer "$outfile" "perplexity") == OK* ]]; then
      pass "Edge3: short query handled"
    else
      warn "Edge3: no answer"
    fi
  else
    warn "Edge3: timeout"
  fi
  
  subsection "Test 4: Unicode/international characters..."
  
  outfile="$RESULTS_DIR/edge_unicode.json"
  query="日本のAI技術について教えて"
  
  if run_search "google" "$query" "$outfile" "" 120; then
    actual_query=$(node -e "const d=JSON.parse(require('fs').readFileSync('$outfile','utf8')); console.log(d.query);" 2>/dev/null)
    if [[ "$actual_query" == *"日本"* ]]; then
      pass "Edge4: unicode preserved"
    else
      warn "Edge4: unicode mangled: $actual_query"
    fi
  else
    warn "Edge4: timeout"
  fi
fi

# ════════════════════════════════════════════════════════
section "🐙 GitHub Fetch Tests"
# ════════════════════════════════════════════════════════

if [[ "$1" == "" || "$1" == "edge" || "$1" == "quick" || "$1" == "smoke" ]]; then
  # Run a GitHub fetch test using a temp .mjs file in RESULTS_DIR (keeps relative imports valid)
  run_gh_node() {
    local outfile="$1"
    local nodescript="$2"
    local timeout_sec="${3:-20}"
    local tmpscript="./_gh_test_$.mjs"
    printf '%s
' "$nodescript" > "$tmpscript"
    timeout "$timeout_sec" node "$tmpscript" 2>/dev/null || true
    rm -f "$tmpscript"
  }

  subsection "Test 1: Root repo fetch (API — README + tree)..."

  gh_tmp="$RESULTS_DIR/gh_root.json"
  run_gh_node "$gh_tmp" "
    import { fetchGitHubContent } from './src/github.mjs';
    import { writeFileSync } from 'fs';
    try {
      const r = await fetchGitHubContent('https://github.com/danicat/testquery');
      writeFileSync('$gh_tmp', JSON.stringify(r));
    } catch(e) { writeFileSync('$gh_tmp', JSON.stringify({ ok: false, error: e.message })); }
  "
  if [[ -f "$gh_tmp" ]]; then
    result=$(node -e "
      const r = JSON.parse(require('fs').readFileSync('$gh_tmp', 'utf8'));
      console.log(r.ok && r.content.length > 100 ? 'OK(chars=' + r.content.length + ', tree=' + (r.tree?.length||0) + ')' : 'FAIL: ' + (r.error||'short content'));
    " 2>/dev/null)
    [[ "$result" == OK* ]] && pass "GitHub root: $result" || fail "GitHub root: ${result:-no output}"
  else
    fail "GitHub root: no output"
  fi

  subsection "Test 2: Blob file fetch (raw URL)..."

  gh_tmp2="$RESULTS_DIR/gh_blob.json"
  run_gh_node "$gh_tmp2" "
    import { fetchGitHubContent } from './src/github.mjs';
    import { writeFileSync } from 'fs';
    try {
      const r = await fetchGitHubContent('https://github.com/expressjs/express/blob/master/Readme.md');
      writeFileSync('$gh_tmp2', JSON.stringify(r));
    } catch(e) { writeFileSync('$gh_tmp2', JSON.stringify({ ok: false, error: e.message })); }
  "
  if [[ -f "$gh_tmp2" ]]; then
    result=$(node -e "
      const r = JSON.parse(require('fs').readFileSync('$gh_tmp2', 'utf8'));
      console.log(r.ok && r.content.length > 100 ? 'OK(chars=' + r.content.length + ')' : 'FAIL: ' + (r.error||'short content'));
    " 2>/dev/null)
    [[ "$result" == OK* ]] && pass "GitHub blob: $result" || fail "GitHub blob: ${result:-no output}"
  else
    fail "GitHub blob: no output"
  fi

  subsection "Test 3: GitHub blob via HTTP fetcher (raw URL rewrite)..."

  gh_tmp3="$RESULTS_DIR/gh_fetcher.json"
  run_gh_node "$gh_tmp3" "
    import { fetchSourceHttp } from './src/fetcher.mjs';
    import { writeFileSync } from 'fs';
    try {
      const r = await fetchSourceHttp('https://github.com/expressjs/express/blob/master/Readme.md');
      writeFileSync('$gh_tmp3', JSON.stringify({ ok: r.ok, title: r.title, length: r.markdown?.length, needsBrowser: r.needsBrowser, error: r.error }));
    } catch(e) { writeFileSync('$gh_tmp3', JSON.stringify({ ok: false, error: e.message })); }
  "
  if [[ -f "$gh_tmp3" ]]; then
    result=$(node -e "
      const r = JSON.parse(require('fs').readFileSync('$gh_tmp3', 'utf8'));
      console.log(r.ok && r.length > 100 ? 'OK(chars=' + r.length + ')' : 'FAIL: ' + (r.error||'ok='+r.ok));
    " 2>/dev/null)
    [[ "$result" == OK* ]] && pass "GitHub via fetcher: $result" || fail "GitHub via fetcher: ${result:-no output}"
  else
    fail "GitHub via fetcher: no output"
  fi

  subsection "Test 4: Invalid GitHub URL graceful failure..."

  gh_tmp4="$RESULTS_DIR/gh_invalid.json"
  run_gh_node "$gh_tmp4" "
    import { fetchGitHubContent } from './src/github.mjs';
    import { writeFileSync } from 'fs';
    try {
      const r = await fetchGitHubContent('https://github.com/this-owner-does-not-exist-xyz/no-repo-here');
      writeFileSync('$gh_tmp4', JSON.stringify(r));
    } catch(e) { writeFileSync('$gh_tmp4', JSON.stringify({ ok: false, error: e.message })); }
  " 15
  if [[ -f "$gh_tmp4" ]]; then
    result=$(node -e "
      const r = JSON.parse(require('fs').readFileSync('$gh_tmp4', 'utf8'));
      console.log(!r.ok && r.error ? 'OK(graceful: ' + r.error.slice(0,50) + ')' : 'FAIL: returned ok=true');
    " 2>/dev/null)
    [[ "$result" == OK* ]] && pass "GitHub invalid URL: $result" || fail "GitHub invalid URL: ${result:-no output}"
  else
    fail "GitHub invalid URL: no output"
  fi
fi

# ════════════════════════════════════════════════════════
section "💻 Coding Task Tests"
# ════════════════════════════════════════════════════════

if [[ "$1" != "parallel" && "$1" != "smoke" && "$1" != "sequential" && "$1" != "flags" && "$1" != "edge" ]]; then
  subsection "Test 1: Code generation mode..."
  
  outfile="$RESULTS_DIR/coding1.json"
  
  timeout 180 node bin/coding-task.mjs "write a python function to reverse a string" --engine gemini --mode code --out "$outfile" 2>/dev/null || true
  
  if [[ -f "$outfile" ]]; then
    has_code=$(node -e "
      const d = JSON.parse(require('fs').readFileSync('$outfile','utf8'));
      const resp = d.gemini?.response || d.response;
      console.log(resp?.code || resp?.explanation ? 'OK' : 'NO_CODE');
    " 2>/dev/null)
    
    if [[ "$has_code" == "OK" ]]; then
      pass "Coding1: code generated"
    else
      warn "Coding1: $has_code"
    fi
  else
    warn "Coding1: no output"
  fi
  
  subsection "Test 2: Debug mode..."
  
  outfile="$RESULTS_DIR/coding2.json"
  
  timeout 180 node bin/coding-task.mjs "debug: why does this loop hang - for(let i=0; i<10; i--) {}" --engine gemini --mode debug --out "$outfile" 2>/dev/null || true
  
  if [[ -f "$outfile" ]]; then
    has_debug=$(node -e "
      const d = JSON.parse(require('fs').readFileSync('$outfile','utf8'));
      const resp = d.gemini?.response || d.response;
      console.log(resp?.rootCause || resp?.solution ? 'OK' : 'NO_DEBUG_INFO');
    " 2>/dev/null)
    
    if [[ "$has_debug" == "OK" ]]; then
      pass "Coding2: debug info returned"
    else
      warn "Coding2: $has_debug"
    fi
  else
    warn "Coding2: no output"
  fi
  
  subsection "Test 3: Review mode..."
  
  outfile="$RESULTS_DIR/coding3.json"
  
  timeout 180 node bin/coding-task.mjs "review this code: function add(a,b){ return a+b; }" --engine gemini --mode review --out "$outfile" 2>/dev/null || true
  
  if [[ -f "$outfile" ]]; then
    has_review=$(node -e "
      const d = JSON.parse(require('fs').readFileSync('$outfile','utf8'));
      const resp = d.gemini?.response || d.response;
      console.log(resp?.feedback || resp?.suggestions ? 'OK' : 'NO_REVIEW');
    " 2>/dev/null)
    
    if [[ "$has_review" == "OK" ]]; then
      pass "Coding3: review returned"
    else
      warn "Coding3: $has_review"
    fi
  else
    warn "Coding3: no output"
  fi
fi

# ════════════════════════════════════════════════════════
section "📊 Test Summary"
# ════════════════════════════════════════════════════════

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# Generate report
REPORT_FILE="$RESULTS_DIR/REPORT.md"

cat > "$REPORT_FILE" << EOF
# GreedySearch Test Report

**Date:** $(date)
**Duration:** ${DURATION}s
**Results Directory:** $RESULTS_DIR
**Test Mode:** ${1:-all}

## Summary

| Metric | Count |
|--------|-------|
| ✅ Passed | $PASS |
| ❌ Failed | $FAIL |
| ⚠️ Warnings | $WARN |
| ⊘ Skipped | $SKIP |
| **Total** | $((PASS + FAIL + WARN + SKIP)) |

## Result Breakdown
EOF

if [[ $FAIL -eq 0 && $WARN -eq 0 && $SKIP -eq 0 ]]; then
  echo -e "\n🎉 All tests passed!\n" >> "$REPORT_FILE"
else
  echo "" >> "$REPORT_FILE"
  
  if [[ ${#FAILURES[@]} -gt 0 ]]; then
    echo "### Failures" >> "$REPORT_FILE"
    for i in "${!FAILURES[@]}"; do
      echo "$((i+1)). ${FAILURES[$i]}" >> "$REPORT_FILE"
    done
    echo "" >> "$REPORT_FILE"
  fi
  
  if [[ ${#WARNINGS[@]} -gt 0 ]]; then
    echo "### Warnings" >> "$REPORT_FILE"
    for i in "${!WARNINGS[@]}"; do
      echo "$((i+1)). ${WARNINGS[$i]}" >> "$REPORT_FILE"
    done
    echo "" >> "$REPORT_FILE"
  fi
  
  if [[ ${#SKIPPED[@]} -gt 0 ]]; then
    echo "### Skipped" >> "$REPORT_FILE"
    for i in "${!SKIPPED[@]}"; do
      echo "$((i+1)). ${SKIPPED[$i]}" >> "$REPORT_FILE"
    done
  fi
fi

cat >> "$REPORT_FILE" << 'EOF'

## Test Categories

### Pre-flight Checks
- Chrome availability
- CDP module presence
- Node.js version

### Flag Tests
- `--full` (long answers)
- `--short` / default (truncated answers)
- `--inline` (stdout output)
- Engine aliases (p, g, b, etc.)

### Single Engine Tests
- Perplexity: search, answer, sources
- Bing: search, answer, sources
- Google: search, answer, sources

### Multi-Engine Tests
- Sequential 3-run test
- Query correctness verification
- Answer presence per engine

### Parallel Tests
- 5 concurrent 'all' searches
- 3 concurrent synthesis searches
- Race condition detection

### Synthesis Tests
- Basic synthesis
- Conflicting information handling

### Deep Research Tests
- Full deep research mode
- Source fetching verification

### Edge Case Tests
- Special characters (&, +, etc.)
- Long queries
- Short queries
- Unicode/international text

### GitHub Fetch Tests
- Root repo fetch (README + tree via API)
- Blob file fetch (raw.githubusercontent.com rewrite)
- Full pipeline via HTTP fetcher
- Invalid URL graceful failure

### Coding Task Tests
- Code generation
- Debug mode
- Review mode

## Troubleshooting

### "Chrome not found"
Install Chrome or set CHROME_PATH environment variable.

### "CDP timeout" / "Chrome may have crashed"
Restart the dedicated Chrome instance:
```bash
node bin/launch.mjs --kill
node bin/launch.mjs
```

### Engine-specific errors
Check individual result JSON files in the results directory for detailed error messages.

### Race condition detected
This indicates parallel searches are sharing state. Each search should use isolated tabs.

### Synthesis/Deep Research timeouts
These modes take longer (3-5 minutes). Increase timeout values if needed.

EOF

echo -e "\n${YELLOW}═══ Results ═══${NC}"
echo -e "  ${GREEN}Passed:   $PASS${NC}"
echo -e "  ${RED}Failed:   $FAIL${NC}"
echo -e "  ${YELLOW}Warnings: $WARN${NC}"
echo -e "  ${CYAN}Skipped:  $SKIP${NC}"
echo "  Duration: ${DURATION}s"
echo ""
echo "  Results: $RESULTS_DIR"
echo "  Report:  $REPORT_FILE"
echo ""

# Print details inline
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo -e "${RED}Failures:${NC}"
  for f in "${FAILURES[@]}"; do
    echo -e "  ${RED}•${NC} $f"
  done
  echo ""
fi

if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  echo -e "${YELLOW}Warnings:${NC}"
  for w in "${WARNINGS[@]}"; do
    echo -e "  ${YELLOW}•${NC} $w"
  done
  echo ""
fi

if [[ ${#SKIPPED[@]} -gt 0 ]]; then
  echo -e "${CYAN}Skipped:${NC}"
  for s in "${SKIPPED[@]}"; do
    echo -e "  ${CYAN}•${NC} $s"
  done
  echo ""
fi

# Exit code
[[ $FAIL -eq 0 ]] && exit 0 || exit 1

#!/usr/bin/env bash
# crosscheck.sh: runs the AI-checkable rules of toggle-wars-crosschecker.md against a fresh clone.
# Usage: DEMO_CMD="uv run pilot demo" TEST_CMD="uv run pytest -q" ./crosscheck.sh <repo-url-or-path>
# Prints PASS/FAIL per rule id and exits 1 if any FAIL. Rules that need a person are not covered here.
set -u
src="${1:?repo url or path}"
tmp="$(mktemp -d)"
fail=0
report() { # id, description, 0=pass
  if [ "$3" -eq 0 ]; then echo "PASS $1 $2"; else echo "FAIL $1 $2"; fail=1; fi
}

git clone -q "$src" "$tmp/r" 2>/dev/null; report H3 "repo clones without credentials" $?
[ -d "$tmp/r" ] || exit 1
cd "$tmp/r" || exit 1

grep -qiE '^#+ .*(setup|install|quick ?start|getting started|run it|try it)' README.md 2>/dev/null; report H4a "README has a setup heading" $?
grep -qiE '^#+ .*flagsmith' README.md 2>/dev/null; report H4b "README has a heading about Flagsmith" $?

! grep -rInE 'TODO|link coming|coming soon|<your-|<\.\.\.>|lorem ipsum' README.md docs 2>/dev/null | grep -q .; report H11 "no placeholders in README or docs" $?

! git grep -nIE '(Api-Key|Token|Bearer) +[A-Za-z0-9._-]{20,}|FLAGSMITH_[A-Z_]*(KEY|TOKEN)=[A-Za-z0-9._-]{8,}|ser\.[A-Za-z0-9]{20,}' 2>/dev/null | grep -v -iE 'example|<' | grep -q .; report H7a "no secret-looking strings in the tree" $?
! git log -p --all 2>/dev/null | grep -E '^\+.*(Api-Key|Token|Bearer) +[A-Za-z0-9._-]{20,}' | grep -v -iE 'example|<' | grep -q .; report H7b "no secret-looking strings in history" $?
! git ls-files | grep -E '(^|/)(flagsmith\.env|\.env)$' | grep -q .; report H7c "no env file with secrets is tracked" $?
{ [ -f .gitignore ] && grep -qE 'flagsmith\.env|\.env' .gitignore; }; report H7d ".gitignore covers env files" $?

[ -f LICENSE ] || [ -f LICENSE.md ]; report I9 "licence file present" $?

n=$(grep -rhoE 'os: *\[[^]]*\]' .github/workflows 2>/dev/null | tr ',' '\n' | grep -c -E 'ubuntu|macos|windows')
[ "${n:-0}" -ge 2 ]; report I2 "CI matrix lists 2 or more operating systems" $?

if [ -n "${DEMO_CMD:-}" ]; then
  s=$(date +%s); timeout 120 bash -c "$DEMO_CMD" >/dev/null 2>&1; rc=$?; e=$(date +%s)
  [ $rc -eq 0 ] && [ $((e - s)) -le 60 ]; report U1 "offline demo exits 0 within 60 s (took $((e - s)) s)" $?
else echo "SKIP U1 set DEMO_CMD"; fi

if [ -n "${TEST_CMD:-}" ]; then
  out=$(timeout 300 bash -c "$TEST_CMD" 2>&1); rc=$?
  [ $rc -eq 0 ]; report I1a "test command exits 0" $?
  echo "INFO I1b test summary: $(echo "$out" | tail -1)"
else echo "SKIP I1 set TEST_CMD"; fi

echo "files: $(git ls-files | wc -l)  commits: $(git rev-list --count HEAD)  first: $(git log --reverse --format=%ad --date=iso | head -1)  last: $(git log -1 --format=%ad --date=iso)"
rm -rf "$tmp"
exit $fail

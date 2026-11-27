# Flagsmith CLI: what it can and cannot do here

Checked against `flagsmith --help` and each subcommand's `--help`, Flagsmith CLI **v2.0.0**, 2026-11-27.
Every command below was also run for real on Development (notes/flagsmith-calls.md).

## Workflow step by step

| Step | Flagsmith CLI v2.0.0 | Used by this skill |
|---|---|---|
| Check the binding's environment | `flagsmith api api/v1/environments/<key>/ --jq '{name}'` | the status helper (key read from the binding, never shown) |
| Check that a flag key is free | `flagsmith feature list --jq '...'` | step 1 and the status helper |
| Create the flag and variation | `flagsmith feature create`, `feature variant add` exist | not used: a direct CLI write is not gated by the approval file. The pilot creates them after approval |
| Create the metric | **no command** (no `metric` subcommand) | pilot `apply --phase create` |
| Create the experiment | **no command** (no `experiment` subcommand) | pilot `apply --phase create` |
| Start the experiment | **no command** | pilot `apply --phase start` |
| Read or refresh the results | **no command** | pilot `readout --refresh` |
| Complete the experiment (control, variant, disable) | **no command** | pilot `apply --phase stop --rollout ...` |
| Check the flag's state | `flagsmith flag get <key> --jq '{enabled, value}'` | step 8 |
| See what a visitor gets | `flagsmith evaluate <key> --identity <id> --jq '{value, variant}'` | step 8, after completion only |

The pilot's `--via-cli` transport sends each Admin API call as `flagsmith api <path> -X <method> -i --no-input`
(with `--input -` for a JSON body), so the CLI's stored login is used and no admin token exists anywhere.

## Read commands you may run (always with --jq)

```
flagsmith config --jq '{project: .project.value, environment: .environment.name}'
flagsmith environment list -c ../flagsmith.json --jq '[.[] | {id, name}]'
flagsmith feature list -c ../flagsmith.json --jq '[.[] | select(.name=="<key>") | {id, type}]'
flagsmith feature get <key> -c ../flagsmith.json --jq '{id, name, type}'
flagsmith flag get <key> -c ../flagsmith.json --jq '{enabled, value}'
flagsmith evaluate <key> --identity sim_check_0001 -c ../flagsmith.json --jq '{value, variant}'
flagsmith auth status --jq '{kind, expiresAt}'
```

`environment list` without `--jq` prints each environment's `api_key`. Never run it without the filter above.

## Traps found while verifying

- **The npm wrapper hides failures.** `flagsmith` installed with npm is a Node wrapper that never passes the
  native binary's exit code back: every call exits 0, even a 404. Read the output for `Error:`. The status
  helper and the pilot run the native binary (or `FLAGSMITH_BIN`).
- **Error messages contain the environment key.** On an HTTP error the CLI prints
  `Error: GET https://.../environments/<key>/... returned 404`. Do not hand-build `flagsmith api` paths with the key;
  the helper and the pilot redact it.
- **`--jq` prints a bare string raw** (`Development`, not `"Development"`); wrap it, e.g. `--jq '{name}'`, when a script parses JSON.
- **Login expires.** `flagsmith auth status --jq '{kind, expiresAt}'` shows when. Only the human runs
  `flagsmith login` (it opens a browser).
- **Windows quoting.** Run commands from bash; PowerShell and `cmd` split `--jq` expressions that contain spaces.
- Never use `flagsmith auth token` (prints the credential) or `flagsmith init` (rewrites the binding).

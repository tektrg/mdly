Use logical CSS spacing props (`margin/padding` inline/block/start/end), not physical left/right/top/bottom.

Check work: `pnpm build:desktop` (builds packages, runs biome check, tsc, vite build, cargo check). For quick iteration use `pnpm check` and desktop tsc.

Before development handoff for the desktop app, run `pnpm install:dev-app`. It rebuilds the Hubble/mdly dev launcher, installs it to `/Applications/mdly.app`, and opens it, which restarts the `hubble_desktop_dev` tmux session and the Electron app.

After desktop builds, review large derivative artifacts and clean clearly stale ones before handoff. Common candidates include old `.dev-electron` app bundles, repo-local launcher `.app` outputs, stale release packages, and root `.build`; keep current release deliverables, active dev app caches/watchers, and anything ambiguous. Report what was removed and what was kept.

Test the web app by appending `?test=1` to the dev server URL — bypasses the connect / workspace-picker screens. Requires `VITE_TEST_CONVEX_URL` and `VITE_TEST_WORKSPACE_ID` in `apps/www/.env.local` (see `apps/www/.env.example`).

When asked why you made a decision, answer why. Don't take it as a challenge to your approach, or pressure to change your solution.

Comments aren't evil. Use doc comments on complex functions, or inline comments where the "why" behind code isn't immediately clear by the implementation. Continue omitting comments for other cases, by your best judgment.

## Agent skills

### Issue tracker

GitHub Issues on `bholmesdev/hubble.md` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Defaults: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Review readiness

Use `.agents/skills/review-readiness` before handing code to a human reviewer.

### Deliver — standard shipping loop

The reusable workflow at `.claude/workflows/deliver.js` is the standard loop for shipping any
change in this monorepo (Electron desktop, web apps, or a published package): oracle-first,
grep-grounded wiring, verified via Vitest and a manual desktop dev-app pass (this repo has no
code-intel tool and no e2e harness — don't invent either). Tracking is local-only, never wired
to an external tracker.

Invoke (requires ultracode / explicit opt-in — it fans out subagents):
`Workflow({ name: "deliver", args: { item, kind: "feature"|"fix", stage: "plan"|"validate" } })`

Loop: run `stage:"plan"` (defines oracles, designs + door-census, writes the frozen charter +
living test plan + coverage ledger) → **implement inline** in the main loop (delegate to a
FRESH agent, not a fork; verify real changes with `git status` before trusting the report) →
run `stage:"validate"` with `changedFiles` + the plan's `spec` (proves wiring live, QA reviews,
emits a verification checklist you then drive inline). Strategic forks halt the run and bubble
up as decisions to ask the user. Use `size:"small"` for one-line fixes.

**Artifacts live one level up, not in this repo.** This repo is the public `tektrg/mdly`
checkout; delivery scratch (charter, test plan, status, coverage) must never enter its git
history. Everything is written under the parent `markdown-lite-mac` project's PARA `memory/`
tree instead: `../memory/Projects/deliver-<slug>/charter.md` (frozen ask + numbered rules
R1..Rn), `test-plan.md` (living case checklist), `status.md` (live stage), `coverage.json`
(machine-readable rule ledger). The index `../memory/Projects/ACTIVE-DELIVERY.md` is
**generated** by `../scripts/gen-active-delivery-index.py` — never hand-edit it; close a
delivery by prefixing its `status.md` Stage with `DONE —` and re-running the script.

Known limitation: verification for anything UI-visible in the Electron desktop app is a manual
dev-app pass, not an automated check — there is no e2e harness in this repo.

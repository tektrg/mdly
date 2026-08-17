export const meta = {
  name: 'deliver',
  description: 'Deliver a feature or fix for mdly (the tektrg/mdly Electron-desktop + web Markdown-editor monorepo, forked from bholmesdev/hubble.md) with oracle-first, verified rigor. Analysis-only fan-out; stateful implement + Vitest/manual-dev-app verification happen inline in the main loop between stages.',
  whenToUse: 'Shipping any change to the mdly monorepo — the Electron desktop app (apps/desktop), a web app (apps/web, apps/notion-web, apps/www), or a published package (packages/workspace-kit, packages/sync, packages/cli). Run stage:"plan" first, implement inline, then stage:"validate".',
  phases: [
    { title: 'Oracles' },       // define user-visible pass conditions (red-first)
    { title: 'Design' },        // N approaches -> judge -> live-path-traced plan (grep-grounded)
    { title: 'QA (pre-impl)' }, // adversarially harden the case list BEFORE any code
    { title: 'Test plan' },     // persist charter + test plan + per-run status.md + coverage; regen index
    { title: 'Wiring' },        // adversarial producer->consumer live-path proof (grep)
    { title: 'QA' },            // parallel dimension review + verify
    { title: 'Verify plan' },   // Vitest / manual-dev-app verification checklist (one entry per oracle)
  ],
}

// ---- Concurrency model (multiple deliveries at once) --------------------
// Deliveries run CONCURRENTLY: EVERY per-run artifact — charter, test-plan,
// coverage, AND the live status.md — lives under its own memory/Projects/
// deliver-<slug>/ dir. Each run writes ONLY its own folder, so there is no shared
// file to contend on. ACTIVE-DELIVERY.md is a DERIVED INDEX regenerated from those
// status.md files by scripts/gen-active-delivery-index.py (never hand-edited); a
// delivery drops off the index when its status.md Stage STARTS WITH "DONE".
// Adapted from the AptusFit/SSV `deliver` workflow: same rigor/artifact skeleton,
// retargeted to this repo's stack (pnpm/TS monorepo: Electron desktop + web apps +
// published packages) and tooling (grep for impact/wiring, Vitest + manual desktop
// dev-app pass for verification — no code-intel tool, no e2e harness, no external
// tracker).

// ---- WHY memory/ paths below start with "../" --------------------------
// This repo (hubble-source) is the PUBLIC GitHub repo tektrg/mdly — its own git
// checkout, nested inside the private, unpublished `markdown-lite-mac` project
// (which has no remote). That parent project already owns the PARA memory/ tree
// (see its .para-project marker) that this whole workstream's notes live in.
// Delivery artifacts (charter/test-plan/status/coverage) are internal shipping
// scratch, not product source — they must never land inside this repo's git
// history where a push could publish them. So every path below points ONE LEVEL
// UP, into the parent's memory/ and scripts/, never into this repo.

// ---- args contract -----------------------------------------------------
// args = {
//   item: string,                 // feature/fix description or ticket # (e.g. GH issue #)
//   kind: 'feature' | 'fix',
//   stage: 'plan' | 'validate',
//   changedFiles?: string[],      // required for stage:'validate'
//   spec?: object,                // plan-stage output, threaded back in for validate
//   decisionsResolved?: object,   // answers to any strategic forks from a prior return
//   testPlanPath?: string,        // override; else derived deterministically from item
//   charterPath?: string,         // override; else derived deterministically from item
//   size?: 'small' | 'standard',  // 'small' collapses the plan-stage panels (1 oracle
//                                 // agent, 1 designer, 1 QA critic) for tiny items —
//                                 // the four artifacts are written identically, only
//                                 // the depth of DELIBERATION scales, not the record.
// }
// The runtime may deliver `args` as a JSON STRING rather than a parsed object.
// Normalize defensively: parse when it's a string, tolerate a double-encode.
let A = args || {}
if (typeof A === 'string') {
  try {
    A = JSON.parse(A) || {}
    if (typeof A === 'string') A = JSON.parse(A) || {} // double-encoded guard
  } catch {
    A = {}
  }
}
if (!A || typeof A !== 'object') A = {}
const stage = A.stage || 'plan'
// Deliberation depth. 'small' shrinks the plan-stage fan-out (oracles/design/QA)
// for tiny items so a one-line fix doesn't spawn ~11 agents; the four persisted
// artifacts (charter/test-plan/pointer/coverage) are byte-identical in shape.
const size = A.size === 'small' ? 'small' : 'standard'

// Deterministic test-plan location: both stages (and the inline main-loop steps)
// compute the SAME path, so the MD written in `plan` is what `validate` reads.
// No Date/random (would break resume); slug is derived purely from the item text.
let slug = String(A.item || 'item').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
slug = slug.length === 64 ? slug.replace(/-[^-]*$/, '') : slug
if (!slug) slug = 'item'
const PLAN_PATH = A.testPlanPath || `../memory/Projects/deliver-${slug}/test-plan.md`
// The FROZEN source of truth: verbatim ask + spec snapshot + numbered rules + approved
// plan. Written once by the scribe, then NEVER edited (the test plan is the living doc;
// this is the anchor a long run re-reads to answer "what were we actually asked to build?").
const CHARTER_PATH = A.charterPath || `../memory/Projects/deliver-${slug}/charter.md`
// Per-run LIVE STATUS (source of truth): stage + narrative log for THIS delivery,
// written only by this run into its own folder — zero cross-delivery contention.
const STATUS_PATH = `../memory/Projects/deliver-${slug}/status.md`
// The DERIVED index of all deliveries (generated from every status.md; never
// hand-edited) — the grounding anchor a run reads after context loss to find its
// folder without already knowing its slug. Regenerated by the script below.
const POINTER_PATH = `../memory/Projects/ACTIVE-DELIVERY.md`
const INDEX_GEN = `../scripts/gen-active-delivery-index.py`
// Machine-readable rule ledger a report/review can read to ground itself in the requirement:
// per-rule {covered? proven? shipped?} + spec fingerprint (drift) + a runRecord the validate
// stage/main-loop stamp. The charter/test-plan are for humans; this is for machines to parse.
const COVERAGE_PATH = A.coveragePath || `../memory/Projects/deliver-${slug}/coverage.json`

// Every validate-stage agent (and implement/verify inline) grounds against these, in order:
// index (find the run's folder) -> charter (what we agreed to) -> test plan (how we prove it).
const GROUND = `If you don't know the run's file paths, READ ${POINTER_PATH} first — it is a
DERIVED index of ALL deliveries, one row each pointing at a memory/Projects/deliver-<slug>/
folder (relative to the markdown-lite-mac project root, one level up from this repo checkout);
find the row for this delivery (its folder is memory/Projects/deliver-${slug}/) and ignore the
others. That folder holds this run's charter, test-plan, coverage, and live status.md.
READ ${CHARTER_PATH} FIRST (the frozen original requirements, numbered rules R1..Rn, and
approved plan) — INCLUDING any "## Amendments (append-only)" section at its end, which
records user-approved changes to the original agreement and OVERRIDES the frozen body where
they conflict — THEN the test plan at ${PLAN_PATH}. Ground every finding/flow strictly
against the charter's rules (as amended) and the plan's case matrix — use the exact rule/oracle
IDs, and never drift past what the charter asked for. If a case has no matching charter rule
(scope creep) or a charter rule has no case (missed coverage), raise it as a decision rather
than silently proceeding. Do NOT invent cases outside the plan.`

// A phase returns { decisions: [{question, options, kind, recommendation}], ... }.
// Strategic decisions bubble up and END the run so the main loop can ask the user.
const strategic = (out) => (out?.decisions || []).filter(d => d.kind === 'strategic')

const DECISIONS = {
  type: 'object', additionalProperties: false,
  properties: {
    decisions: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['question', 'kind'],
      properties: {
        question: { type: 'string' },
        kind: { enum: ['strategic', 'tactical'] },
        options: { type: 'array', items: { type: 'string' } },
        recommendation: { type: 'string' },
      },
    }},
  },
}

const ORACLES = {
  type: 'object', additionalProperties: false,
  required: ['oracles', 'decisions'],
  properties: {
    oracles: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'description', 'redState', 'verifyAssertion', 'priority'],
      properties: {
        id: { type: 'string' },
        description: { type: 'string', description: 'user-visible pass condition' },
        redState: { type: 'string', description: 'how it currently FAILS: bug reproduces / AC absent' },
        verifyAssertion: { type: 'string', description: 'the observable oracle to assert — for a package/CLI change, a Vitest assertion on a return value or on-disk filesystem state; for an Electron desktop UI change, an observable state seen by manually running the dev app (pnpm dev:desktop). There is no browser/e2e harness in this repo — never phrase this as a browser or Playwright/Maestro check.' },
        priority: { enum: ['must', 'should', 'nice'] },
      },
    }},
    ...DECISIONS.properties,
  },
}

const DESIGN = {
  type: 'object', additionalProperties: false,
  required: ['recommended', 'rationale', 'livePathTrace', 'doorCensus', 'decisions'],
  properties: {
    approaches: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['name', 'sketch'], properties: {
        name: { type: 'string' }, sketch: { type: 'string' }, risks: { type: 'string' },
      }}},
    recommended: { type: 'string' },
    rationale: { type: 'string' },
    livePathTrace: { type: 'string', description: 'user action / external event -> the exact file(s) touched -> the exact function(s)/IPC handler(s) that run -> the persisted/rendered result, traced on the LIVE path through this repo\'s actual call graph (confirmed with git grep, not assumed)' },
    doorCensus: { type: 'string', description: 'Every entry path ("door") that reaches the target seam — ALL callers/importers of the seam symbol (via git grep across every app and package) + ALL writers/producers of the artifact across the repo, each marked wired/unwired; OR "single-door" + why no other caller produces this artifact.' },
    ...DECISIONS.properties,
  },
}

const FINDINGS = {
  type: 'object', additionalProperties: false,
  required: ['findings'],
  properties: { findings: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['summary', 'severity'], properties: {
      summary: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' },
      severity: { enum: ['blocker', 'major', 'minor'] },
    }}}},
}

const VERDICT = {
  type: 'object', additionalProperties: false,
  required: ['real', 'reasoning'],
  properties: { real: { type: 'boolean' }, reasoning: { type: 'string' } },
}

// This repo has NO code-intelligence tool — impact/wiring analysis is grep-based
// (see AGENTS.md / CLAUDE.md: "Impact tooling | grep-based."). Agents navigate the
// call graph with git grep / git log -S instead of a code-intel MCP tool.
const IMPACT_CTX = `Before reasoning about wiring or impact, there is NO code-intelligence tool in
this repo — navigate by search: \`git grep -n "<symbol>"\` for every reference across the whole
monorepo (not just the app named in the item), \`git grep -n "from ['\\"].*<module>"\` / \`git grep -n
"require(.*<module>"\` for importers, and read the file to see callees. \`git log --all -S
"<symbol>"\` surfaces historical producers/removals a plain grep of HEAD would miss.
Stack map: \`apps/desktop\` is the Electron desktop shell — \`apps/desktop/electron/*.ts\` is the
Node/Electron MAIN process (filesystem access, IPC handlers, file watchers), \`apps/desktop/src/*.tsx\`
is the renderer (React UI), talking to main via IPC (see \`apps/desktop/electron/preload.ts\` and
\`apps/desktop/src/desktopApi\`). \`apps/web\` and \`apps/notion-web\` are browser apps backed by Convex;
\`apps/www\` is the marketing site. \`packages/workspace-kit\`, \`packages/sync\`, \`packages/cli\` are
published npm packages consumed via \`workspace:*\` — a package-level change is only LIVE once every
app/package that depends on it (check each one's package.json) actually imports the changed export,
not just the one path named in the item.`

// Multi-door integrity gate: a promise fulfilled at a shared seam reachable from multiple
// entry paths ("doors") must enumerate EVERY door before it's plannable — wiring only the
// ticket's door is the recurring bug class. The design agent fills DESIGN.doorCensus; the
// plan stage halts if a >1-door promise arrives without one.
const DOOR_CENSUS = `DOOR CENSUS (required, put in DESIGN.doorCensus): name the shared SEAM this
change is fulfilled at (an IPC handler, a filesystem write path, a shared hook/component, an
exported package function) and the user-visible ARTIFACT it produces. Then enumerate EVERY entry
path ("door") that reaches that seam: run \`git grep -n "<seam symbol>"\` across the WHOLE repo
(every app and package, not just the one named in the item) to list every caller/importer, and
\`git log --all -S "<seam symbol>"\` for callers that existed historically. For each door, name the
user action that triggers it (an in-app save, an external file edit picked up by a watcher, an IPC
call, a CLI invocation, an autosave debounce, etc.) and whether this plan wires it. If the promise
reaches the user through ONE door only, write "single-door" and justify why no other caller produces
this artifact. If you CANNOT complete the census (unknown callers, ambiguous seam) on a promise that
plausibly spans >1 door, RAISE IT AS A STRATEGIC decision rather than guessing single-door.`

// Mine the project's own durable knowledge before proposing coverage, so cases reflect
// prior decisions/gotchas — not fresh reasoning alone.
const QA_MINE = `FIRST mine this project's durable knowledge before proposing cases:
- invoke the Skill tool for "memory-project" and search this project's memory/ PARA structure —
  it lives ONE LEVEL UP from this repo checkout, at the markdown-lite-mac project root (its
  .para-project marker is what anchors it there): memory/Resources for reference knowledge,
  memory/Projects for active initiatives (including other deliver-*/ folders and the existing
  hubble-* feature notes), memory/Areas for ongoing responsibilities.
- read CONTEXT.md and docs/adr/*.md at this repo's root for settled domain vocabulary and
  architectural decisions — do not silently contradict a frozen ADR; raise it as a decision instead.
- skim recent \`git log\` and existing *.test.ts files for this area for gotchas the plan must not regress.
Fold every relevant prior decision, gotcha, and existing behavior into your proposed cases instead
of re-deriving from scratch. If these are unavailable in your environment, say so and proceed from reasoning.`

// EXPLICIT-INVOKE, not name-drop: tell the agent to LOAD the real skill via the Skill tool.
const useSkills = (...skills) =>
  `FIRST invoke the Skill tool for each of these, in order — ${skills.join(', ')} — ` +
  `then perform the task strictly per their loaded instructions. Do not proceed before loading them.`

// ---- INLINE IMPLEMENT CONTRACT (main loop, between plan and validate) ----
// The workflow does NOT spawn the implementation — the main loop does it inline (stateful
// edits + Vitest/manual dev-app verification). This contract is surfaced in the plan-stage
// return so the main loop reads it right before implementing. Two hard rules, both learned
// from a real failure where a context-inheriting "fork" subagent echoed the run's status text
// back with ZERO tool calls and burned a cycle without writing a line of code:
//   1. DELEGATE TO A FRESH general-purpose AGENT, NOT A FORK. Give it a fully self-contained
//      prompt (the charter path, test-plan path, the exact files/rules to implement, and the
//      instruction to actually edit files). A context-inheriting fork can degenerate into
//      NARRATING the plan instead of DOING it. Never use `subagent_type:"fork"` for the
//      implement step. (Implementing directly in the main loop is also fine — the anti-pattern
//      is specifically the inheriting fork.)
//   2. NEVER TRUST THE AGENT'S SELF-REPORT — VERIFY WITH GIT. After the implement agent
//      returns, run `git status --porcelain` (and skim the diff). If it reports "done" but
//      NO files changed, it no-op'd: discard the report and re-dispatch a fresh agent with a
//      sharper, more explicit prompt. A green-sounding summary with an empty diff is a FAILED
//      cycle, not a completed one.
const IMPLEMENT_CONTRACT = `INLINE IMPLEMENT STEP (do this in the main loop before stage:"validate"):
1. Delegate to a FRESH general-purpose agent (Agent tool, subagent_type:"general-purpose") with a
   FULLY SELF-CONTAINED prompt — the charter + test-plan paths, the exact files/rules to build, and
   an explicit instruction to EDIT FILES, not describe them. Do NOT use a context-inheriting "fork":
   forks can degenerate into narrating the plan back instead of doing it (this exact failure has
   happened — a fork returned status text with 0 tool calls). Implementing directly in the main loop
   is equally fine; the banned pattern is the inheriting fork.
2. After the agent returns, VERIFY WITH GIT — never trust its self-report. Run
   \`git status --porcelain\` and skim the diff. If it claims done but the diff is EMPTY, it no-op'd:
   discard the report and re-dispatch a fresh agent with a sharper prompt. Only proceed to validate
   once real file changes exist that match the plan's expected scope.`

// ========================================================================
if (stage === 'plan') {
  // --- Oracles (red-first). Panel of 3 angles, then merge. -------------
  phase('Oracles')
  const angles = size === 'small'
    ? ['happy-path plus the single most likely edge/failure case']
    : ['happy-path', 'edge-cases & failure modes', 'regression risk on adjacent features']
  const oracleSets = await parallel(angles.map(angle => () =>
    agent(`mdly (the tektrg/mdly Electron-desktop + web Markdown-editor monorepo) ${A.kind} to deliver: "${A.item}".
Define the USER-VISIBLE pass conditions from the "${angle}" angle, oracle-first.
For each, state its RED state (fix: how the bug currently reproduces; feature: how the AC is currently absent)
and the observable assertion that proves it GREEN — a concrete Vitest assertion on a return value or on-disk
filesystem state for a package/CLI change, or an observable state in the running Electron desktop dev app
(\`pnpm dev:desktop\`) for a UI change. There is no browser/e2e harness in this repo — never propose one.
Only raise a decision as "strategic" if it is a genuine architectural/scope/trade-off fork for the user;
interpret everything tactical yourself.`,
      { label: `oracles:${angle}`, phase: 'Oracles', schema: ORACLES })))
  const oracles = oracleSets.filter(Boolean)
  const mergedOracles = {
    oracles: oracles.flatMap(o => o.oracles),
    decisions: oracles.flatMap(o => o.decisions || []),
  }
  if (strategic(mergedOracles).length && !A.decisionsResolved?.oracles) {
    return { stage: 'plan', halted: 'oracles', decisions: strategic(mergedOracles), oracles: mergedOracles.oracles }
  }

  // --- Design: N approaches -> judge -> live-path-traced plan ----------
  // Small items skip the 3-lens tournament: one designer produces the plan directly.
  phase('Design')
  const oracleList = mergedOracles.oracles.map(o => `- [${o.priority}] ${o.description}`).join('\n')
  let plan
  if (size === 'small') {
    plan = await agent(`${useSkills('coding-engineering-basics')}
${IMPACT_CTX}
${DOOR_CENSUS}
Design the single best implementation approach for "${A.item}" that satisfies these oracles:\n${oracleList}
Produce ONE recommended plan with a full live-path trace end-to-end (trigger -> code path -> persisted/rendered result).
Raise "strategic" decisions ONLY for real architectural/trade-off forks.`,
      { label: 'design:single', phase: 'Design', schema: DESIGN })
  } else {
    const sketches = await parallel(['MVP-first', 'risk-first', 'reuse-first'].map(lens => () =>
      agent(`${useSkills('coding-engineering-basics')}
${IMPACT_CTX}
${DOOR_CENSUS}
Design an implementation approach (${lens}) for "${A.item}" that satisfies these oracles:\n${oracleList}
Trace the LIVE user-visible path it will drive (trigger -> code path -> persisted/rendered result).`,
        { label: `design:${lens}`, phase: 'Design', schema: DESIGN })))
    plan = await agent(`${IMPACT_CTX}
${DOOR_CENSUS}
Given these candidate approaches, pick the best and graft the strongest ideas from the others.
Produce ONE recommended plan with a full live-path trace end-to-end.
Approaches:\n${JSON.stringify(sketches.filter(Boolean), null, 2)}
Raise "strategic" decisions ONLY for real architectural/trade-off forks.`,
      { label: 'design:synthesize', phase: 'Design', schema: DESIGN })
  }
  if (strategic(plan).length && !A.decisionsResolved?.design) {
    return { stage: 'plan', halted: 'design', decisions: strategic(plan), oracles: mergedOracles.oracles, plan }
  }

  // --- Door-census gate (multi-door integrity) --------------------------
  // A promise fulfilled at a shared seam reachable from >1 door is only plannable once
  // every door is enumerated. If the designer produced no census, surface it — never
  // assume single-door (that assumption IS the recurring bug class).
  if ((!plan.doorCensus || !plan.doorCensus.trim()) && !A.decisionsResolved?.doorCensus) {
    return { stage: 'plan', halted: 'door-census',
      decisions: [{ kind: 'strategic',
        question: 'Enumerate every door (caller of the seam symbol via git grep across the whole repo / producer of the artifact) the promise must reach, and confirm the plan wires each — or justify single-door.' }],
      oracles: mergedOracles.oracles, plan }
  }

  // --- QA (pre-implementation): harden the case list BEFORE any code -----
  // Independent reviewers whose ONLY job is to find edge cases / missed root causes /
  // adjacent-feature regressions the oracle + design panels were blind to. Their output
  // is ADDITIONAL oracles, merged in now so the test plan the scribe writes already
  // covers them. The oracle "edge-cases" angle GENERATES; this pass CRITIQUES.
  phase('QA (pre-impl)')
  const qaDimsAll = [
    'edge cases & failure modes the current cases miss (empty / boundary / error / permission-denied / concurrent-writer / offline states)',
    A.kind === 'fix'
      ? 'other plausible root causes the plan may have the wrong fix for'
      : 'unstated-but-implied requirements the plan overlooks',
    'side effects & regressions on adjacent features the plan could break',
  ]
  // Small items get one critic (the edge-case dimension); standard gets all three.
  const qaDims = size === 'small' ? [qaDimsAll[0]] : qaDimsAll
  const qaSets = await parallel(qaDims.map(dim => () =>
    agent(`${useSkills('qa-product-review')}
${IMPACT_CTX}
${QA_MINE}
PRE-implementation review of the plan for mdly ${A.kind}: "${A.item}". NO code is written yet.
Review dimension: ${dim}.
Find test cases the current set does NOT already cover, each phrased as a new oracle
(user-visible pass condition + its RED state + the observable assertion — a Vitest assertion or a
manual desktop-dev-app observation).
Give every new case a unique id prefixed "QA" (QA1, QA2, ...) so it won't collide with the ids below.
Do NOT restate cases already covered; return ONLY genuinely additional cases (empty list is a valid answer).
Raise a "strategic" decision only for a real architectural/scope/trade-off fork; interpret tactical yourself.
Approved plan:\n${JSON.stringify(plan, null, 2)}
Current cases (oracles):\n${oracleList}`,
      { label: `qa-pre:${dim.slice(0, 24)}`, phase: 'QA (pre-impl)', schema: ORACLES })))
  const qaHardening = qaSets.filter(Boolean)
  mergedOracles.oracles.push(...qaHardening.flatMap(q => q.oracles))
  const qaDecisions = qaHardening.flatMap(q => q.decisions || [])
  if (strategic({ decisions: qaDecisions }).length && !A.decisionsResolved?.qaPreImpl) {
    return { stage: 'plan', halted: 'qa-pre-impl', decisions: strategic({ decisions: qaDecisions }),
      oracles: mergedOracles.oracles, plan }
  }

  // --- Scribe: persist charter + test plan + status + coverage; regen index ---
  // Charter (frozen) + test plan (living) + status (findable) are the source of truth
  // every later step grounds against. The agent (not the workflow) owns all writes;
  // the main loop verifies them. No external test queue — everything stays in memory/.
  phase('Test plan')
  const INDEX_RESULT = {
    type: 'object', additionalProperties: false, required: ['indexRan'],
    properties: {
      indexRan: { type: 'boolean', description: 'true if the index generator ran successfully' },
      concurrentDeliveries: { type: 'number', description: 'OTHER in-flight deliveries: the generator\'s "N in-flight" count minus 1 (0 if you are alone, never negative)' },
    },
  }
  const resolved = A.decisionsResolved ? JSON.stringify(A.decisionsResolved, null, 2) : '(none — no strategic forks were raised)'
  const scribe = await agent(`You are writing FOUR files (three for humans, one machine-readable). Create parent dirs as
needed. Every path below is relative to THIS REPO'S ROOT (the hubble-source checkout) — the "../"
prefix is deliberate: it points into the memory/ tree of the parent markdown-lite-mac project, NOT
into this repo, because this repo is the public tektrg/mdly GitHub checkout and delivery scratch
must never enter its git history. Each fact below belongs in EXACTLY ONE of these files — do not
restate it in another.

=== FILE 1: ${CHARTER_PATH} — the FROZEN charter (write with Write; this file is NEVER edited again) ===
This is the anchor a long run re-reads to recall "what were we actually asked to build, and what did we approve?".
This is the ONLY place the requirements/rules live — the test plan links here instead of restating them.
Plain product language, no code jargon without a one-line gloss. Use EXACTLY this structure:

# Charter — ${A.item}
> ⚠️ FROZEN. This is the original agreement. Do NOT edit the body during the run. Status, cases, and run logs live in the test plan, not here.
> The ONE legal exception: requirements can legitimately change mid-run. When the user resolves a strategic decision that alters the agreement, APPEND a dated entry to the "## Amendments (append-only)" section at the bottom — never rewrite a rule above. The frozen body stays as the historical record; amendments override it where they conflict.

## The ask (verbatim)
Quote the request exactly as given, do not paraphrase:
"""
${A.item}
"""

## Source of truth
If the ask references an issue/PR (e.g. a GitHub issue #), spec, or any URL, put the link here AND
snapshot its current content below (paste the actual text — links rot and pages change).
If there is no external spec, write "No external spec — the ask above is the source of truth."
Then fingerprint the snapshot so a later review can detect the LIVE spec drifting away from what we
agreed to. Pipe the exact snapshot text through \`shasum -a 256\` and record the hash on its own line,
verbatim as:
  Spec-snapshot-sha: <the sha256 hash, or "none" if there is no external spec>
Also note the spec URL on its own line as \`Spec-link: <url or "none">\`. (You will copy both of
these — the link and the sha — into coverage.json in FILE 4 below; they must match exactly.)

## What we agreed to build
The approved plan in plain English: the recommended approach and why. Base it on:
${JSON.stringify(plan, null, 2)}

## Rules (R1...Rn)
Decompose the ask + approved plan into numbered, testable, plain-English rules (R1, R2, ...).
Also fold in any requirement IMPLIED by the edge-case / QA cases in the oracle set below (a "QA"-prefixed
case that tests a genuinely new requirement earns its own rule; one that just tests an existing rule more
deeply cites that rule). These are FROZEN with the charter — every test-plan case must cite one by id. A
test-plan case citing no rule here is scope creep; a rule here cited by no case is a coverage gap.

## Decisions the user resolved
Record every strategic fork and the chosen answer, so the run cannot silently re-decide them:
${resolved}

## Out of scope
Anything explicitly NOT part of this delivery (so scope creep is detectable later).

## Amendments (append-only)
Leave this section EMPTY at plan time — write exactly the line below and nothing else. It is the
ONLY part of the charter that may grow later, and ONLY when the user resolves a strategic decision
that changes the agreement. Each later entry is appended as: \`### A<n> — <date> — <what changed>\`
with the superseded/added rule ids and the user's chosen answer. Never edit a rule above; amend here.
_No amendments yet._

=== FILE 2: ${PLAN_PATH} — the LIVING test plan (write with Write) ===
STRUCTURE: a PRE-implementation checklist plan. Requirements/rules live ONLY in the charter above —
do not restate them here, link instead.
VOICE: plain product language for a reader who does NOT read code — no jargon without a one-line
plain-English gloss; every case decidable/reviewable without opening the repo.
Use EXACTLY these sections and headings:

# Test Plan — ${A.item}
Rules live in the charter (frozen): ${CHARTER_PATH} — cases below cite them by id (R1, R2, ...).

## At a glance
- What we're shipping: <one plain sentence, product terms>
- How we prove it: with real Vitest runs against real filesystem state (no mocks) for package/CLI
  rules, and a manual pass in the actual running desktop dev app (\`pnpm dev:desktop\`) for anything
  UI-visible — this repo has no browser/e2e harness. Proof = the actual test output or on-disk state,
  or a screenshot of the actual screen the user sees, never a developer's say-so.
- Status key: ☐ not tested yet · 🔴 confirmed broken now (reproduced before fixing — this is good, it proves the test is real) · 🟢 working after the fix, seen in the real test run/dev app · 🚧 not built yet (needs building first, not just testing) · ⚠️ partly working (say which piece is missing) · ⏸️ skipped on purpose (say why)

## Where we look to prove it
The exact Vitest test file(s) or the exact desktop-app screen/action the user reaches that show the result — one per way the result can be produced.

## Ways the result gets produced
Plain-language list of every path that creates the thing the user sees, and whether each one obeys its rule. A path that ignores the rule is a FINDING, not a skipped line. (This is the anti-"looks done but half-wired" check — cross-check it against the door census in the plan.)

## Case checklist
One checkbox per case. Every charter rule becomes at least one case. Format each as:
- [ ] **<ID> — <plain case name>** (priority: must/should/nice) — Status: ☐
  - Rule: <charter rule id, e.g. R3> — <plain English restated in one clause>
  - Set up: <what state to put the repo/app in, plain>
  - Should see: <the user-visible result, test output, or on-disk effect>
  - Where: <the Vitest test file, or the desktop-app screen/action>

## How we keep the test fair
Plain explanation of how we remove randomness (a fixed sample workspace folder, seeded test fixtures, a known file set, etc.) so the only thing that changes the result is the thing we're testing.

## Run log
Pure evidence appendix, NO status marks here (status lives only on the case checkbox line above):
<!-- appended during the run: date · case ID · evidence (test output excerpt / screenshot filename) -->

Coverage check: every charter rule (R1...Rn) has at least one case above — ☐ verified by scribe

Ground the cases on these oracles (use their ids as the case <ID>s), cross-referenced to the
charter rules you just wrote in FILE 1:
${JSON.stringify(mergedOracles.oracles, null, 2)}

Recommended plan (for the "Ways the result gets produced" + fairness sections):
${JSON.stringify(plan, null, 2)}

=== FILE 3: ${STATUS_PATH} — this run's LIVE STATUS (write with Write; YOUR folder only) ===
This is the source of truth for this delivery's stage + narrative. It lives in YOUR OWN folder,
so you never touch another run's file — no shared-file contention. Write EXACTLY this shape
(the "- Item:" and "- Stage:" bullets are parsed by the index generator, so keep them present
and keep the Stage line SHORT — one clause; put detail in the Log):
# Status — ${slug}
- Item: ${A.item}
- Charter: ${CHARTER_PATH}
- Test plan: ${PLAN_PATH}
- Coverage: ${COVERAGE_PATH}
- Stage: plan complete — implementing next

## Log
<!-- append dated one-liners as the run progresses; the Stage bullet above stays the short headline -->

THEN regenerate the derived index (do NOT hand-edit ${POINTER_PATH} — it is generated):
  python3 ${INDEX_GEN}
The script prints "... N in-flight, M closed ..." on its last line. Return (N - 1) as
concurrentDeliveries — the count of OTHER in-flight deliveries besides yours (0 if you're alone;
never negative), and indexRan=true if it succeeded. To CLOSE a delivery later, prefix its Stage
with "DONE —" and re-run the script; it then drops to the index's "Recently closed" tail
automatically — no manual section deletion.

=== FILE 4: ${COVERAGE_PATH} — the machine-readable rule ledger (write with Write) ===
This is NOT prose — it is JSON a later review parses to ground itself in the requirement without
scraping the charter/test-plan markdown. It exists so a review can join, per rule: covered? proven? shipped?
Write EXACTLY this shape (valid JSON, no comments, no trailing commas):
{
  "item": ${JSON.stringify(A.item)},
  "kind": ${JSON.stringify(A.kind || 'feature')},
  "charterPath": ${JSON.stringify(CHARTER_PATH)},
  "testPlanPath": ${JSON.stringify(PLAN_PATH)},
  "specLink": "<the Spec-link value from the charter Source-of-truth, or \\"none\\">",
  "specSnapshotSha": "<the Spec-snapshot-sha value from the charter, or \\"none\\" — MUST match the charter exactly>",
  "rules": {
    "R1": { "text": "<one-line plain rule text, copied VERBATIM from the charter>", "priority": "must|should|nice", "caseIds": ["<the test-plan case ids that cite R1>"], "status": "☐" },
    "...": "one entry per charter rule R1..Rn"
  },
  "runRecord": null
}
Rules: one key per charter rule (R1..Rn) you wrote in FILE 1 — the SAME set, so a rule with an
empty caseIds is a real coverage gap a review will surface. The "text" is a WRITE-ONCE denormalized
copy of the charter rule (the charter stays authoritative; this ledger is a derived cache). Both are
written once from the same rules and never edited, so they cannot drift. status starts "☐" for every
rule (nothing is proven at plan time). caseIds are the test-plan case ids (the oracle ids) that cite
that rule. Leave "runRecord" as null — the validate stage / main loop fills it in later.`,
    { label: 'scribe:test-plan', phase: 'Test plan', schema: INDEX_RESULT })

  // --- Verify-and-repair the scribe's four artifacts --------------------
  // One agent writing four files is the most fragile seam: a subagent Write can fail
  // silently, the JSON can be malformed, or the R-ids can drift between charter and
  // coverage. A whole delivery grounds against these files, so prove they exist and are
  // internally consistent NOW — and repair in place if not.
  const SCRIBE_CHECK = {
    type: 'object', additionalProperties: false, required: ['ok', 'problems'],
    properties: {
      ok: { type: 'boolean', description: 'true only if EVERY invariant below holds' },
      problems: { type: 'array', items: { type: 'string' }, description: 'one per failed invariant; empty if ok' },
    },
  }
  const INVARIANTS = `Invariants (ALL must hold):
1. ${CHARTER_PATH} exists; has the "⚠️ FROZEN" header, a non-empty "## The ask (verbatim)",
   a "## Rules (R1..." section with >=1 numbered rule, and an empty "## Amendments (append-only)".
2. ${PLAN_PATH} exists; has a "## Case checklist" with >=1 "- [ ]" case; EVERY case cites a
   charter rule id (Rule: R<n>); the closing Coverage-check line is present.
3. ${STATUS_PATH} exists; has an "- Item:" bullet, a "- Stage:" bullet whose value does NOT
   start with "DONE", and Charter/Test plan/Coverage bullets pointing at exactly ${CHARTER_PATH},
   ${PLAN_PATH}, ${COVERAGE_PATH}. AND the derived index ${POINTER_PATH} exists and lists a row
   for folder memory/Projects/deliver-${slug}/ (i.e. the generator ran).
4. ${COVERAGE_PATH} exists and is VALID JSON; its "rules" keys are EXACTLY the R-ids in the
   charter's Rules section (none missing, none extra); each rule's "text" matches the charter
   rule verbatim; "runRecord" is null.`
  const check = await agent(`Verify the delivery scribe's four artifacts are complete and mutually consistent.
Read each file and check the invariants. Report precisely — do not fix anything here.
${INVARIANTS}`,
    { label: 'scribe:verify', phase: 'Test plan', schema: SCRIBE_CHECK })
  if (check && check.ok === false && (check.problems || []).length) {
    await agent(`The delivery scribe's artifacts violate these invariants:
${check.problems.map(p => '- ' + p).join('\n')}
Fix ONLY what is broken. Do NOT touch anything already correct, and preserve the FROZEN charter
body verbatim (you may only add the empty Amendments line if it is missing). After fixing, re-run
python3 ${INDEX_GEN} if invariant 3's index row is what was broken. All of these must then hold:
${INVARIANTS}
Return the word "ok".`,
      { label: 'scribe:repair', phase: 'Test plan' })
  }

  return { stage: 'plan', complete: true, oracles: mergedOracles.oracles, plan,
    charterPath: CHARTER_PATH, testPlanPath: PLAN_PATH, statusPath: STATUS_PATH,
    pointerPath: POINTER_PATH, coveragePath: COVERAGE_PATH, size, slug,
    scribeVerified: check ? check.ok !== false : null,
    concurrentDeliveries: scribe?.concurrentDeliveries ?? 0,
    // How the main loop must run the inline implement step (fresh agent, not a fork; verify
    // with git before trusting the report). Read this BEFORE implementing, then run validate.
    implementContract: IMPLEMENT_CONTRACT }
}

// ========================================================================
if (stage === 'validate') {
  const files = (A.changedFiles || []).join(', ') || 'the current working-tree diff'
  const oracleList = (A.spec?.oracles || []).map(o => `- ${o.id}: ${o.verifyAssertion}`).join('\n')

  // Fan out wiring + QA + verification-plan concurrently; verify wiring adversarially.
  const [wiring, qa, verifyPlan] = await Promise.all([
    // Wiring: prove producer->consumer live (grep), then adversarial refute.
    (async () => {
      phase('Wiring')
      const found = await agent(`${GROUND}
${IMPACT_CTX}
Trace every producer/consumer seam introduced by the change in: ${files}.
For each, use git grep / reading the code to confirm producer -> write path/IPC handler/exported
function -> consumer -> user-visible effect is wired on a LIVE path (e.g. an Electron main IPC
handler whose result the renderer actually calls, or a package export an app actually imports —
not just declared). Cross-check against the plan's door census: every door named there must
actually be wired.
Flag any orphan-producer, consumer->dead-path, unwired door, or half-merged seam as a finding.`,
        { label: 'wiring:trace', phase: 'Wiring', schema: FINDINGS })
      const verified = await parallel((found?.findings || []).map(f => () =>
        agent(`Adversarially try to REFUTE this wiring finding (default real=false if the seam is actually live): ${f.summary}`,
          { label: `wiring:verify`, phase: 'Wiring', schema: VERDICT }).then(v => ({ ...f, verdict: v }))))
      return verified.filter(Boolean).filter(f => f.verdict?.real)
    })(),
    // QA: parallel dimensions (codifies the "qa 3x" habit).
    (async () => {
      phase('QA')
      const dims = ['correctness vs the oracles', 'edge cases & error states', 'UX polish & regressions']
      const revs = await parallel(dims.map(d => () =>
        agent(`${useSkills('qa-product-review')}
${GROUND}
Review the change in ${files} as a senior engineer for this dimension: ${d}.`,
          { label: `qa:${d}`, phase: 'QA', schema: FINDINGS })))
      return revs.filter(Boolean).flatMap(r => r.findings)
    })(),
    // Verification plan: one Vitest run or manual dev-app check per oracle. AUTHORING only —
    // the main loop DRIVES it inline (runs `pnpm test`/`pnpm --filter <pkg> test`, or manually
    // exercises the running desktop dev app) and captures the proof. No e2e framework is
    // authored here — this repo has none.
    (async () => {
      phase('Verify plan')
      return agent(`${GROUND}
Produce a concrete VERIFICATION CHECKLIST the main loop will execute inline to prove each oracle
GREEN. This repo has NO browser/e2e harness (no Playwright, no Maestro) — never propose one;
verification is always either an automated Vitest test or a manual desktop-dev-app pass.
For a packages/* or CLI oracle: name the exact Vitest test file + the exact command
(\`pnpm --filter <pkg> test\`, or \`pnpm test\` for the whole workspace) and the exact assertion
(return value / on-disk file content) that proves it.
For an apps/desktop (Electron) UI oracle: name the exact steps to reproduce in the running dev app
(\`pnpm dev:desktop\`; rebuild+reinstall first with \`pnpm install:dev-app\` if the change needs a
fresh build) — the menu/action to trigger, and the exact on-screen or on-disk result to
observe/screenshot as proof.
For each item say which oracle id it proves and its RED->GREEN transition.
Return the checklist as markdown; do NOT execute anything.\n${oracleList}`,
        { label: 'verify:author', phase: 'Verify plan' })
    })(),
  ])

  const blockers = [...wiring, ...qa].filter(f => f.severity === 'blocker' || f.verdict)

  // Persist a runRecord into the coverage ledger so a later review can read what this
  // validation found WITHOUT the workflow transcript. Merge (don't clobber): the main loop
  // stamps passes/verified per oracle after driving the checklist; we only fill the fields
  // this stage owns (wiring verdict, blockers, verdict) and leave the rest untouched.
  const runRecordJson = JSON.stringify({
    wiredToLiveReader: wiring.length === 0,
    wiringFindings: wiring.map(f => f.summary),
    blockers: blockers.map(f => f.summary),
    verdict: blockers.length ? 'blocked' : 'clean',
  })
  await agent(`Update the machine-readable coverage ledger at ${COVERAGE_PATH} with this validation's result.
Read the file (if it does not exist, this delivery predates the ledger — create a minimal one with just item + runRecord).
Parse it as JSON. Set its top-level "runRecord" object by MERGING these fields in — do NOT delete or
overwrite keys the main loop may have already written (e.g. passes, verified), only set/replace these:
${runRecordJson}
Write the file back as valid JSON (no comments, no trailing commas). Do not touch any other key
(rules, specSnapshotSha, etc. stay exactly as they are). Return the word "ok".`,
    { label: 'validate:persist-runrecord', phase: 'QA' })

  return { stage: 'validate', complete: true, wiring, qa, blockers, verificationChecklist: verifyPlan,
    coveragePath: COVERAGE_PATH, runRecord: JSON.parse(runRecordJson) }
}

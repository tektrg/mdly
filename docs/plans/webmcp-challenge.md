# Plan — OpenAI WebMCP Challenge entry

**Status:** approved 2026-08-27. Hard deadline **2026-09-03 13:00 PDT**.
Entry surface: a new public web app. Everything here is contest-scoped; the
desktop tracks in [[local-doc-history.md]] and [[local-doc-comments.md]] continue
afterwards and share the same packages.

## The pitch

> **mdly agent margins** — a markdown workspace where an agent works *in the
> margin*, not over your shoulder. It reads your documents, leaves anchored
> comments, answers yours, and *proposes* edits you accept or reject region by
> region. Nothing it writes lands until you say so.

Why this fits the brief ("humans and agents interact, collaborate, and create
together"): the collaboration is **bidirectional and durable**. The agent is a
participant in a comment thread, not a command target. Its edits are proposals
in a review queue, not silent writes. Close the tab and the conversation is
still there.

## Contest facts that constrain the build

| | |
| --- | --- |
| Submit by | **Sep 3, 1:00pm PDT** (registration closes the same moment) |
| Judged | Sep 4–21; winners Sep 23 |
| Prize | Top 10 × ($3,000 + Codex Micro + ChatGPT Pro 1yr + partner credits) |
| Criteria (equal weight) | WebMCP Leverage · Execution · Potential Impact · Creativity & Ambition |
| Surface | **Live public URL**, testable in ChatGPT desktop's in-app browser or Chrome ≥149 with `chrome://flags/#enable-webmcp-testing` |
| API | `document.modelContext.registerTool({ name, description, inputSchema, execute })` |
| Repo | Public, **open-source license detectable in the GitHub About box** — satisfied: MIT, `d7b4f0d` |
| Video | <3 min, public on YouTube, audio narration, shows it working |
| Prior work | Allowed, but **scored only on work committed after Aug 25 11:00 PT**. Must document the prior/new split with dated commits |

**Execution is explicitly scored against proofs of concept** — the rules say
"complete, coherent product experience — not just a technical proof of concept".
Polish is not optional garnish here; it is 25% of the score.

### What counts as new work

Prior (does **not** score): `packages/doc-history` (Aug 17), the kit's diff/history
UI, the desktop editor. New (scores): everything in this plan. The README must
state this split plainly with commit hashes — the rules require it, and hiding it
risks disqualification.

## Why not the app already deployed

`apps/notion-web` is live at `mdly.theindie.app`, but it opens on a **Connect
Notion** OAuth screen. A judge would need a Notion account and would have to grant
a third-party OAuth scope before seeing anything. That is a losing first ten
seconds. We build a separate app that opens straight into a working document.

## Architecture

New app **`apps/agent-web`** — small Vite SPA, static assets on Cloudflare, its
own subdomain. No Worker logic, no auth, no backend. Reuses `@mdly/workspace-kit`
for the editor and navigation (precedent: `notion-web/src/shell/EditorPane.tsx`
already imports `EditorView` from the kit).

Three layers:

1. **Browser workspace store** — documents and comments in OPFS/IndexedDB behind
   the existing six-method `DocHistoryFileSystem` seam
   (`packages/doc-history/src/fs.ts`). That seam exists precisely so a
   non-Node consumer can plug in; this is its first real use. Same on-disk
   *layout* as desktop: `.mdly/history/`, `.mdly/comments/<docId>.jsonl`.
2. **Seeded demo workspace** — first load writes 3–4 realistic documents with a
   couple of pre-existing comment threads, so a judge who clicks the link is
   instantly in a live workspace with something to talk about. **Zero friction is
   a scoring requirement, not a nicety.**
3. **WebMCP tool surface** — registered on `document.modelContext` at mount.

### Optional: "Open my real folder"

Chrome's File System Access API (`showDirectoryPicker`) points the same store at a
real local folder — the *same* `.mdly/` workspace the desktop app uses. This is
the strongest moment in the demo: the agent in the browser comments on files that
are actually on your disk. **Treat it as a bonus, not the demo path** — it is
unverified in ChatGPT's in-app browser, and judges have no folder of ours to open.
Demo workspace is the primary path; the folder picker is the closing flourish.

## Tool surface

Reads carry `readOnlyHint`. **Everything returning document text carries
`untrustedContentHint`** — the document is user content and may contain text aimed
at the agent. Say this out loud in the video; it is a real safety property and
most entries will not have thought about it.

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_documents` | read | Titles, ids, last modified |
| `read_document` | read | Full markdown + its open threads |
| `search_documents` | read | Full-text across the workspace |
| `list_threads` | read | Open threads, filterable to ones awaiting the agent |
| `comment_on_range` | write | Anchor a comment to a quoted span |
| `reply_to_thread` | write | Answer a human (or its own) thread |
| `resolve_thread` | write | Close a thread |
| `propose_edit` | write | Suggest replacement text for a range — enters the review queue, **does not apply** |

`propose_edit` is the centrepiece. It reuses `diffRegions` / `groupChangeRegions` /
`mergeSelectedRegions` already shipped in `packages/doc-history`, rendering the
proposal as the existing per-region accept/reject diff UI. The agent has **no tool
that mutates document text directly** — that asymmetry is the product argument and
should be stated as a deliberate design choice.

## Schedule — 6 build days

| Day | Deliverable | Done means |
| --- | --- | --- |
| **Fri Aug 28** | App skeleton + browser store + seeded demo, **deployed** | A public URL opens a real document. Ship on day 1 even if bare — never leave deployment to the end |
| **Sat Aug 29** | Comment threads: store, margin UI, anchoring | Human can leave, reply to, resolve a comment; survives reload |
| **Sun Aug 30** | WebMCP registration + all four read tools + the three comment tools | An agent in Chrome 149-flag comments on a doc and the margin updates live |
| **Mon Aug 31** | `propose_edit` + per-region accept/reject review queue | Agent proposes, human accepts one region and rejects another |
| **Tue Sep 1** | Verify in **ChatGPT desktop in-app browser**; polish; folder-picker mode if time | Full flow works in the judged surface, not just Chrome |
| **Wed Sep 2** | README (prior/new split, setup, tool docs) + record video | Video <3min, uploaded public, audio narration |
| **Thu Sep 3 (am)** | Submit with hours to spare | Devpost form complete before 13:00 PDT |

Day 5 is deliberately the ChatGPT-browser day. Its behaviour may differ from
Chrome's and we must not discover that on the 3rd.

## Risks

| Risk | Handling |
| --- | --- |
| ChatGPT in-app browser lacks File System Access | Demo workspace is the primary path; folder mode is additive |
| ChatGPT in-app browser differs from flagged Chrome | Dedicated verification day (Sep 1), not a final-day check |
| Comment anchoring is subtle (revision-replay + quote fallback) | Ship quote+prefix/suffix matching with an explicit **orphaned** state; skip revision-replay re-anchoring unless days run ahead |
| Scope creep into sync / multi-user | Out of scope. No server, no auth, no accounts. Single browser, single human, one agent |
| Model capability on a 6-day build | The build should not run on a flash-tier model |

## What only Trung can do

1. **Register on Devpost** before Sep 3 13:00 PDT — account creation is his.
2. **Record the video** — it needs his voice and his framing of the problem.
3. Confirm the subdomain for the new app.
4. Optionally request the 3,000 free Netlify credits (form closes **Sep 1, 12:00 PT**) — not needed if we stay on Cloudflare.

## Out of scope

Cloud sync, auth, multi-user presence, the desktop `file://` origin work, mobile.
The desktop WebMCP spike stays paused until after the 3rd — an Electron app cannot
be a submission.

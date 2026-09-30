# Upstream review 3 — ExpenseOS `09cb43ed` → `87b0d546`, 94 commits

30 September 2026. Triaged against **what VeloExpense is about to build**, not against
what upstream did — so the ordering here is VeloExpense's roadmap, and a large, impressive
upstream subsystem can still land in "not needed".

Standing constraints for this review, from John, 30 Sep: **mobile is required** (it was
always planned; it came off the website only because it did not exist). **Deep NetSuite is
not required.** **QuickBooks, Sage and Xero are required.**

---

## The two findings that reorder everything

**1. The three integrations you need have nothing to port.** `packages/` contains exactly
two integration packages — `integrations-google` and `integrations-netsuite`. A search
across `packages/` and `apps/` returns **zero hits for Xero, zero for Sage, and zero for
QuickBooks**. VeloExpense's QuickBooks adapter was built fresh in Phase 3 rather than
ported, and Xero and Sage are net-new work with no upstream reference. Meanwhile the
single largest investment in this delta — roughly twenty commits of NetSuite employee
sync, attachments, category resolution, subsidiary mapping and a RESTlet — is the part you
have just ruled out.

**The porting relationship is inverting.** For the first two reviews, upstream was ahead on
things we wanted. On this one, upstream's centre of gravity has moved to a NetSuite
integration for one customer, and our roadmap has moved to a multi-vendor accounting
story upstream does not have. Expect review 4 to be thinner still, and plan the accounting
adapters as original work rather than as a port.

**2. Upstream's receipt extraction is already Claude-backed — on `claude-sonnet-5`, with a
Batch API path.** `packages/receipt-extraction/src/determination.ts` imports
`@anthropic-ai/sdk`; `extract-core.ts` resolves an `anthropic: { apiKey, model }`
credential; there is an `anthropic.ts` handler and an `extractCoreAnthropic.test.ts`.

This is the most valuable thing in the delta by a wide margin. The task is not "port the
shape and write a Claude call" — it is "port a Claude extractor that has already been
through a production provider outage, a UAT cycle, and a batch-latency design argument."

---

## Bucket 1 — port before you build the same thing

### 1a. Receipt extraction — read this before writing a line

| Commit | Why it matters here |
|---|---|
| `fix(worker): retry a receipt the provider was too busy to read (UAT A14)` | **The one to read first.** |
| `feat(expenses): hold the submit while a receipt is still being read` | The UX contract that makes batch viable. |
| `fix(upload-size-enforced): bind upload size and cap every worker read` | Image size is the dominant term in vision-model cost. |
| `security(expenses): hold the approval line on receipts, extraction, FX and tax` | Extraction state gates approval, not just submit. |
| `feat(pwa-receipt-camera): take a receipt photo on a phone` | The mobile × receipt intersection. |

**The A14 retry is a defect we would otherwise have shipped ourselves.** On 31 Aug their
extraction provider hit its daily cap and two receipts settled permanently as "Extraction
failed"; a human raised the cap and re-ran them, and *nothing in the system would have.*
The cause is worth quoting because it is a shape this project keeps meeting:
`runDocumentExtraction` was best-effort by design — it caught everything and returned, so
the BullMQ job always succeeded and **the five configured retry attempts were never
spent.** A 429 and a malformed PDF settled identically.

Their fix introduces `isTransientExtractionFailure`, classifying on **HTTP 429, 529 and
5xx**, plus messages carrying *rate limit / overloaded / quota / credit balance / daily
limit / too many requests*, plus ordinary network failures. Note what that list is: 529 is
Anthropic's overloaded status and "credit balance" is an Anthropic error string. **The
classifier is already written against the Claude API.** Transient with attempts left keeps
the row PENDING and re-throws so the queue spends an attempt (five, 60s backing off to
60min); the final attempt settles FAILED. The row carries the provider's own words in
`pendingReason`, so a person can tell whether to raise a cap.

Port the classifier close to verbatim. We will hit the same 529s.

**`extractionInFlight.ts` is the second one to read, and it corrects something in our own
pricing strategy** (see the last section). It answers "may this report be submitted while a
receipt is still being read", with a 15-minute staleness release measured from `updatedAt`.
Two details worth keeping:

- PENDING *with* an error never blocks. That is their no-API-key contract — a receipt still
  uploads, previews and can be typed over when extraction is not configured. VeloExpense
  needs exactly this, because extraction will be off for every tenant until it ships.
- The 15-minute cap exists specifically because the **Batch API parks rows at EXTRACTING
  for up to an hour**. They chose to release the submit and let the late result be refused
  by the editable-report guard, rather than hold a report for an hour.

### 1b. Mobile — a complete, documented programme, and we have nothing

Confirmed as required. Upstream shipped roughly fifteen `pwa-*` commits plus supporting
work, and unusually for a port, **the reasoning is written down**: nine ADRs
(`docs/adr/0002`–`0009`), `docs/design/pwa.md` at 1,959 lines, and `tasks/pwa.md`.

Core surface, ~1,450 lines excluding tests:

| File | Lines | What |
|---|---|---|
| `mobileReadiness.ts` | 875 | An app-side registry of per-route disposition — ready / limited / desktop-only |
| `sw/workerSource.ts` | 230 | The service worker. ADR 0004: **network-only**, deliberately |
| `lib/installPrompt.ts` | 227 | Install affordance, with ADR 0006 on the signals |
| `app/sw.js/route.ts` | 71 | Serves the worker |
| `app/manifest.ts` | 43 | Manifest |

Plus `DesktopOnlyNotice`, `SectionNotice`, `SmallScreenNotice`, `useCoarsePointer`,
`useIsBelowLg`, a breakpoints token set, a `DataTableCards` stacked-card renderer for
below 768px, and a CI guard (`check-phone-projects.mjs`) with a phone-sized crawl gate.

**The architectural decision worth adopting before any code** is ADR 0005: small-screen
route disposition is *an app-side registry*, not a per-page judgement. That is the same
argument as `lib/modules/registry.ts` — a policy an enumerating guard can check beats a
policy each page remembers. VeloExpense has ~30 routes; deciding each one's disposition in
a registry with a test is a day, and it is what stops "mobile" meaning "some pages
happen to reflow".

Caveat on portability: their shell is `[locale]/(app)/` with next-intl routing and a
`DataTable` VeloExpense does not share. The ADRs and `mobileReadiness.ts`'s *shape* port
cleanly; the components do not. Budget this as **informed original work**, not a copy.

---

## Bucket 2 — defects in code VeloExpense already ported

These are the cheap wins. Each is a bug in a package we took.

**VERIFIED 30 Sep against VeloExpense's actual code, after the first version of this
table asserted ports that do not exist.** Three of the nine do not apply, and in each case
I had inferred VeloExpense's contents from ExpenseOS's structure rather than reading ours.
That is the third instance of that error today (the others: a NetSuite adapter I claimed
shipped, and Canadian tax handling I called built). The pattern is now explicit enough to
state as a rule: **this product's resemblance to its predecessor is not evidence about its
contents.**

| Upstream fix | Verified status in VeloExpense |
|---|---|
| `fix(policy): serialize the violation swap per report` | **APPLIES — different shape, real.** See below. |
| `fix(rbac): system roles were frozen at the permission set they were created with` | **DOES NOT APPLY.** There is no permission registry and no system-roles table. Roles are a three-value `EMPLOYEE_ROLES` enum with `APPROVER_ROLES` derived from it. Nothing can freeze. |
| `security(fx): bound a hand-entered rate by the pair's last row` | **DOES NOT APPLY.** `lib/money.ts` has no manual or override rate concept — rates come from the Bank of Canada feed only. |
| `security(seed): never write a committed password` / credential-change audit | **DOES NOT APPLY.** VeloExpense is invite + SSO and has no passwords. The only password strings in `scripts/seed.mjs` are the comment explaining why ExpenseOS's six known-password accounts were a disaster. |
| `fix(i18n): the browser was choosing the language, not the default` | **UNREACHABLE TODAY.** `lib/i18n/resolve.ts` has the same precedence upstream had when the bug bit — Accept-Language at #4, ahead of `DEFAULT_LOCALE` at #5 — but IL-2 already recorded that `resolveLocale` has no non-test callers here. Re-check when it is wired. |
| `fix(upload-size-enforced)` + `storage/limits.ts`, `guardedRead.ts` | **OPEN.** `MAX_RECEIPT_BYTES` (20 MB) exists and `confirmUpload` HEADs for the real size rather than trusting the client, which is the better half. Whether an oversize object is *rejected* is unchecked. |
| `security(expenses): refuse to rewrite a decided report's total` / `put the determination's writes under the report lock` | **OPEN.** Did not resolve cleanly from a grep; needs a proper read of the lifecycle guards. |
| `security(audit): hash-chain every credential change and every delegation` | **PARTIAL.** `DELEGATION_CREATED` / `DELEGATION_REVOKED` are already in `AUDIT_ACTIONS`; credential changes do not exist. The real gap in our catalogue remains the missing `REPORT_SUBMITTED`, found during the entitlement work. |
| `security(approvals): the override is a permission of its own, not read.all` | **OPEN.** Needs checking against `lib/auth/admin-guard.ts`. |

### The one real finding: the violation swap can fail a legitimate save

`revalidate` in `lib/policy/service.ts` reads the existing violations for a report, then
deletes, updates and inserts to match. Two concurrent validations of the same report both
read the same `existing` set, both find the same key missing, and both INSERT.

**Our exposure is better than upstream's and still wrong.** Upstream duplicated rows;
we cannot, because `policy_violation_identity_idx` is UNIQUE over
`(report_id, rule_code, COALESCE(line_item_id, '000…'), finding_key)`. The invariant holds.
What happens instead is that the losing transaction dies on a **23505** and the person
sees an unexplained failure on a legitimate action — two tabs, or an autosave racing a
manual save. No report lock is taken anywhere in the validation path; the only `FOR UPDATE`
in `lib/` are on `organization` for the report sequence and in the audit chain.

Do **not** port upstream's serialization. The smaller fix that matches the invariant we
already have is `ON CONFLICT … DO UPDATE` on the insert — and note it must name the index
*expression*, `COALESCE(line_item_id, '00000000-0000-0000-0000-000000000000'::uuid)`, not a
plain column list, or it will not match the index and will not fire. A per-report advisory
lock, in the shape `lib/audit/chain.ts` already uses per org, is the alternative.

---

## Bucket 3 — not needed, but two lessons are

The ~20 NetSuite commits, the E Inc roster (`employee-convergence.json`, 22,590 lines), GL
repointing, QA account coding, and the infra work (GitHub OIDC deploy, Renovate) are all
out of scope. Two things to take anyway, neither of which is code:

**`fix(netsuite): post the expense report on the approval's Toronto day, not its UTC day.**
A posting dated by UTC lands in the wrong period for anything approved after 8pm Eastern.
That generalises to **every** accounting integration — QuickBooks, Sage and Xero included —
and it is a period-close defect a customer finds, not CI. Worth writing into the adapter
contract before building two more adapters.

**`security(rds): stop Postgres from logging bind parameters to CloudWatch.**
Bind parameters are the row values. A managed-Postgres default was writing tenant data into
a log sink with different retention and different access control from the database. That is
a live consideration for VX5-17 (tenant-aware observability), whose own brief already says
*"no log line carries a tenant's data"* — this is the instance of that rule nobody thinks of.

Also noted, not actionable: `security: remove workflow planted via compromised eincbot
token`. Upstream had a CI token compromised and a workflow planted. Our CI is separate, but
it is a reason to look at what `velotechsystems` tokens can do.

---

## A correction to our own pricing strategy

`VeloExpense-Pricing-Strategy-2026-09.md` Section 4 says the Batch API's 50% discount
**does not apply** to receipt extraction, because "a user waiting for their receipt fields
is not a batch workload."

Upstream shows that is a design choice rather than a fact. They run extraction through the
Batch API and buy the latency with a UX contract: the submit *holds* while a receipt is
being read, the submitter is told what it is waiting for, and a 15-minute staleness cap
releases the hold if the batch is slow. `extractionInFlight.ts` is that contract.

**If VeloExpense adopts the same pattern, receipt AI COGS halves** — the two-pass blended
$0.005 becomes ~$0.0025, which is roughly back to the multi-vendor figure the first draft
assumed and would recover the ~3 points of margin the all-Claude decision cost at every
tier. The trade is that a receipt is not read instantly, and the submit waits.

That is a real fork and it belongs to you, not to me. It is worth taking before the
extraction work starts, because the batch path and the synchronous path are different
builds, not a flag.

---

## Suggested order

1. **Read `extractionInFlight.ts` and the A14 retry commit**, then decide the batch-vs-
   synchronous fork above. Half a day, and it sets the shape of the feature and its COGS.
2. **Port the transient-failure classifier** as part of the extraction build. Near-verbatim.
3. **Bucket 2 is now one confirmed finding, not nine.** Fix the violation-swap insert with
   `ON CONFLICT` on the index expression — an hour. Then close the three still-open items
   (upload-size rejection, decided-report total, approval override) by reading rather than
   grepping, which is what the first pass got wrong.
4. **Adopt ADR 0005's registry shape** before any mobile code, then build the mobile
   programme as original work informed by their ADRs.
5. **Plan QuickBooks / Sage / Xero as original work.** Nothing upstream helps. The adapter
   contract already exists in `lib/integrations/contract.ts`; the Toronto-day lesson above
   belongs in it before the second and third adapters are written.

*Source: `carmigo/ExpenseOS` at `87b0d546`, 94 commits since `09cb43ed`. Previous reviews:
`5a11a647`→`b9e242d7` (24 commits, PR #79) and `b9e242d7`→`09cb43ed` (61 commits, 6 Sep).*

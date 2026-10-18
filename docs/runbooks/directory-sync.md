# Google Workspace directory sync — runbook

How a tenant connects its Google Workspace so people's names, departments, managers, job
levels and departures stay current, what a run does, and how to tell when it went wrong.

> **VeloExpense-written.** ExpenseOS has no runbook for its directory sync; the behaviour
> below is its code (`packages/integrations-google`, `apps/worker/src/handlers/directory-sync.ts`,
> 1e682dd6), with VeloExpense's differences (w5-04, d84) called out:
>
> - **Each tenant connects its own Workspace.** ExpenseOS syncs one Workspace from two
>   environment variables. Here an organization's administrator pastes a service-account key
>   file and an admin address at **/admin/directory-sync**; they are stored per tenant in
>   `google_directory_connection` (migration 0076), the key encrypted.
> - **Update only.** ExpenseOS creates a person for every Directory account it lacks. VeloExpense
>   never creates anybody: people join by invitation and take a paid seat.
> - **Status moves one way.** Suspended or archived in Workspace → deactivated here, exactly as
>   an administrator's Deactivate (sign-in refused, seat released, open reports to the manager).
>   An active Workspace account never reactivates anybody, and ON_LEAVE is never cleared. The
>   tenant's last active administrator is never deactivated by the sync.

| What | Where |
|---|---|
| Sign-in to Google and the users.list call | `packages/integrations-google/src/client.ts` |
| Google's payload → one person's fields | `packages/integrations-google/src/mappers.ts` |
| Writing one person (update only, one way) | `packages/integrations-google/src/apply.ts` |
| Paging the directory, the counts | `packages/integrations-google/src/syncAll.ts` |
| The job, the roll-up, the audit row | `worker/src/handlers/directory-sync.ts` |
| The tenant's stored connection | `lib/directory/googleConnection.ts` |
| The screen | `app/admin/directory-sync/` |

## 1. Connect

1. Google Cloud console: enable the **Admin SDK API** on a project.
2. Create a **service account**, then a **JSON key** for it. Google downloads the file.
3. Note the service account's **Client ID**.
4. Workspace Admin console → Security → Access and data control → API controls →
   **Manage Domain Wide Delegation** → Add new: the Client ID and the scope
   `https://www.googleapis.com/auth/admin.directory.user.readonly`. Read-only: the sync cannot
   change anything in Workspace.
5. At /admin/directory-sync, paste the whole key file and the address of a Workspace
   administrator for the service account to act as. The key is checked as it is saved (valid
   JSON, a `client_email`, a `private_key`), encrypted, and never shown again.
6. **Test connection** signs in and reads one person. **Sync now** queues a run for this
   tenant; the nightly run is at 03:00 UTC.

## 2. What a run does

For each Directory account, matched to a person here by email (any letter case):

- writes first and last name, photo and country when Directory has them; a blank leaves the
  field alone;
- department, business unit and legal entity: matched by English label, then (business unit,
  legal entity) by an external-id alias; **a miss changes nothing and creates nothing**;
- manager: the person here with that address, if exactly one; never themselves; a missing
  relation changes nothing;
- job level from the title (`titleToJobLevelCode`), when this organization has a level with
  that code;
- suspended → DEACTIVATED, archived → TERMINATED (with the deletion date), `deleted_at`
  stamped — unless the person is the last active administrator, who is **held**.

Then every deactivated or terminated person with open reports and a manager has those reports
moved to the manager, one summary audit row is written (`DIRECTORY_SYNCED`, naming whom it
deactivated), and the run's counts are put on the connection row for the screen. If anybody
was deactivated, the seat count is pushed to the platform.

## 3. Reading the last run

| On the screen | Meaning |
|---|---|
| In your directory | accounts Google returned |
| Updated here | people matched and written (even if nothing changed) |
| Deactivated | people this run offboarded |
| Not here, left alone | Directory accounts with no person here — expected |
| Not deactivated | the last active administrator, suspended in Workspace |
| Errors | people whose write failed; the rest of the run carried on |
| Titles with no job level | no rule recognized the title |
| Job levels this organization does not have | the title mapped to a code with no level here — add it under Job levels |

A **Failed** run shows Google's own message. The common ones:

- `unauthorized_client` — domain-wide delegation was not granted for this Client ID and scope
  (step 4), or not yet propagated (allow a few minutes).
- `403 Not Authorized to access this resource/api` — the address in "acting as" is not a
  Workspace administrator.
- "The stored key cannot be decrypted" — the server's `SECRET_ENCRYPTION_KEY` changed since the
  key was saved. Paste the key file again.

## 4. Turning it off

- One tenant: **Disconnect and delete the key**. The row and key are deleted; nobody here is
  changed.
- The whole deployment: `GOOGLE_DIRECTORY_DISABLED=true` on the worker. Every tenant's run is
  then `disabled` (no audit row, nothing changed), and the screen says so.

# Team

Settings › Team (M4-10, `/settings/team`) lists the people who can use a company's dashboard and lets any of them invite, revoke an invite, or remove another admin. Everyone on the page is a company admin (there are no roles). Operators get 403 (the dashboard is company-level) and are managed by hand (`docs/runbooks/operators.md`).

## What the page shows

- **Admins** (`admins` rows of the company): name, email, and **Last active**, read from Clerk (`lastActiveAt`) on every load. If Clerk can't be read the page still loads, with "—" and a note.
- **Pending invites** (`admin_invites` rows with status Pending): the email and how they get in: "Invite emailed" (a Clerk invitation) or "Access at next sign-in" (an existing Clerk account given the invite, no email sent).

Accepted and revoked invites aren't listed; the audit log keeps them (Security › Audit log).

## Invite

`POST /dashboard/settings/team/invites {email}` (the email is trimmed and lowercased):

1. Clerk is asked whether the email already has an account. If that account is an admin of **any** company, the answer is 409 `AlreadyAdmin` (one Clerk user administers one company).
2. In one transaction, with the company row locked: an admin of this company with that email (any case) → 409 `AlreadyAdmin`; a Pending invite for it → 409 `AlreadyInvited` (revoke it first to send a new one). Otherwise the `admin_invites` row is created, then:
   - **New email**: a Clerk invitation is sent, with public metadata `{ companyPublicId, adminInvitePublicId }` and a redirect to `${DASHBOARD_URL}/auth/sign-up` (`DASHBOARD_URL` is a wrangler var per environment).
   - **Existing account, admin nowhere**: the same metadata is set on that account. Clerk sends no email: tell them yourself. They get access at their next sign-in.
3. An "Invited admin" audit row (on the email).

If Clerk fails at step 1 or 2 the answer is 502 `ClerkUnavailable` and nothing is saved.

## Accepting

On the invitee's first `GET /dashboard/me`, `AdminsRepo.provisionAdmin` reads the metadata. With `adminInvitePublicId` it locks that row in the company the metadata names: only a **Pending** row lets them in; it becomes Accepted (`accepted_at`) in the same transaction as their `admins` row, and the metadata is cleared. A Revoked or unknown invite gives 403 and creates nothing, even though the Clerk metadata is still there. A revoke and a first sign-in at the same moment take the same row lock, so one of them wins cleanly.

## Revoke invite

`POST /dashboard/settings/team/invites/:publicId/revoke`: only a Pending invite (else 409 `NotPending`). Clerk is told first (the invitation is revoked; for an existing account the metadata is cleared, but only while it still names this invite), then the row is Revoked, with a "Revoked invite" audit row. A Clerk failure → 502, nothing changed.

## Remove admin

`DELETE /dashboard/settings/team/admins/:clerkUserId`: never yourself (409 `CannotRemoveSelf`), never the company's last admin (409 `LastAdmin`, checked under the company row lock). The `admins` row is deleted with a "Removed admin" audit row. Their next request gets 403 and stays that way (their invite was consumed). Their Clerk session stays valid until it expires; it no longer opens the dashboard.

## Invites don't expire

A Pending invite stays Pending until it's accepted or revoked. Clerk's own invitation link follows Clerk's settings.

## Cleaning up after a failed commit

Clerk is called inside the transaction, after the invite row exists. If the transaction then fails to commit, Clerk holds an invitation (or metadata) naming an invite row that doesn't exist; the invitee gets 403 because the row decides. Revoke the stray invitation in the Clerk dashboard (Users › Invitations) and invite again.

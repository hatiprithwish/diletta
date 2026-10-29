# Team

Settings › Team (M4-10, `/settings/team`) lists the people who can use a company's dashboard and lets any of them invite, revoke an invite, or remove another admin. Everyone on the page is a company admin (there are no roles). Operators get 403 (the dashboard is company-level) and are managed by hand (`docs/runbooks/operators.md`).

## What the page shows

- **Admins** (`admins` rows of the company): name, email, and **Last active**, read from Clerk (`lastActiveAt`) on every load. If Clerk can't be read the page still loads, with "—" and a note.
- **Pending invites** (`admin_invites` rows with status Pending): the email and how they get in: "Invite emailed" (a Clerk invitation) or "Access at next sign-in" (an existing Clerk account given the invite, no email sent).

Accepted and revoked invites aren't listed; the audit log keeps them (Security › Audit log).

## Invite

`POST /dashboard/settings/team/invites {email}` (the email is trimmed and lowercased):

1. Clerk is asked whether the email already has an account. If that account is an admin of **any** company, the answer is 409 `AlreadyAdmin` (one Clerk user administers one company). If it already carries another dashboard's invite metadata, the answer is 409 `HasPendingInvite`: granting would silently replace that invite.
2. With the company row locked: an admin of this company with that email (any case) → 409 `AlreadyAdmin`; a Pending invite for it → 409 `AlreadyInvited` (revoke it first to send a new one). Otherwise the Pending `admin_invites` row is committed. Nothing points at it yet.
3. Clerk is called, outside any transaction:
   - **New email**: a Clerk invitation is sent, with public metadata `{ companyPublicId, adminInvitePublicId }` and a redirect to `${DASHBOARD_URL}/auth/sign-up` (`DASHBOARD_URL` is a wrangler var per environment).
   - **Existing account, admin nowhere**: the same metadata is set on that account. Clerk sends no email: tell them yourself. They get access at their next sign-in.
4. The Clerk reference and an "Invited admin" audit row (on the email) are saved.

If Clerk fails at step 1 or 3 the answer is 502 `ClerkUnavailable`; a row from step 2 is closed as Revoked (not listed, no audit row) and the email can be invited again. If step 4 fails, the Clerk invitation is revoked again and the row closed, best effort, and the answer is 500.

## Accepting

On the invitee's first `GET /dashboard/me`, `AdminsRepo.provisionAdmin` reads the metadata. With `adminInvitePublicId` it locks that row in the company the metadata names: only a **Pending** row lets them in; it becomes Accepted (`accepted_at`) in the same transaction as their `admins` row, and the metadata is cleared. A Revoked or unknown invite gives 403 and creates nothing, whatever Clerk still holds; that metadata is then cleared (best effort), so later loads answer 403 without asking Clerk again. A revoke and a first sign-in at the same moment take the same row lock, so one of them wins cleanly.

## Revoke invite

`POST /dashboard/settings/team/invites/:publicId/revoke`: only a Pending invite (else 409 `NotPending`). The row becomes Revoked with a "Revoked invite" audit row, committed first; then Clerk is told, best effort: a still-pending invitation is revoked (one already accepted, expired or revoked is left alone), and an existing account's metadata is cleared while it still names this invite. A Clerk failure is logged, not answered: the Revoked row already refuses a sign-in, and that refused sign-in clears the leftover metadata.

## Remove admin

`DELETE /dashboard/settings/team/admins/:clerkUserId`: never yourself (409 `CannotRemoveSelf`), never the company's last admin (409 `LastAdmin`, checked under the company row lock). The `admins` row is **kept**, so the audit log, "edited by" on versions and "invited by" still name the person: `removed_at` / `removed_by` are set and `clerk_user_id` is replaced by a `removed_<ulid>` token, with a "Removed admin" audit row. Every sign-in lookup by their Clerk id now misses, so their next request gets 403, and the Clerk account can be invited again later (to this company or another), which creates a new row. Their Clerk session stays valid until it expires; it no longer opens the dashboard.

## Invites don't expire

A Pending invite stays Pending until it's accepted or revoked. Clerk's own invitation link follows Clerk's settings.

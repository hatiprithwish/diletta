# Dashboard admins and operators

Everyone who signs in to the dashboard has one row in `admins`, keyed by their Clerk user id. The role comes from `admins.company_id`:

| `company_id` | Role          | Can use                                                                                                        |
| ------------ | ------------- | -------------------------------------------------------------------------------------------------------------- |
| set          | company admin | `/dashboard/*`, on their own company only                                                                      |
| `NULL`       | operator      | `/operator/*` (operator-only actions across companies), and `/dashboard/*` in any company they pick (ADR 0006) |

Every route checks this through one function, `can(admin, action, resource)` (`packages/schemas/src/authz/`). A Clerk user with no `admins` row gets 403 on every dashboard and operator route. `/dashboard/*` routes act on a company admin's own company. An operator acts on the company they pick (below).

Admins of a **churned** company get 403 everywhere, and an invite to a churned company creates no admin. Admins of a **paused** company keep access, so they can see why the chatbot is paused. Operators are unaffected by company status.

The app never creates an operator. An operator row can only be added by hand on the owner connection, as described below. This is deliberate: an `admins` row with an empty `company_id` can reach every company.

## Add a company admin

Company admins invite each other from **Settings › Team** (M4-10, `docs/runbooks/team.md`): the invite is an `admin_invites` row plus a Clerk invitation (or, for someone who already has a Clerk account, the invite metadata set on that account). Operators only add the **first** admin of a new company, which has nobody to invite from yet:

1. Send a Clerk invitation whose **public metadata** names the company, from the Clerk dashboard (Users › Invitations), using the Clerk instance for the environment (staging or production):

   ```json
   { "companyPublicId": "<companies.public_id>" }
   ```

   This manual invite has no `admin_invites` row, so it doesn't show on the Team page and can't be revoked there; revoke it in the Clerk dashboard if needed.

2. The invitee signs up and opens the dashboard. `GET /dashboard/me` reads the metadata and creates their `admins` row in that company. If the metadata is missing, or names a company that doesn't exist or has churned, they get 403 and no row is created. A dashboard invite also carries `adminInvitePublicId`: then that `admin_invites` row must still be Pending in the same company (it becomes Accepted in the same transaction), else 403 and nothing is created.

3. In the same step the invite is **consumed**: both metadata keys are removed from the Clerk user. An invite works once, so deleting the `admins` row later really revokes access. To give someone access again, send a new invite. If Clerk can't be reached, no row is created and the next page load tries again.

Public metadata can only be written from the Clerk backend or dashboard, so a user can't add themselves to a company.

## Add an operator

1. Have the person sign in to the dashboard once, so they exist in Clerk. They will get 403, which is expected. Copy their user id (`user_…`) from the Clerk dashboard, using the instance for the environment you're changing.
2. As the owner, insert the row on the right Neon branch (Neon SQL editor, or `psql "$DATABASE_URL"`). For production, use the production owner URL:

   ```sql
   INSERT INTO admins (clerk_user_id, company_id, email, name)
   VALUES ('user_…', NULL, 'name@witbybit.com', 'Full Name');
   ```

   If they already have a company admin row, the insert fails on `UNQ_admins_clerk_user_id`. Promote them in one statement instead (no delete-then-insert, so there's no moment when they have no row):

   ```sql
   UPDATE admins SET company_id = NULL, updated_at = now() WHERE clerk_user_id = 'user_…';
   ```

3. Check: `GET /dashboard/me` as that person returns `"role": "operator"` and `"company": null`.

## Operator pages

M7-8. Signed in as an operator, the dashboard opens on **Companies** (`/operator/companies`), with its own sidebar (Companion, Diletta operator). A company admin never sees these pages.

- **Companies**: every company with its status and the environments it has an active connection in, filtered by status. **New company** asks for a name only and creates the company with its encryption key (the same as `POST /operator/companies`). It starts with no admins and no connections.
- **A company's page** (click its name): its status, public id and **Open dashboard**, then its sections:
  - **Connections** (the default): one card per connection, production first. **Add connection** picks the environment and sign-in method (only the ones the platform can run), then the API address, JWT issuer, sign-in settings (JSON), allowed origins (one per line) and, on staging, the clean-up call after tests (a JSON call op). **Edit** shows the environment, type, sign-in and credentials read-only (they never change; add a new connection instead) and can turn the connection off. A JWT issuer another connection uses is refused on its field. Same rules and audit rows as `POST` / `PATCH /operator/companies/:companyPublicId/connections` (`docs/runbooks/eregister.md`).
  - **Tools**: every version of every tool, by status (Active by default), with risk, approval and connection. **New tool** creates a draft (name, description, risk, approval, repeat safety, connection, and the four calls as JSON: input, call, read back, undo). A version's page shows what the API would refuse before you save (the ops' shape and placeholders, a write without a read back, an input schema the runtime can't check). Only a draft changes: **Save draft**, **Make active** (saved first), **Delete draft**. An active version is read-only (bot versions may pin it): **Disable** (refused while a published bot version uses it) or **New version** (a draft copy; one draft per tool). Same rules and audit rows as `/operator/companies/:companyPublicId/tool-definitions`.
  - **Maintenance › Rebuild insights**: recounts the daily numbers for up to 31 days (UTC), the same as `POST …/rollups/rebuild` (`docs/runbooks/rollups.md`). Days that fail are named; try those again.
  - **Maintenance › Company status**: Pause (its chatbots stop answering and test runs are refused; its admins keep the dashboard), Churn (also locks its admins out; you type the company's name to confirm) or Make active. Nothing is deleted. Each move is an audit row in the company's log as **Operator** ("Paused the company", "Churned the company", "Made the company active"); choosing the status it already has records nothing.

The first admin of a new company: open its dashboard and invite them from **Settings › Team** (`docs/runbooks/team.md`), or send a Clerk invite as described above.

## Act in a company as an operator

ADR 0006. An operator can open any company's dashboard and act there as one of its admins, with every admin action, for as long as they like.

1. On **Companies** or a company's page, choose **Open dashboard**. A churned company's is off.
2. The URL gets `?company=<publicId>` (kept on every page; bookmark or share it), the top bar shows **Acting as <company>**, and every request carries the `x-acting-company` header. **Back to operator** returns to that company's operator page. A dashboard link without a company you may act in sends you to Companies.
3. Every change you make is in the company's audit log as **Operator**, never as one of its admins, and opening the company records one **Opened the dashboard as Diletta support** row (each time you open it in a page load). On a change's timeline you show as **Diletta support**.

You never become one of the company's admins: no `admins` row is added, you're not on its Team page, and you never count as its last admin. A churned company can't be opened (403), the same as for its own admins. Calling the API directly works the same way: send `x-acting-company: <companyPublicId>` with the operator's token. Without it, an operator gets 403 on `/dashboard/*`.

## Remove an operator or a company admin

A company admin is removed by another admin on Settings › Team (audited; never yourself, never the last admin). That keeps the row for attribution (`removed_at`, and `clerk_user_id` replaced by a `removed_` token). An operator, or a company's last admin, is removed as the owner, on the right branch:

```sql
DELETE FROM admins WHERE clerk_user_id = 'user_…';
```

Their next request gets 403, and it stays that way: their invite was consumed when their row was created, so `/dashboard/me` can't recreate it. If they were invited but never signed in, there's no row yet; revoke the pending invitation in the Clerk dashboard (Users › Invitations) instead, or remove `companyPublicId` from the user's public metadata if they already signed up.

Their Clerk session stays valid until it expires, so also revoke it in the Clerk dashboard (Users › the user › Sessions) when removing access urgently.

`<verb>_by` columns (for example `chatbots.created_by`) may still point at the deleted `admins.id`. That's expected: there are no foreign keys, and audit history keeps the id.

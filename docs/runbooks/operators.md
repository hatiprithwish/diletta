# Dashboard admins and operators

Everyone who signs in to the dashboard has one row in `admins`, keyed by their Clerk user id. The role comes from `admins.company_id`:

| `company_id` | Role          | Can do                                                                                 |
| ------------ | ------------- | -------------------------------------------------------------------------------------- |
| set          | company admin | Actions scoped to their own company (`/dashboard/*`)                                   |
| `NULL`       | operator      | Operator-only actions across companies (`/operator/*`), plus any company-scoped action |

Every route checks this through one function, `can(admin, action, resource)` (`packages/schemas/src/authz/`). A Clerk user with no `admins` row gets 403 on every dashboard and operator route. `/dashboard/*` routes act on the caller's own company, so an operator (no company) gets 403 there too. Operator views of one company will come under `/operator/*`.

The app never creates an operator. An operator row can only be added by hand on the owner connection, as described below. This is deliberate: an `admins` row with an empty `company_id` can reach every company.

## Add a company admin

Company admins are created on their first sign-in, from their Clerk invite:

1. Send a Clerk invitation whose **public metadata** names the company:

   ```json
   { "companyPublicId": "<companies.public_id>" }
   ```

   Until the Settings › Team page (M4-10) sends invitations, send them from the Clerk dashboard (Users › Invitations), using the Clerk instance for the environment (staging or production).

2. The invitee signs up and opens the dashboard. `GET /dashboard/me` reads the metadata and creates their `admins` row in that company. If the metadata is missing, or names a company that doesn't exist, they get 403 and no row is created.

Public metadata can only be written from the Clerk backend or dashboard, so a user can't add themselves to a company.

## Add an operator

1. Have the person sign in to the dashboard once, so they exist in Clerk. They will get 403, which is expected. Copy their user id (`user_…`) from the Clerk dashboard, using the instance for the environment you're changing.
2. As the owner, insert the row on the right Neon branch (Neon SQL editor, or `psql "$DATABASE_URL"`). For production, use the production owner URL:

   ```sql
   INSERT INTO admins (clerk_user_id, company_id, email, name)
   VALUES ('user_…', NULL, 'name@witbybit.com', 'Full Name');
   ```

   If they already have a company admin row, the insert fails on `UNQ_admins_clerk_user_id`. Don't overwrite that row: removing someone's company is a separate decision. Remove the company admin row first (see below), then insert.

3. Check: `GET /dashboard/me` as that person returns `"role": "operator"` and `"company": null`.

## Remove an operator or a company admin

As the owner, on the right branch:

```sql
DELETE FROM admins WHERE clerk_user_id = 'user_…';
```

Their next request gets 403. Their Clerk session stays valid until it expires, so also revoke it in the Clerk dashboard (Users › the user › Sessions) when removing access urgently.

`<verb>_by` columns (for example `chatbots.created_by`) may still point at the deleted `admins.id`. That's expected: there are no foreign keys, and audit history keeps the id.

# ADR 0006: Operators act as a company admin in any company

- Status: Accepted
- Date: 2026-11-03
- Task: M7-7 (operator acts in a company)
- Changes: the locked M1-8 decision "`/dashboard/*` acts on the caller's own company, from the signed-in admin; an operator (no company) gets 403 there" (CLAUDE.md › Conventions › Authz, `docs/runbooks/operators.md`). An operator may now use every `/dashboard/*` route on a company they pick.

## Context

Operators (an `admins` row with no company) can only call `/operator/*`, and the web app shows them No access (M4-1). Supporting eRegister through the pilot (M7-5) and the launch week (M7-6) means seeing its Conversations, Changes, Quality and Settings exactly as its admins do, and fixing things there. Today that needs an invite into each company. That makes us one of the company's team on its Team page, gives one Clerk user one company only (`admins.clerk_user_id` is unique), and leaves no record that the person was us.

`can(admin, action, resource)` already lets an operator act on any company's resource. The block is only in `authorizeCompany`, which takes the company from the admin row.

## Decision

1. **The company comes from the operator's pick.** On `/dashboard/*`, a request from an operator must carry `X-Acting-Company: <companies.public_id>`. `authorizeCompany` resolves it server-side (unknown → 404; churned → 403, as for its own admins; paused is allowed) and sets `companyId` from it. The rest of the route is unchanged: `withTenant` on that company, RLS as today. An operator request without the header still gets 403.
2. **Company admins can't use it.** For a company admin the header is ignored: their company always comes from their own row. A client can never pick a company by itself.
3. **Full admin, no time box.** An operator acting in a company may do every company-admin action there (`can()` already allows it), with no expiry. `OPERATOR_ONLY_ACTIONS` stay operator-only.
4. **Every write names the operator.** Dashboard Repos take the actor from the request: `operatorAuditActor` when the caller is an operator, `adminAuditActor` otherwise. The company's audit log shows these rows as made by Diletta, not by one of its admins. `<verb>_by` columns hold the operator's `admins.id` as they do today.
5. **Starting to act is audited.** Opening a company records one audit row in it (entity Company, action `OperatorActed`, actor Operator, `POST /dashboard/acting`), once per company per page load: a pick, a reload or a shared `?company=` link each record one. So the company can see when we came in. Reads after that aren't audited, the same as an admin's.
6. **The operator is never on the company's team.** No `admins` row is created or changed. The Team page lists the company's own admins only, and the last-admin and remove-yourself rules count only them.
7. **Web app.** `/dashboard/me` answers an operator with `role: operator` and the list of companies (name, publicId, status). The shell shows a company picker instead of No access, keeps the pick in the URL (`?company=<publicId>`), sends it as `X-Acting-Company` through `apiClient`, and shows a banner "Acting as <company>" with a way to switch. Changing company clears every query.

## Consequences

- The role that can reach every company can now also change its configuration from the dashboard, so the protection is accountability, not isolation: every write is an Operator audit row, and every entry is recorded. Operators are still added by hand only (`docs/runbooks/operators.md`).
- A company admin's request is unchanged. `operatorActing.test.ts` proves a company admin's `X-Acting-Company` is ignored, and an operator gets 403 without it, 404 for an unknown company and 403 for a churned one.
- Every audited dashboard write takes its actor from the request (`actor: auditActorFor(c.get("admin"))`) instead of a hard-coded Admin actor, and so do the change request and quality issue events. The actor is a required Repo parameter, so a route that leaves it out doesn't compile; `operatorActing.test.ts` checks an operator's write lands as an Operator row.
- Widget, eval and operator routes are unaffected.
- The Team page, Settings › Team invites and admin removal never see operators, so a company can't remove us and we never count as its last admin.

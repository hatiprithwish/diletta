import { AdminRoleEnum, type AdminContext } from "../admins";
import { OPERATOR_ONLY_ACTIONS, type AuthzActionEnum, type AuthzResource } from "./AuthzCommon";

// DEV_NOTE: The one authorization check for every dashboard and operator action (architecture baseline).
// Pure and synchronous, so the backend and the web app share it. Two roles, derived from admins.company_id:
// - operator: every action; company-scoped actions still need a company to act on
// - company admin: company-scoped actions on their own company only; never operator-only actions
export function can(
  admin: AdminContext,
  action: AuthzActionEnum,
  resource: AuthzResource,
): boolean {
  if (OPERATOR_ONLY_ACTIONS.has(action)) {
    return admin.role === AdminRoleEnum.Operator;
  }

  if (resource.companyId === null) {
    return false;
  }

  if (admin.role === AdminRoleEnum.Operator) {
    return true;
  }

  return admin.companyId === resource.companyId;
}

import { describe, it, expect } from "vitest";
import { AdminRoleEnum, type AdminContext } from "../admins";
import { can } from "./Authz";
import { AuthzActionEnum, OPERATOR_ONLY_ACTIONS } from "./AuthzCommon";

const operator: AdminContext = { adminId: "1", companyId: null, role: AdminRoleEnum.Operator };
const adminOfA: AdminContext = { adminId: "2", companyId: "10", role: AdminRoleEnum.CompanyAdmin };

const companyActions = Object.values(AuthzActionEnum).filter(
  (action) => !OPERATOR_ONLY_ACTIONS.has(action),
);
const operatorActions = [...OPERATOR_ONLY_ACTIONS];

describe("can", () => {
  it("lets a company admin act on their own company", () => {
    for (const action of companyActions) {
      expect(can(adminOfA, action, { companyId: "10" })).toBe(true);
    }
  });

  it("refuses a company admin on another company", () => {
    for (const action of companyActions) {
      expect(can(adminOfA, action, { companyId: "11" })).toBe(false);
    }
  });

  it("refuses a company admin every operator-only action", () => {
    for (const action of operatorActions) {
      expect(can(adminOfA, action, { companyId: null })).toBe(false);
      expect(can(adminOfA, action, { companyId: "10" })).toBe(false);
    }
  });

  it("lets an operator act on any company and perform operator-only actions", () => {
    for (const action of companyActions) {
      expect(can(operator, action, { companyId: "10" })).toBe(true);
      expect(can(operator, action, { companyId: "11" })).toBe(true);
    }
    for (const action of operatorActions) {
      expect(can(operator, action, { companyId: null })).toBe(true);
    }
  });

  it("refuses a company-scoped action with no company, even for an operator", () => {
    for (const action of companyActions) {
      expect(can(operator, action, { companyId: null })).toBe(false);
      expect(can(adminOfA, action, { companyId: null })).toBe(false);
    }
  });
});

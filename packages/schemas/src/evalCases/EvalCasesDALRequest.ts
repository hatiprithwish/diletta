import type { EvalCase, EvalCaseExpectationsV1, EvalCaseInputV1 } from "./EvalCasesCommon";

// DEV_NOTE: A customer case (M4-6, from a quality issue): always one company's and one chatbot's, never a safety case,
// active. The DAL generates publicId and checks the chatbot exists in the company.
export type CreateEvalCaseDALRequest = Pick<EvalCase, "name"> & {
  companyId: string;
  chatbotId: string;
  input: EvalCaseInputV1;
  expectations: EvalCaseExpectationsV1;
};

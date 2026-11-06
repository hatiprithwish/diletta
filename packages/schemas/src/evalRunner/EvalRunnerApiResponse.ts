import type { ApiResponse } from "../common";
import type { CompanyConnectionFailureEnum } from "../companyConnections/CompanyConnectionsCommon";
import type {
  EvalHostLogin,
  EvalHostLoginKindEnum,
  EvalHostLoginKindLabelEnum,
  EvalRunStartFailureEnum,
} from "./EvalRunnerCommon";

// DEV_NOTE: A run the dashboard queued; the Tests page shows it from here on (Queued, then Running, then Done / Failed)
export interface StartEvalRunApiResponse extends ApiResponse {
  evalRun?: { publicId: string };
  failure?: EvalRunStartFailureEnum;
}

// DEV_NOTE: A connection's test sign-in as the operator page shows it: which host and as whom, never a password, API key
// or admin secret. null = none set.
export interface EvalHostLoginSummary {
  kind: EvalHostLoginKindEnum;
  kindLabel: EvalHostLoginKindLabelEnum;
  hostUser: string;
  updatedAt: string;
}

// DEV_NOTE: failure Invalid (400) = the connection isn't Staging
export interface GetEvalHostLoginApiResponse extends ApiResponse {
  evalHostLogin?: EvalHostLoginSummary | null;
  failure?: CompanyConnectionFailureEnum;
}

// DEV_NOTE: What the runner gets for one run over its service binding (EvalRunnerEntrypoint.getRunLogin): the public ids
// its eval JWT names and the decrypted login. Server to server only: never a route response, a log or a Workflow
// param or step result (ADR 0007).
export interface EvalRunLogin {
  companyPublicId: string;
  connectionPublicId: string;
  login: EvalHostLogin;
}

export interface EvalRunLoginResponse extends ApiResponse {
  runLogin?: EvalRunLogin;
}

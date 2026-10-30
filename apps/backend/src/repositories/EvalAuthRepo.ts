import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import CompanyConnectionsDAL from "@/data-access-layer/CompanyConnectionsDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant from "@/db/withTenant";
import EvalJwtProvider from "@/providers/evalJwt";
import EvalRefusalProvider from "@/providers/evalRefusal";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The eval harness's caller (M5-2), for authenticateEval only: a platform-signed eval JWT naming one company
// and one of its connections, which must be an active Staging connection of an active company; a production connection
// is refused, so an eval never drives a production host. Everything EvalHarnessRepo does after it is scoped to that
// company and connection (EvalIdentity).
export default class EvalAuthRepo {
  private env: Env;
  private db: NodePgDatabase;
  private companiesDal: CompaniesDAL;
  private connectionsDal: CompanyConnectionsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.companiesDal = new CompaniesDAL();
    this.connectionsDal = new CompanyConnectionsDAL();
  }

  // DEV_NOTE: decode → signature (the platform's EVAL_JWT_PUBLIC_JWKS) → claims, all Unauthorized on failure, so a
  // made-up token learns nothing. Only then is anything it names read: the company by public id (withPlatform: no
  // company is known yet, like the widget's issuer lookup), then its connection in withTenant. A company or connection
  // that isn't found, isn't active, or a connection that isn't Staging is Forbidden.
  async authenticate(token: string): Promise<Schemas.EvalAuthResponse> {
    const decoded = EvalJwtProvider.decode(token);
    if (!decoded.isSuccess || !decoded.jwt) {
      return this.refuse(Schemas.EvalAuthFailureEnum.Unauthorized, decoded.message);
    }
    const { jwt } = decoded;
    const signature = await EvalJwtProvider.verifySignature(this.env, jwt);
    if (!signature.isSuccess) {
      return this.refuse(
        signature.failure ?? Schemas.EvalAuthFailureEnum.ServerError,
        signature.message,
      );
    }
    const claims = EvalJwtProvider.checkClaims(jwt.claims);
    if (!claims.isSuccess) {
      return this.refuse(Schemas.EvalAuthFailureEnum.Unauthorized, claims.message);
    }
    const metadata = {
      companyPublicId: jwt.claims.company,
      connectionPublicId: jwt.claims.connection,
    };

    const company: Schemas.CompanyDALResponse = await withPlatform(this.db, async (tx) => {
      return await this.companiesDal.getCompanyByPublicId(tx, { publicId: jwt.claims.company });
    });
    if (!company.isSuccess || !company.company) {
      return company.isNotFound
        ? this.refuse(Schemas.EvalAuthFailureEnum.Forbidden, "Company not found", metadata)
        : this.refuse(Schemas.EvalAuthFailureEnum.ServerError, company.message, metadata);
    }
    if (company.company.status !== Schemas.CompanyStatusIntEnum.Active) {
      return this.refuse(Schemas.EvalAuthFailureEnum.Forbidden, "Company is not active", metadata);
    }
    const companyId = company.company.id;

    const found: Schemas.CompanyConnectionDALResponse = await withTenant(
      this.db,
      companyId,
      async (tx) => {
        return await this.connectionsDal.getCompanyConnectionDetails(tx, {
          companyId,
          publicId: jwt.claims.connection,
        });
      },
    );
    if (!found.isSuccess || !found.companyConnection) {
      return found.isNotFound
        ? this.refuse(Schemas.EvalAuthFailureEnum.Forbidden, "Connection not found", metadata)
        : this.refuse(Schemas.EvalAuthFailureEnum.ServerError, found.message, metadata);
    }
    const connection = found.companyConnection;
    if (connection.environment !== Schemas.CompanyConnectionEnvironmentIntEnum.Staging) {
      return this.refuse(
        Schemas.EvalAuthFailureEnum.Forbidden,
        "Eval tokens are accepted only for a staging connection",
        metadata,
      );
    }
    if (connection.status !== Schemas.CompanyConnectionStatusIntEnum.Active) {
      return this.refuse(Schemas.EvalAuthFailureEnum.Forbidden, "Connection is disabled", metadata);
    }

    return {
      isSuccess: true,
      message: "Eval caller authenticated",
      identity: {
        companyId,
        connectionId: connection.id,
        connection: {
          adapterType: connection.adapterType,
          baseUrl: connection.baseUrl,
          authType: connection.authType,
          authConfig: connection.authConfig,
          credentialScope: connection.credentialScope,
        },
        resetOp: connection.resetOp,
        hostUserId: jwt.claims.sub,
      },
    };
  }

  private refuse(
    failure: Schemas.EvalAuthFailureEnum,
    message: string | undefined,
    metadata?: Record<string, unknown>,
  ): Schemas.EvalAuthResponse {
    return EvalRefusalProvider.refuse({
      action: Schemas.LogAction.AuthenticateEval,
      failure,
      serverError: Schemas.EvalAuthFailureEnum.ServerError,
      message: message ?? "Eval authentication failed",
      metadata,
    });
  }
}

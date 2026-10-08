import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import CompanyConnectionsDAL from "@/data-access-layer/CompanyConnectionsDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant from "@/db/withTenant";
import AppLogger from "@/providers/logger";
import WidgetJwtProvider from "@/providers/widgetJwt";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Widget identity (M2-1). Verifies the companion JWT from the widget's first WebSocket message and resolves
// who is calling, in an order where nothing untrusted is acted on:
//   1. decode: alg allowlist (RS256 / ES256), kid, no crit, claim shapes. Nothing in the token is trusted yet.
//   2. iss → company_connections row in withPlatform (no company is known yet, pattern rule 3.15). Only a registered
//      issuer gets past here, so the JWKS fetch never targets a URL no company registered.
//   3. signature against the issuer's JWKS (KV-cached), then aud / exp / nbf / iat / lifetime.
//   4. connection active, and the upgrade's Origin in its allowed_origins.
//   5. withTenant on the connection's company: company active (paused and churned companies' widgets are off), then
//      the chatbot (the embed's publicId, else the default) must exist and be active.
// Every failure in 1–3 is Unauthorized, so only a validly signed token can see Forbidden / NotFound: the close code
// never reveals to an outsider whether an issuer is registered or which origins it allows.
// The identity carries internal ids and stays server-side; M2-2's Conversation DO runs the same method.
export default class WidgetAuthRepo {
  private env: Env;
  private db: NodePgDatabase;
  private connectionsDal: CompanyConnectionsDAL;
  private companiesDal: CompaniesDAL;
  private chatbotsDal: ChatbotsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.connectionsDal = new CompanyConnectionsDAL();
    this.companiesDal = new CompaniesDAL();
    this.chatbotsDal = new ChatbotsDAL();
  }

  async authenticate(params: {
    token: string;
    origin: string | null;
    chatbotPublicId: string | null;
  }): Promise<Schemas.WidgetAuthResponse> {
    const decoded = WidgetJwtProvider.decode(params.token);
    if (!decoded.isSuccess || !decoded.jwt) {
      return this.reject(Schemas.WidgetAuthFailureEnum.Unauthorized, decoded.message);
    }
    const { jwt } = decoded;

    const found: Schemas.CompanyConnectionDALResponse = await withPlatform(this.db, async (tx) => {
      return await this.connectionsDal.getCompanyConnectionByIssuer(tx, {
        jwtIssuer: jwt.claims.iss,
      });
    });
    if (!found.isSuccess || !found.companyConnection) {
      return found.isNotFound
        ? this.reject(Schemas.WidgetAuthFailureEnum.Unauthorized, "Issuer is not registered", {
            issuer: jwt.claims.iss,
          })
        : this.reject(Schemas.WidgetAuthFailureEnum.ServerError, found.message);
    }
    const connection = found.companyConnection;
    const connectionMetadata = {
      companyId: connection.companyId,
      connectionPublicId: connection.publicId,
    };

    const signature = await WidgetJwtProvider.verifySignature(this.env, connection.jwtIssuer, jwt);
    if (!signature.isSuccess) {
      return this.reject(
        signature.failure ?? Schemas.WidgetAuthFailureEnum.ServerError,
        signature.message,
        connectionMetadata,
      );
    }

    const claims = WidgetJwtProvider.checkClaims(jwt.claims);
    if (!claims.isSuccess) {
      return this.reject(
        claims.failure ?? Schemas.WidgetAuthFailureEnum.Unauthorized,
        claims.message,
        connectionMetadata,
      );
    }

    // DEV_NOTE: Only after the signature and claims pass. Before that every failure is Unauthorized (4401), so a
    // made-up token can't tell a registered issuer, a disabled connection or an allowed origin from anything else.
    if (connection.status !== Schemas.CompanyConnectionStatusIntEnum.Active) {
      return this.reject(
        Schemas.WidgetAuthFailureEnum.Forbidden,
        "Connection is disabled",
        connectionMetadata,
      );
    }
    if (params.origin === null || !connection.allowedOrigins.includes(params.origin)) {
      return this.reject(Schemas.WidgetAuthFailureEnum.Forbidden, "Origin is not allowed", {
        ...connectionMetadata,
        origin: params.origin,
      });
    }

    const resolved: Schemas.WidgetChatbotResponse = await withTenant(
      this.db,
      connection.companyId,
      async (tx) => {
        const company = await this.companiesDal.getCompanyDetails(tx, {
          companyId: connection.companyId,
        });
        if (!company.isSuccess || !company.company) {
          return company.isNotFound
            ? {
                isSuccess: false,
                message: "Company not found",
                failure: Schemas.WidgetAuthFailureEnum.Forbidden,
              }
            : {
                isSuccess: false,
                message: company.message,
                failure: Schemas.WidgetAuthFailureEnum.ServerError,
              };
        }
        if (company.company.status !== Schemas.CompanyStatusIntEnum.Active) {
          return {
            isSuccess: false,
            message: "Company is not active",
            failure: Schemas.WidgetAuthFailureEnum.Forbidden,
          };
        }

        const chatbot = params.chatbotPublicId
          ? await this.chatbotsDal.getChatbotDetails(tx, {
              companyId: connection.companyId,
              publicId: params.chatbotPublicId,
            })
          : await this.chatbotsDal.getDefaultChatbot(tx, { companyId: connection.companyId });
        if (!chatbot.isSuccess || !chatbot.chatbot) {
          return {
            isSuccess: false,
            message: chatbot.message,
            failure: chatbot.isNotFound
              ? Schemas.WidgetAuthFailureEnum.NotFound
              : Schemas.WidgetAuthFailureEnum.ServerError,
          };
        }
        if (chatbot.chatbot.status !== Schemas.ChatbotStatusIntEnum.Active) {
          return {
            isSuccess: false,
            message: "Chatbot is paused",
            failure: Schemas.WidgetAuthFailureEnum.Forbidden,
          };
        }

        return { isSuccess: true, chatbot: chatbot.chatbot };
      },
    );
    if (!resolved.isSuccess || !resolved.chatbot) {
      return this.reject(
        resolved.failure ?? Schemas.WidgetAuthFailureEnum.ServerError,
        resolved.message,
        { ...connectionMetadata, chatbotPublicId: params.chatbotPublicId },
      );
    }

    AppLogger.info({
      category: Schemas.LogCategory.Widget,
      action: Schemas.LogAction.AuthenticateWidget,
      message: "Widget authenticated",
      metadata: { ...connectionMetadata, chatbotPublicId: resolved.chatbot.publicId },
    });

    return {
      isSuccess: true,
      message: "Widget authenticated",
      identity: {
        companyId: connection.companyId,
        connectionId: connection.id,
        connectionEnvironment: connection.environment,
        chatbotId: resolved.chatbot.id,
        chatbotPublicId: resolved.chatbot.publicId,
        chatbotName: resolved.chatbot.name,
        hostUserId: jwt.claims.sub,
        displayName: jwt.claims.name ?? null,
        roles: jwt.claims.roles ?? [],
        tokenExpiresAt: new Date(jwt.claims.exp * 1000),
      },
    };
  }

  private reject(
    failure: Schemas.WidgetAuthFailureEnum,
    message: string | undefined,
    metadata?: Record<string, unknown>,
  ): Schemas.WidgetAuthResponse {
    AppLogger.warn({
      category: Schemas.LogCategory.Widget,
      action: Schemas.LogAction.AuthenticateWidget,
      message: message ?? "Widget authentication failed",
      metadata: { ...metadata, failure },
    });
    return { isSuccess: false, message, failure };
  }
}

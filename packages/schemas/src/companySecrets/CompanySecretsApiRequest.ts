import { z } from "zod";
import {
  CompanySecretStatusIntEnum,
  CompanySecretTypeIntEnum,
  ZCompanySecretBase,
} from "./CompanySecretsCommon";

// DEV_NOTE: expiresAt defaults to none. The refine mirrors CHK_company_secrets_model_key_provider. The connection
// (non model-key types) is an internal id the Repo takes next to the body; client refs arrive with routes (M4).
export const ZCreateCompanySecretApiRequest = z.object({
  companySecret: ZCompanySecretBase.partial({ expiresAt: true }).refine(
    (companySecret) =>
      (companySecret.type === CompanySecretTypeIntEnum.ModelKey) ===
      (companySecret.provider !== null),
    { message: "Provider is required for a model key, and only for one", path: ["provider"] },
  ),
});
export type CreateCompanySecretApiRequest = z.infer<typeof ZCreateCompanySecretApiRequest>;

// DEV_NOTE: type and provider are fixed once created (the unique indexes key on them). A new secret value
// overwrites the row (rotation); the caller validates it first. A null expiresAt would be ignored, so it isn't accepted.
export const ZUpdateCompanySecretApiRequest = z.object({
  companySecret: z
    .object({
      secret: ZCompanySecretBase.shape.secret,
      expiresAt: z.coerce.date(),
      status: z.enum(CompanySecretStatusIntEnum),
    })
    .partial(),
});
export type UpdateCompanySecretApiRequest = z.infer<typeof ZUpdateCompanySecretApiRequest>;

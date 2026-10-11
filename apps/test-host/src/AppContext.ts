import type * as Schemas from "@app/schemas";

// DEV_NOTE: requireHostToken sets the verified token's workspace (ws) and sub; requireAdmin / the JWKS route set the
// signing key
type AppContext = {
  Bindings: Env;
  Variables: {
    signingKey: Schemas.TestHostSigningKey;
    workspace: string;
    sub: string;
  };
};

export default AppContext;

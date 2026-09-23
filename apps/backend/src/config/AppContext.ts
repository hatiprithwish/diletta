interface AuthVariables {
  clerkUserId: string;
  clerkEmail: string;
  clerkSessionId: string;
}

interface AppContext {
  Bindings: Env;
  Variables: AuthVariables;
}

export default AppContext;

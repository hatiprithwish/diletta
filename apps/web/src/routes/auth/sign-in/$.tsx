import { createFileRoute } from "@tanstack/react-router";
import { SignIn } from "@clerk/tanstack-react-start";

// DEV_NOTE: Splat route catches all Clerk sub-paths (factor-one, factor-two, sso-callback, etc.)
// so TanStack Router doesn't 404 them. Clerk handles the UI state internally via routing="path".
export const Route = createFileRoute("/auth/sign-in/$")({
  component: () => (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: "4rem" }}>
      <SignIn routing="path" path="/auth/sign-in" signUpUrl="/auth/sign-up" />
    </div>
  ),
});

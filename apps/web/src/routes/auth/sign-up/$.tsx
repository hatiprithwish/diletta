import { createFileRoute } from "@tanstack/react-router";
import { SignUp } from "@clerk/tanstack-react-start";

// DEV_NOTE: Splat route catches all Clerk sub-paths (verify-email-address, continue, etc.)
// so TanStack Router doesn't 404 them. Clerk handles the UI state internally via routing="path".
export const Route = createFileRoute("/auth/sign-up/$")({
  component: () => (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: "4rem" }}>
      <SignUp routing="path" path="/auth/sign-up" signInUrl="/auth/sign-in" />
    </div>
  ),
});

import { createFileRoute } from "@tanstack/react-router";
import { SignUp } from "@clerk/tanstack-react-start";

export const Route = createFileRoute("/auth/sign-up/")({
  component: () => (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: "4rem" }}>
      <SignUp routing="path" path="/auth/sign-up" signInUrl="/auth/sign-in" />
    </div>
  ),
});

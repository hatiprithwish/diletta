import { createFileRoute } from "@tanstack/react-router";
import { SignIn } from "@clerk/tanstack-react-start";

export const Route = createFileRoute("/auth/sign-in/")({
  component: () => (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: "4rem" }}>
      <SignIn routing="path" path="/auth/sign-in" signUpUrl="/auth/sign-up" />
    </div>
  ),
});

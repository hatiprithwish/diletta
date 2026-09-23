import { createFileRoute } from "@tanstack/react-router";
import { AuthenticateWithRedirectCallback } from "@clerk/tanstack-react-start";

export const Route = createFileRoute("/auth/sign-in/sso-callback")({
  component: () => <AuthenticateWithRedirectCallback />,
});

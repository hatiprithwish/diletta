// DEV_NOTE: Tanstack Start Server entry point

import { StartClient } from "@tanstack/react-start/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { z } from "zod";

// DEV_NOTE: Zod registers its English messages as an import side effect, which the production build drops: every form
// issue then reads "Invalid input" (the draft editor's list of what to fix). Register them explicitly.
z.config(z.locales.en());

hydrateRoot(
  document,
  <StrictMode>
    <StartClient />
  </StrictMode>,
);

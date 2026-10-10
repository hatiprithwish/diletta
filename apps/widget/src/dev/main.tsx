import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/dev/dev.css";
import DevHostPage from "@/dev/DevHostPage";
import StatesGallery from "@/dev/StatesGallery";

// DEV_NOTE: Development only (`pnpm --filter widget dev`): a stand-in host page with the live widget, or with
// ?gallery every widget state drawn from sample data (DESIGN.md §7), for checking against the design in light and dark
const container = document.getElementById("dev-host");
if (container) {
  const isGallery = new URLSearchParams(window.location.search).has("gallery");
  createRoot(container).render(
    <StrictMode>{isGallery ? <StatesGallery /> : <DevHostPage />}</StrictMode>,
  );
}

import { useLayoutEffect, useRef, useState } from "react";
import type { PropsWithChildren } from "react";
import { createPortal } from "react-dom";
import { cn } from "@app/ui/lib/utils";
import * as Schemas from "@app/schemas";
import { ensureDocumentAssets, shadowCss } from "@/shadow/documentAssets";

// DEV_NOTE: The widget's Shadow DOM boundary (DESIGN.md §7): an element in the host page with an open shadow root
// holding the widget's own styles, into which the widget renders through a portal. Dark mode is the preset's .dark
// class on the wrapper inside the root. Re-attaching is guarded, so React's strict-mode double effects are safe.
export default function ShadowHost({
  theme,
  children,
}: PropsWithChildren<Schemas.WidgetShadowHostProps>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    ensureDocumentAssets(host.ownerDocument);
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const style = host.ownerDocument.createElement("style");
    style.textContent = shadowCss;
    const container = host.ownerDocument.createElement("div");
    root.append(style, container);
    setMount(container);
    return () => {
      style.remove();
      container.remove();
      setMount(null);
    };
  }, []);

  return (
    <div ref={hostRef} data-diletta-widget="">
      {mount &&
        createPortal(
          <div className={cn(theme === Schemas.WidgetThemeEnum.Dark && "dark")}>
            <div className="font-sans text-foreground antialiased">{children}</div>
          </div>,
          mount,
        )}
    </div>
  );
}

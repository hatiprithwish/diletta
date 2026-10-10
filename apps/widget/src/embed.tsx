import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { StoreApi } from "zustand/vanilla";
import * as Schemas from "@app/schemas";
import { createWidgetStore } from "@/store/widgetStore";
import WidgetRoot from "@/WidgetRoot";

// DEV_NOTE: The script-tag build (dist/embed/diletta-widget.js). The host page loads it and calls
//   window.Diletta.init({ apiBase, chatbot?, theme?, getToken })
// which mounts one widget (a second init replaces the first) and returns its controller; window.Diletta.open / close
// / setTheme / destroy act on that same widget. Bad options throw, so a host developer sees the mistake at once.
let current: {
  root: Root;
  container: HTMLElement;
  store: StoreApi<Schemas.WidgetStore>;
} | null = null;

function destroy() {
  if (!current) return;
  current.root.unmount();
  current.container.remove();
  current = null;
}

const controller: Schemas.WidgetController = {
  open: () => current?.store.getState().setOpen(true),
  close: () => current?.store.getState().setOpen(false),
  setTheme: (theme) => {
    const parsed = Schemas.ZWidgetEmbedConfig.shape.theme.parse(theme);
    if (parsed) current?.store.getState().setTheme(parsed);
  },
  destroy,
};

function init(options: Schemas.WidgetInitOptions): Schemas.WidgetController {
  const config = Schemas.ZWidgetEmbedConfig.parse(options);
  if (typeof options.getToken !== "function") {
    throw new TypeError("Diletta.init: getToken must be a function returning a companion JWT");
  }
  destroy();

  const container = document.createElement("div");
  container.id = "diletta-widget";
  document.body.append(container);
  const store = createWidgetStore(config.theme ?? Schemas.WidgetThemeEnum.Light);
  const root = createRoot(container);
  root.render(<WidgetRoot options={{ ...config, getToken: options.getToken }} store={store} />);
  current = { root, container, store };
  return controller;
}

const Diletta: Schemas.DilettaGlobal = { init, ...controller };
Object.assign(window, { Diletta });

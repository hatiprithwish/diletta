import { createRoot } from "react-dom/client";
import * as Schemas from "@app/schemas";
import { createWidgetStore } from "@/store/widgetStore";
import WidgetRoot from "@/WidgetRoot";

// DEV_NOTE: The script-tag build (dist/embed/diletta-widget.js). The host page loads it and calls
//   window.Diletta.init({ apiBase, chatbot?, theme?, getToken })
// which mounts one widget (a second init replaces the first) and returns that widget's controller; window.Diletta.open
// / close / setTheme / destroy act on the current widget. A controller only ever acts on its own widget, so an old
// one can't destroy a newer init. Bad options throw, so a host developer sees the mistake at once. Called from a
// <head> script, the widget joins <body> once the document has one.
function mount(options: Schemas.WidgetInitOptions, config: Schemas.WidgetEmbedConfig) {
  const container = document.createElement("div");
  container.id = "diletta-widget";
  const attach = () => document.body.append(container);
  if (document.body) {
    attach();
  } else {
    document.addEventListener("DOMContentLoaded", attach, { once: true });
  }
  const store = createWidgetStore(config.theme ?? Schemas.WidgetThemeEnum.Light);
  const root = createRoot(container);
  root.render(<WidgetRoot options={{ ...config, getToken: options.getToken }} store={store} />);
  return {
    store,
    unmount: () => {
      document.removeEventListener("DOMContentLoaded", attach);
      root.unmount();
      container.remove();
    },
  };
}

let current: ReturnType<typeof mount> | null = null;

function controllerFor(widget: () => ReturnType<typeof mount> | null): Schemas.WidgetController {
  return {
    open: () => widget()?.store.getState().setOpen(true),
    close: () => widget()?.store.getState().setOpen(false),
    setTheme: (theme) => {
      const parsed = Schemas.ZWidgetEmbedConfig.shape.theme.parse(theme);
      if (parsed) widget()?.store.getState().setTheme(parsed);
    },
    destroy: () => {
      const target = widget();
      if (!target) return;
      target.unmount();
      if (current === target) current = null;
    },
  };
}

function init(options: Schemas.WidgetInitOptions): Schemas.WidgetController {
  const config = Schemas.ZWidgetEmbedConfig.parse(options);
  if (typeof options.getToken !== "function") {
    throw new TypeError("Diletta.init: getToken must be a function returning a companion JWT");
  }
  current?.unmount();
  const mounted = mount(options, config);
  current = mounted;
  return controllerFor(() => (current === mounted ? mounted : null));
}

const Diletta: Schemas.DilettaGlobal = { init, ...controllerFor(() => current) };
Object.assign(window, { Diletta });

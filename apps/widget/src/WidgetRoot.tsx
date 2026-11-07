import { useStore } from "zustand";
import type * as Schemas from "@app/schemas";
import ShadowHost from "@/shadow/ShadowHost";
import { WidgetStoreContext } from "@/store/WidgetStoreContext";
import WidgetApp from "@/WidgetApp";

// DEV_NOTE: One widget: its store, its shadow root, its app. Both the script-tag build and the React export render it.
export default function WidgetRoot({ options, store }: Schemas.WidgetRootProps) {
  const theme = useStore(store, (state) => state.theme);
  const accent = useStore(store, (state) => state.accent);
  return (
    <WidgetStoreContext value={store}>
      <ShadowHost theme={theme} accent={accent}>
        <WidgetApp
          apiBase={options.apiBase}
          chatbot={options.chatbot ?? null}
          getToken={options.getToken}
          getHostToken={options.getHostToken ?? null}
        />
      </ShadowHost>
    </WidgetStoreContext>
  );
}

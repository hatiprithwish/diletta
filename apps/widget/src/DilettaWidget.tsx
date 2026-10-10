import { useEffect, useState } from "react";
import * as Schemas from "@app/schemas";
import { createWidgetStore } from "@/store/widgetStore";
import WidgetRoot from "@/WidgetRoot";

// DEV_NOTE: The React export: <DilettaWidget apiBase=… chatbot=… theme=… getToken=… />. Options that don't check out
// (ZWidgetEmbedConfig) render nothing rather than break the host app. A new apiBase or chatbot starts a fresh widget;
// a new theme re-themes it in place.
export default function DilettaWidget(props: Schemas.DilettaWidgetProps) {
  const theme = props.theme ?? Schemas.WidgetThemeEnum.Light;
  const [store] = useState(() => createWidgetStore(theme));

  useEffect(() => {
    store.getState().setTheme(theme);
  }, [store, theme]);

  const config = Schemas.ZWidgetEmbedConfig.safeParse({
    apiBase: props.apiBase,
    chatbot: props.chatbot,
    theme: props.theme,
  });
  if (!config.success || typeof props.getToken !== "function") return null;

  return (
    <WidgetRoot
      key={`${config.data.apiBase}|${config.data.chatbot ?? ""}`}
      options={{ ...config.data, getToken: props.getToken }}
      store={store}
    />
  );
}

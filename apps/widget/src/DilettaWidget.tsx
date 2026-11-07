import { useEffect, useMemo, useState } from "react";
import * as Schemas from "@app/schemas";
import { createWidgetStore } from "@/store/widgetStore";
import WidgetRoot from "@/WidgetRoot";
import { parseWidgetAccent } from "@/lib/accent";

// DEV_NOTE: The React export: <DilettaWidget apiBase=… chatbot=… theme=… accent=… getToken=… getHostToken=… />. Options
// that don't check out (ZWidgetEmbedConfig, a colour the browser can't draw) render nothing rather than break the
// host app. A new apiBase or chatbot starts a fresh widget, store included (nothing of the old chatbot's conversation
// carries over); a new theme or accent re-colours it in place. The accent is compared by its colours, so a host that
// builds a new object on every render doesn't re-render the widget.
export default function DilettaWidget(props: Schemas.DilettaWidgetProps) {
  const fill = props.accent?.fill;
  const fillForeground = props.accent?.fillForeground;
  const text = props.accent?.text;
  const hasAccent = props.accent !== undefined && props.accent !== null;
  const accent = useMemo(
    () => (hasAccent ? parseWidgetAccent({ fill, fillForeground, text }) : null),
    [hasAccent, fill, fillForeground, text],
  );

  const config = Schemas.ZWidgetEmbedConfig.safeParse({
    apiBase: props.apiBase,
    chatbot: props.chatbot,
    theme: props.theme,
  });
  if (!config.success || typeof props.getToken !== "function") return null;
  if (accent && !accent.isSuccess) return null;

  return (
    <DilettaWidgetInstance
      key={`${config.data.apiBase}|${config.data.chatbot ?? ""}`}
      options={{
        ...config.data,
        getToken: props.getToken,
        getHostToken: typeof props.getHostToken === "function" ? props.getHostToken : undefined,
      }}
      theme={config.data.theme ?? Schemas.WidgetThemeEnum.Light}
      accent={accent ? accent.accent : null}
    />
  );
}

function DilettaWidgetInstance({ options, theme, accent }: Schemas.DilettaWidgetInstanceProps) {
  const [store] = useState(() => createWidgetStore(theme, accent));

  useEffect(() => {
    store.getState().setTheme(theme);
  }, [store, theme]);

  useEffect(() => {
    store.getState().setAccent(accent);
  }, [store, accent]);

  return <WidgetRoot options={options} store={store} />;
}

import { useEffect, useState } from "react";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Development only: the dev host's light / dark switch (?theme=dark), applied to the page and the widget
export function useDevTheme() {
  const [theme, setTheme] = useState(() =>
    new URLSearchParams(window.location.search).get("theme") === Schemas.WidgetThemeEnum.Dark
      ? Schemas.WidgetThemeEnum.Dark
      : Schemas.WidgetThemeEnum.Light,
  );
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === Schemas.WidgetThemeEnum.Dark);
  }, [theme]);
  const toggle = () =>
    setTheme((current) =>
      current === Schemas.WidgetThemeEnum.Dark
        ? Schemas.WidgetThemeEnum.Light
        : Schemas.WidgetThemeEnum.Dark,
    );
  return { theme, toggle };
}

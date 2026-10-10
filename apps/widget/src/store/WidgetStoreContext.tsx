import { createContext, use } from "react";
import { useStore } from "zustand";
import type * as Schemas from "@app/schemas";

export const WidgetStoreContext = createContext<Schemas.WidgetStoreApi | null>(null);

export function useWidgetStoreApi(): Schemas.WidgetStoreApi {
  const store = use(WidgetStoreContext);
  if (!store) throw new Error("useWidgetStore must be used inside the widget");
  return store;
}

export function useWidgetStore<T>(select: (state: Schemas.WidgetStore) => T): T {
  return useStore(useWidgetStoreApi(), select);
}

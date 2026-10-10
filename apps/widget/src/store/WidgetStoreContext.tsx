import { createContext, use } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import type * as Schemas from "@app/schemas";

export const WidgetStoreContext = createContext<StoreApi<Schemas.WidgetStore> | null>(null);

export function useWidgetStoreApi(): StoreApi<Schemas.WidgetStore> {
  const store = use(WidgetStoreContext);
  if (!store) throw new Error("useWidgetStore must be used inside the widget");
  return store;
}

export function useWidgetStore<T>(select: (state: Schemas.WidgetStore) => T): T {
  return useStore(useWidgetStoreApi(), select);
}

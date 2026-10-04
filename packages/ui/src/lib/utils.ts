import { createCn } from "cn/config";

// Companion type scale (`--text-*` in globals.css) merges as font size, not text colour.
// Apps alias the bare `cn` import used by shadcn components to this module.
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["page-title", "metric", "section", "body", "caption", "mono-value"] }],
    },
  },
});

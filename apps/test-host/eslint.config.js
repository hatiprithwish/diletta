import baseConfig from "../../eslint.config.js";
import tseslint from "typescript-eslint";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  ...baseConfig,
  prettier,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.worker,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
);

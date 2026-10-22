import baseConfig from "../../eslint.config.js";
import tseslint from "typescript-eslint";
import reactXPlugin from "eslint-plugin-react-x";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  ...baseConfig,
  prettier,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-x": reactXPlugin,
      "react-hooks": reactHooksPlugin,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...reactXPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      "react-x/react-in-jsx-scope": "off",
    },
  },
  {
    files: ["src/components/**"],
    rules: {
      "react-x/no-array-index-key": "off",
    },
  },
  // shadcn's use-mobile syncs from matchMedia in an effect; generated, never hand-edited. Hand-written hooks keep
  // the rule.
  {
    files: ["src/hooks/use-mobile.ts"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-x/set-state-in-effect": "off",
    },
  },
);

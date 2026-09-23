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
    files: ["**/shadcn/**"],
    rules: {
      "react-x/no-array-index-key": "off",
    },
  },
);

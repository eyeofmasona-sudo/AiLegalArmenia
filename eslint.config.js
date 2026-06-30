import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import customRules from "./eslint-rules/index.cjs";

export default tseslint.config(
  { ignores: ["dist", "eslint-rules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "custom": customRules,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      // Enforce Unicode escape sequences for non-ASCII characters (Armenian, Cyrillic, etc.)
      "custom/no-non-ascii-literals": "warn",
    },
  },
  {
    files: [
      "supabase/functions/_shared/build-embedding-text.ts",
      "supabase/functions/_shared/chunker.ts",
      "supabase/functions/_shared/normalizer.ts",
      "supabase/functions/_shared/pii-redactor.ts",
      "supabase/functions/_shared/prompt-armor.ts",
      "supabase/functions/_shared/text-preprocessor.ts",
      "supabase/functions/dictionary-import-run/index.ts",
      "supabase/functions/legal-practice-import/normalize-unicode.test.ts",
    ],
    rules: {
      "no-control-regex": "off",
      "no-misleading-character-class": "off",
      "no-useless-escape": "off",
    },
  },
  {
    files: [
      "supabase/functions/**/*.test.ts",
      "supabase/functions/_tests/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);

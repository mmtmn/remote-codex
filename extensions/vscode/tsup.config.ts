import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/extension.ts"],
  format: ["cjs"],
  external: ["vscode"],
  noExternal: ["@remote-codex/protocol", "qrcode", "ws"]
});

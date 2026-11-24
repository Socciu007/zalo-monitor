import { defineBundledChannelEntry, loadBundledEntryExportSync } from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";
import { startCaptureRuntime } from "./runtime.js";

export default defineBundledChannelEntry({
  id: "zalo-monitor",
  name: "Zalo Monitor",
  description:
    "Zalo Personal fork that captures every group message (including untagged ones) and forwards it to a backend.",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./zalouser/channel-plugin-api.js",
    exportName: "zalouserPlugin",
  },
  runtime: {
    specifier: "./zalouser/runtime-api.js",
    exportName: "setZalouserRuntime",
  },
  registerFull(api) {
    api.registerTool(
      (ctx) =>
        loadBundledEntryExportSync<OpenClawPluginToolFactory>(import.meta.url, {
          specifier: "./zalouser/api.js",
          exportName: "createZalouserTool",
        })(ctx),
      { name: "zalouser" },
    );
    startCaptureRuntime();
  },
});

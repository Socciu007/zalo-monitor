import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./zalouser/setup-plugin-api.js",
    exportName: "zalouserSetupPlugin",
  },
});

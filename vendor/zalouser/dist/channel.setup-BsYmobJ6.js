import { n as zalouserSetupWizard } from "./setup-surface-C8VXOMBu.js";
import { r as zalouserSetupAdapter, t as createZalouserPluginBase } from "./shared-xBuXIOwv.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };

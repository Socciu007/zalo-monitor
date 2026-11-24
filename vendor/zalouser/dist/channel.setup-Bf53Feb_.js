import { n as zalouserSetupWizard } from "./setup-surface-W1VQqpf0.js";
import { r as zalouserSetupAdapter, t as createZalouserPluginBase } from "./shared-BnQwl7bD.js";
//#region extensions/zalouser/src/channel.setup.ts
const zalouserSetupPlugin = { ...createZalouserPluginBase({
	setupWizard: zalouserSetupWizard,
	setup: zalouserSetupAdapter
}) };
//#endregion
export { zalouserSetupPlugin as t };

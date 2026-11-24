import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "./doctor-contract-mDJdHVKH.js";
import { n as isZalouserMutableGroupEntry } from "./security-audit-DhK2UscX.js";
import { DEFAULT_ACCOUNT_ID, createAccountListHelpers, normalizeAccountId, resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { AllowFromListSchema, DmPolicySchema, GroupPolicySchema, MarkdownConfigSchema, ToolPolicySchema, buildCatchallMultiAccountChannelSchema, buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { DEFAULT_ACCOUNT_ID as DEFAULT_ACCOUNT_ID$1, normalizeAccountId as normalizeAccountId$1 } from "openclaw/plugin-sdk/core";
import { isDangerousNameMatchingEnabled as isDangerousNameMatchingEnabled$1 } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { isNumericTargetId, sendPayloadWithChunkedTextAndMedia } from "openclaw/plugin-sdk/reply-payload";
import { adaptScopedAccountAccessor, createScopedChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { createDelegatedSetupWizardProxy, createPatchedAccountSetupAdapter, createSetupTranslator } from "openclaw/plugin-sdk/setup-runtime";
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { z } from "zod";
import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
//#region extensions/zalouser/src/accounts.ts
let zalouserAccountsRuntimePromise;
async function loadZalouserAccountsRuntime() {
	zalouserAccountsRuntimePromise ??= import("./accounts.runtime-UypUaEfF.js");
	return await zalouserAccountsRuntimePromise;
}
const { listAccountIds: listZalouserAccountIds, resolveDefaultAccountId: resolveDefaultZalouserAccountId } = createAccountListHelpers("zalouser", { implicitDefaultAccount: {
	channelKeys: ["profile"],
	envVars: ["ZALOUSER_PROFILE", "ZCA_PROFILE"]
} });
function mergeZalouserAccountConfig(cfg, accountId) {
	const merged = resolveMergedAccountConfig({
		channelConfig: cfg.channels?.zalouser,
		accounts: (cfg.channels?.zalouser)?.accounts,
		accountId,
		omitKeys: ["defaultAccount"]
	});
	return {
		...merged,
		groupPolicy: merged.groupPolicy ?? "allowlist"
	};
}
function resolveProfile(config, accountId) {
	if (config.profile?.trim()) return config.profile.trim();
	if (process.env.ZALOUSER_PROFILE?.trim()) return process.env.ZALOUSER_PROFILE.trim();
	if (process.env.ZCA_PROFILE?.trim()) return process.env.ZCA_PROFILE.trim();
	if (accountId !== DEFAULT_ACCOUNT_ID) return accountId;
	return "default";
}
function resolveZalouserAccountBase(params) {
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultZalouserAccountId(params.cfg));
	const baseEnabled = (params.cfg.channels?.zalouser)?.enabled !== false;
	const merged = mergeZalouserAccountConfig(params.cfg, accountId);
	return {
		accountId,
		enabled: baseEnabled && merged.enabled !== false,
		merged,
		profile: resolveProfile(merged, accountId)
	};
}
function resolveZalouserAccountSync(params) {
	const { accountId, enabled, merged, profile } = resolveZalouserAccountBase(params);
	return {
		accountId,
		name: normalizeOptionalString(merged.name),
		enabled,
		profile,
		authenticated: false,
		config: merged
	};
}
async function checkZcaAuthenticated(profile) {
	return await (await loadZalouserAccountsRuntime()).checkZaloAuthenticated(profile);
}
//#endregion
//#region extensions/zalouser/src/qr-temp-file.ts
async function writeQrDataUrlToTempFile(qrDataUrl, profile) {
	const base64 = (qrDataUrl.trim().match(/^data:image\/png;base64,(.+)$/i)?.[1] ?? "").trim();
	if (!base64) return null;
	const safeProfile = profile.replace(/[^a-zA-Z0-9_-]+/g, "-") || "default";
	const filePath = path.join(resolvePreferredOpenClawTmpDir(), `openclaw-zalouser-qr-${safeProfile}.png`);
	await fsp.writeFile(filePath, Buffer.from(base64, "base64"));
	return filePath;
}
//#endregion
//#region extensions/zalouser/src/setup-core.ts
const t = createSetupTranslator();
const channel = "zalouser";
const zalouserSetupAdapter = createPatchedAccountSetupAdapter({
	channelKey: channel,
	validateInput: () => null,
	buildPatch: () => ({})
});
function createZalouserSetupWizardProxy(loadWizard) {
	return createDelegatedSetupWizardProxy({
		channel,
		loadWizard,
		status: {
			configuredLabel: t("wizard.channels.statusLoggedIn"),
			unconfiguredLabel: t("wizard.channels.statusNeedsQrLogin"),
			configuredHint: t("wizard.channels.statusRecommendedLoggedIn"),
			unconfiguredHint: t("wizard.channels.statusRecommendedQrLogin"),
			configuredScore: 1,
			unconfiguredScore: 15
		},
		credentials: [],
		delegatePrepare: true,
		delegateFinalize: true
	});
}
//#endregion
//#region extensions/zalouser/src/config-schema.ts
const groupConfigSchema = z.object({
	enabled: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema
});
const ZalouserConfigSchema = buildCatchallMultiAccountChannelSchema(z.object({
	name: z.string().optional(),
	enabled: z.boolean().optional(),
	markdown: MarkdownConfigSchema,
	profile: z.string().optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: AllowFromListSchema,
	historyLimit: z.number().int().min(0).optional(),
	groupAllowFrom: AllowFromListSchema,
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	groups: z.object({}).catchall(groupConfigSchema).optional(),
	messagePrefix: z.string().optional(),
	responsePrefix: z.string().optional()
}));
//#endregion
//#region extensions/zalouser/src/doctor.ts
function asObjectRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
const zalouserDoctor = {
	dmAllowFromMode: "topOnly",
	groupModel: "hybrid",
	groupAllowFromFallbackToAllowFrom: false,
	warnOnEmptyGroupSenderAllowlist: false,
	legacyConfigRules,
	normalizeCompatibilityConfig,
	collectMutableAllowlistWarnings: createDangerousNameMatchingMutableAllowlistWarningCollector({
		channel: "zalouser",
		detector: isZalouserMutableGroupEntry,
		collectLists: (scope) => {
			const groups = asObjectRecord(scope.account.groups);
			return groups ? [{
				pathLabel: `${scope.prefix}.groups`,
				list: Object.keys(groups)
			}] : [];
		}
	})
};
//#endregion
//#region extensions/zalouser/src/shared.ts
const zalouserMeta = {
	id: "zalouser",
	label: "Zalo Personal",
	selectionLabel: "Zalo (Personal Account)",
	docsPath: "/channels/zalouser",
	docsLabel: "zalouser",
	blurb: "Zalo personal account via QR code login.",
	aliases: ["zlu"],
	order: 85,
	quickstartAllowFrom: false
};
const zalouserConfigAdapter = createScopedChannelConfigAdapter({
	sectionKey: "zalouser",
	listAccountIds: listZalouserAccountIds,
	resolveAccount: adaptScopedAccountAccessor(resolveZalouserAccountSync),
	defaultAccountId: resolveDefaultZalouserAccountId,
	clearBaseFields: [
		"profile",
		"name",
		"dmPolicy",
		"allowFrom",
		"historyLimit",
		"groupAllowFrom",
		"groupPolicy",
		"groups",
		"messagePrefix"
	],
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({
		allowFrom,
		stripPrefixRe: /^(zalouser|zlu):/i
	})
});
function createZalouserPluginBase(params) {
	return {
		id: "zalouser",
		meta: zalouserMeta,
		setupWizard: params.setupWizard,
		capabilities: {
			chatTypes: ["direct", "group"],
			media: true,
			reactions: true,
			threads: false,
			polls: false,
			nativeCommands: false,
			blockStreaming: true
		},
		doctor: zalouserDoctor,
		reload: { configPrefixes: ["channels.zalouser"] },
		configSchema: buildChannelConfigSchema(ZalouserConfigSchema),
		config: {
			...zalouserConfigAdapter,
			isConfigured: async (account) => await checkZcaAuthenticated(account.profile),
			describeAccount: (account) => describeAccountSnapshot({ account })
		},
		setup: params.setup
	};
}
//#endregion
export { DEFAULT_ACCOUNT_ID$1 as a, isNumericTargetId as c, checkZcaAuthenticated as d, listZalouserAccountIds as f, writeQrDataUrlToTempFile as i, normalizeAccountId$1 as l, resolveZalouserAccountSync as m, createZalouserSetupWizardProxy as n, chunkTextForOutbound as o, resolveDefaultZalouserAccountId as p, zalouserSetupAdapter as r, isDangerousNameMatchingEnabled$1 as s, createZalouserPluginBase as t, sendPayloadWithChunkedTextAndMedia as u };

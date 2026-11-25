import { t as collectZalouserSecurityAuditFindings } from "./security-audit-DhK2UscX.js";
import { a as listZaloGroupMembers, b as waitForZaloQrLogin, c as logoutZaloProfile, i as listZaloFriendsMatching, n as getZaloUserInfo, s as listZaloGroupsMatching, y as startZaloQrLogin } from "./zalo-js-C2Eq5K4i.js";
import { a as sendReactionZalouser, i as sendMessageZalouser } from "./send-_7W21n-G.js";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
//#region extensions/zalouser/src/probe.ts
async function probeZalouser(profile, timeoutMs) {
	try {
		const user = timeoutMs ? await Promise.race([getZaloUserInfo(profile), new Promise((resolve) => {
			setTimeout(() => resolve(null), resolveTimerTimeoutMs(timeoutMs, 1e3, 1e3));
		})]) : await getZaloUserInfo(profile);
		if (!user) return {
			ok: false,
			error: "Not authenticated"
		};
		return {
			ok: true,
			user
		};
	} catch (error) {
		return {
			ok: false,
			error: formatErrorMessage(error)
		};
	}
}
//#endregion
export { collectZalouserSecurityAuditFindings, getZaloUserInfo, listZaloFriendsMatching, listZaloGroupMembers, listZaloGroupsMatching, logoutZaloProfile, probeZalouser, sendMessageZalouser, sendReactionZalouser, startZaloQrLogin, waitForZaloQrLogin };

import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { postCaptureToBackend, type EbClientConfig } from "./eb-client.js";
import { listPendingRecords, markDelivered, markRejected, toBackendPayload, updateStatus } from "./queue.js";

const logger = createSubsystemLogger("zalo-monitor");

let inFlight: Promise<void> | null = null;

/**
 * Giao hết record đang chờ trong queue lên backend.
 * Single-flight: các lời gọi song song dùng chung một promise để không gửi trùng.
 */
export function flushPending(stateDir: string, config: EbClientConfig): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runFlush(stateDir, config).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runFlush(stateDir: string, config: EbClientConfig): Promise<void> {
  const records = await listPendingRecords(stateDir);
  for (const record of records) {
    const outcome = await postCaptureToBackend(config, toBackendPayload(record));
    if (outcome.kind === "delivered") {
      await markDelivered(stateDir, record, outcome.status);
      logger.info("message_forwarded", { groupId: record.groupId, messageId: record.messageId, status: outcome.status });
      continue;
    }
    if (outcome.kind === "rejected") {
      await markRejected(stateDir, record, outcome.status);
      logger.error("post_rejected_4xx", { groupId: record.groupId, messageId: record.messageId, status: outcome.status });
      continue;
    }
    await updateStatus(stateDir, { lastError: outcome.error, lastPostStatus: outcome.status });
    logger.error("post_failed_after_retries", { groupId: record.groupId, messageId: record.messageId, error: outcome.error });
    break;
  }
}

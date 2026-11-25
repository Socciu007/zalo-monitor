import type { BackendPayload } from "./normalize.js";

/** Cấu hình gọi backend: URL đích, timeout mỗi request, số lần thử tối đa và lịch delay giữa các lần retry. */
export interface EbClientConfig {
  backendUrl: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelaysMs: number[];
}

/**
 * Kết quả một lần POST:
 * - `delivered`: backend trả 2xx → đã giao.
 * - `rejected`: backend trả 4xx → backend từ chối payload này, không retry (sẽ fail y hệt).
 * - `failed`: 5xx / lỗi mạng / timeout → đã hết số lần thử, giữ record trong queue để replay sau.
 */
export type PostOutcome =
  | { kind: "delivered"; status: number }
  | { kind: "rejected"; status: number; error: string }
  | { kind: "failed"; status: number | null; error: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** setTimeout/AbortSignal.timeout tràn quá 2^31-1 ms sẽ fire sau ~1ms → timeout dài biến thành timeout tức thì. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * 4xx vẫn còn thử lại được: 408 (timeout phía server) và 429 (bị giới hạn tần suất)
 * là lỗi tạm thời — đẩy vào `rejected/` sẽ vĩnh viễn bỏ mất tin.
 */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 429]);

/**
 * POST payload 6 field lên backend.
 *
 * - 2xx → `delivered`.
 * - 4xx (trừ 408/429) → `rejected`, không retry (cùng payload sẽ bị từ chối y hệt).
 * - 408/429 → retry như lỗi tạm thời, hết lượt thì trả `failed` (giữ record trong queue).
 * - 5xx / lỗi mạng / timeout → retry với backoff `retryDelaysMs`, tối đa `maxAttempts` request
 *   (1 lần đầu + N-1 lần retry). Hết lượt thì trả `failed` để caller giữ record trong queue.
 */
export async function postCaptureToBackend(config: EbClientConfig, payload: BackendPayload): Promise<PostOutcome> {
  const attempts = Math.max(1, config.maxAttempts);
  const timeoutMs = Math.min(Math.max(1, config.timeoutMs), MAX_TIMEOUT_MS);
  let lastError = "post_failed_unknown";
  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(config.backendUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 300) {
        return { kind: "delivered", status: response.status };
      }
      if (response.status >= 400 && response.status < 500) {
        if (!RETRYABLE_CLIENT_STATUSES.has(response.status)) {
          return { kind: "rejected", status: response.status, error: `post_rejected_4xx:${response.status}` };
        }
        lastError = `post_failed_retryable_4xx:${response.status}`;
      } else {
        lastError = `post_failed_5xx:${response.status}`;
      }
    } catch (err) {
      lastStatus = null;
      lastError = `post_failed_network:${err instanceof Error ? err.message : String(err)}`;
    }
    if (attempt < attempts) {
      const delays = config.retryDelaysMs;
      const delay = delays.length > 0 ? (delays[attempt - 1] ?? delays[delays.length - 1] ?? 0) : 0;
      if (delay > 0) await sleep(delay);
    }
  }
  return { kind: "failed", status: lastStatus, error: lastError };
}

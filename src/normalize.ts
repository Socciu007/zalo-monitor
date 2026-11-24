/** Input thô của một tin nhắn Zalo group bị capture. */
export interface CaptureInput {
  rawBody: string;
  chatId: string;
  groupName?: string | undefined;
  senderId: string;
  senderName?: string | undefined;
  platform?: string | undefined;
}

/** Đúng 6 field backend mong đợi — không thêm, không bớt. */
export interface BackendPayload {
  platform: string;
  content: string;
  groupId: string;
  groupName: string;
  userId: string;
  senderName: string;
}

export const DEFAULT_PLATFORM = "zalo";

/**
 * Chuyển tin nhắn đã capture thành payload 6 field của backend.
 * `content` giữ nguyên verbatim — không trim, không chuẩn hoá newline, không escape.
 */
export function normalizeCapture(input: CaptureInput): BackendPayload {
  return {
    platform: input.platform ?? DEFAULT_PLATFORM,
    content: input.rawBody,
    groupId: input.chatId,
    groupName: input.groupName ?? "",
    userId: input.senderId,
    senderName: input.senderName ?? "",
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCapture } from "./normalize.js";

test("normalizeCapture trả đúng 6 field của backend", () => {
  const payload = normalizeCapture({
    rawBody: "  Xin chào  ",
    chatId: "123456",
    groupName: "Nhóm Test",
    senderId: "999",
    senderName: "An",
  });
  assert.deepEqual(Object.keys(payload).sort(), ["content", "groupId", "groupName", "platform", "senderName", "userId"]);
  assert.equal(payload.platform, "zalo");
  assert.equal(payload.content, "  Xin chào  ");
  assert.equal(payload.groupId, "123456");
  assert.equal(payload.groupName, "Nhóm Test");
  assert.equal(payload.userId, "999");
  assert.equal(payload.senderName, "An");
});

test("normalizeCapture không sửa nội dung (giữ newline, emoji, @tag)", () => {
  const raw = "dòng 1\ndòng 2 🚢 @bot ơi";
  const payload = normalizeCapture({ rawBody: raw, chatId: "1", groupName: "", senderId: "2", senderName: "" });
  assert.equal(payload.content, raw);
});

test("normalizeCapture dùng chuỗi rỗng cho groupName/senderName thiếu", () => {
  const payload = normalizeCapture({ rawBody: "x", chatId: "1", groupName: undefined, senderId: "2", senderName: undefined });
  assert.equal(payload.groupName, "");
  assert.equal(payload.senderName, "");
});

test("normalizeCapture cho phép override platform, mặc định là zalo", () => {
  const payload = normalizeCapture({ rawBody: "x", chatId: "1", senderId: "2", platform: "zalo-fork" });
  assert.equal(payload.platform, "zalo-fork");
  assert.equal(payload.groupName, "");
  assert.equal(payload.senderName, "");
});

# zalo-monitor

Openclaw **hook-only plugin, không tạo channel Zalo thứ hai** của `zalouser`: bắt **mọi** tin nhắn Zalo **trong group** — kể cả
tin không tag bot — rồi chuyển nguyên văn lên backend, để backend tự phân loại. @openclaw/zalouser vẫn là thành phần duy nhất kết nối Zalo qua zca-js. OpenClaw hiện hỗ trợ message_received để plugin quan sát content, sender, threadId, messageId, senderId và metadata mà không chiếm quyền dispatch.

Hành vi trả lời của bot **không đổi**: skill `maritime-sales-skill` vẫn chỉ trả lời tin nhắn tag
nó. Plugin này là **người quan sát**, không phải người trả lời.

> ⚠️ Zalo automation là tích hợp **không chính thức** — có nguy cơ tài khoản bị khoá/ban.

## Vì sao phải fork

Plugin channel `zalouser` của openclaw **bỏ rơi** tin nhắn group không tag bot *bên trong chính
plugin*, trước khi host — và trước khi bất kỳ skill/hook/agent nào — kịp nhìn thấy. Với
`requireMention: true` không có cách nào quan sát từ phía host.

Nên repo này fork plugin channel và cắm một **capture tap trước mention gate**.

## Nó làm gì

Với mỗi tin nhắn group mà channel nhận:

1. Ghi tin nhắn vào **queue bền vững** trên đĩa (`pending/`).
2. **POST** nguyên văn tới `http://localhost:3001/clientV2/sdAnalysis/analyzeAndSaveSdData`
   (body 6 field: `platform`, `content`, `groupId`, `groupName`, `userId`, `senderName`).
3. `2xx` → tiến checkpoint. `5xx` / lỗi mạng → retry lùi `1s → 4s → 16s` (tối đa 4 request).
   `4xx` → log `post_rejected_4xx`, đẩy vào `pending/rejected/` để soi, **không** retry.

Plugin **không** phân loại, **không** lọc, **không** bỏ tin nào — forward nguyên text. Việc phân
loại và loại nhiễu thuộc về backend.

## Cấu trúc

├── package.json
├── openclaw.plugin.json
├── tsconfig.json
└── src/
    ├── index.ts
    ├── normalize.ts
    └── eb-client.ts

## Cài vào openclaw

Repo này **là** một extension directory của openclaw. Copy nó vào chỗ cần dùng rồi link:

```bash
cd <đường-dẫn-mới>/zalo-monitor
npm install --legacy-peer-deps
```

```bash
openclaw plugins install --link <đường-dẫn-mới>/zalo-monitor
openclaw gateway restart
```

`--link` **không** copy/symlink — nó ghi đường dẫn vào `plugins.load.paths` trong
`~/.openclaw/openclaw.json`, nên gateway nạp code thẳng từ repo này. Sửa file ở đây rồi restart
gateway là xong, không cần cài lại.

> ⚠️ **Đừng chạy `openclaw plugins uninstall <id>` sau khi link.**
> Plugin này có id riêng (`zalo-monitor`) nên nó **không** đụng tới
> `channels.zalouser`;

## State & healthcheck

Mọi thứ nằm dưới state dir của openclaw (`~/.openclaw` mặc định):

```
<state-dir>/plugin-state/zalo-monitor/
├── checkpoint.json     # tin nhắn đã nhận, theo group
├── pending/            # queue bền vững (ghi trước, xoá sau khi backend nhận)
│   └── rejected/       # tin bị 4xx, chờ soi
└── status.json         # snapshot sau mỗi lần gửi
```

```json
{ "pending": 0, "rejected": 0, "lastPostAt": "...", "lastPostStatus": 201, "lastError": null, "updatedAt": "..." }
```

Log: `openclaw channels logs --channel zalouser` — các event là `message_forwarded`,
`post_rejected_4xx`, `post_failed_after_retries`, `capture_replayed_on_start`.

## Gate group

Quyền truy cập group do policy của channel trong `openclaw.js`
(`zalouser.groupPolicy` / `zalouser.groupAllowFrom`). Tap **không** tự lọc group — nó forward
đúng những gì channel nhận.

## Nguyên tắc thiết kế

**Observe → forward → persist.** Forward nguyên văn tin nhắn; không bịa, không tóm tắt, không sửa.

# zalo-monitor

Plugin OpenClaw — **fork** của channel plugin `@openclaw/zalouser` (Zalo Personal, chạy qua thư viện `zca-js` không chính thức).

Plugin capture **mọi** tin nhắn Zalo **trong group** — kể cả tin **không tag bot** — ghi vào queue bền vững trên đĩa rồi POST **nguyên văn** lên backend để backend tự phân loại.

> **Bảo đảm:** bot vẫn **chỉ trả lời** tin nhắn tag nó. Hành vi trả lời không đổi — plugin này chỉ quan sát, không trả lời, không lọc.

> **Bảo đảm giao tin:** **at-least-once** — tin không bao giờ mất, nhưng backend **phải chịu được duplicate** (xem [Bền vững](#bền-vững)).

> ⚠️ **Rủi ro:** Zalo automation là tích hợp **không chính thức** — tài khoản có nguy cơ bị khoá/ban. Fork này không làm thay đổi mức phơi nhiễm đó; nó chỉ quan sát những tin nhắn mà channel đã nhận.

## Vì sao phải fork

Channel plugin `zalouser` upstream **tự bỏ rơi** tin nhắn group không tag bot *bên trong chính plugin*, trước khi host OpenClaw kịp nhìn thấy. Trong `vendor/zalouser/dist/monitor-*.js`, hàm `processMessage()`:

```js
if (isGroup && mentionDecision.shouldSkip) {
    ...
    return;
}
```

Lệnh `return` này nằm **trước** `core.channel.inbound.dispatchReply(...)`. Hệ quả: các hook phía host mà một plugin thông thường dùng để quan sát **không bao giờ chạy** với tin không tag:

| Hook của host | Vì sao không dùng được |
|---|---|
| `message_received` | Được fire bên trong `dispatch-from-config` của host — **sau** cái gate trên. Hook này chỉ quan sát (không chiếm quyền dispatch), và với tin không tag thì không bao giờ tới được chỗ fire. |
| `before_dispatch` | Hook claiming: trả `{handled:true}` thì chặn được lượt chạy agent (không gọi model, không reply). Nhưng nó cũng chỉ chạy **sau** gate, nên cũng không thấy tin không tag. |
| `inbound_claim` | Có field `wasMentioned`, nhưng global runner trong build OpenClaw này **không có call site** cho inbound message thường (chỉ có biến thể targeted cho plugin-owned binding), nên không dựa vào được. |

Thêm nữa: mention native của Zalo là **một entity riêng** (`data.mentions` = danh sách user id), **không** nằm trong text. Chỉ channel plugin mới nhìn thấy `wasExplicitlyMentioned` và implicit mention (quote bot). Plugin phía host chỉ có thể suy ra mention từ text — không đủ fidelity.

⇒ Không có cách nào quan sát đầy đủ tin group không tag mà **không fork** channel plugin.

### Tap được cắm thế nào

`scripts/vendor-refresh.mjs` copy package `@openclaw/zalouser` từ `node_modules` vào `vendor/zalouser/`, **tìm file chứa `async function processMessage(` theo nội dung** (tên file là build hash, đổi mỗi release), rồi chèn **một import tĩnh + một lệnh gọi**:

```js
import { captureZaloMessage } from "../capture.js";
// ...
captureZaloMessage({
    isGroup,
    chatId,
    groupName,
    senderId,
    senderName,
    rawBody: message.content,
    mentioned: mentionDecision.effectiveWasMentioned,
    messageId: resolveZalouserMessageSid({ msgId: message.msgId, cliMsgId: message.cliMsgId, fallback: String(message.timestampMs) }),
    rootConfig: config
});
```

Tap nằm **sau** group/sender access gate và **trước** mention gate ⇒ capture đúng những gì channel nhận (không vượt policy) **và** kể cả tin không tag bot.

`rawBody: message.content` là text **chưa trim** (biến `rawBody` của upstream đã `.trim()` sẵn) ⇒ text forward đi **nguyên văn**.

Script **fail loudly** (exit non-zero) nếu không tìm thấy anchor, và không bao giờ thay cây vendor đang chạy bằng cây hỏng (stage → swap).

## Luồng xử lý

1. **Capture** — tap chạy non-blocking, fail-safe: lỗi capture chỉ được log, **không** ném exception ra channel, không chặn luồng chat.
2. **Ghi queue** — mỗi tin thành 1 file JSON trong `pending/`, ghi **trước** mọi lần gọi mạng.
3. **Giao** — worker flush đọc `pending/` (đơn giản single-flight) và POST lên backend.
4. **Xác nhận** — chỉ khi backend trả `2xx` mới **ghi checkpoint trước, rồi mới xoá file pending** ⇒ bảo đảm **at-least-once** (xem [Bền vững](#bền-vững)).

## Cấu trúc thư mục

```
e:\projectVN\zalo-monitor\
├─ package.json              # plugin "zalo-monitor"; scripts: build, test, typecheck, vendor:refresh, link:host-sdk
├─ openclaw.plugin.json      # manifest: id zalo-monitor, channels ["zalouser"], preferOver ["zalouser"]
├─ tsconfig.json
├─ .gitignore
├─ src\
│  ├─ index.ts               # plugin entry (defineBundledChannelEntry) — đăng ký channel + tool zalouser
│  ├─ setup-entry.ts         # setup entry (màn hình QR login)
│  ├─ runtime.ts             # flush timer + replay-on-start (nạp config của plugin ngay lúc khởi động)
│  ├─ capture.ts             # TAP: captureZaloMessage() — non-blocking, fail-safe
│  ├─ flush.ts               # delivery worker trên pending queue (single-flight)
│  ├─ eb-client.ts           # POST backend + retry/backoff (408/429 retryable)
│  ├─ queue.ts               # pending/ queue, checkpoint.json, status.json
│  ├─ normalize.ts           # payload 6 field gửi backend
│  ├─ config.ts              # settings từ plugins.entries["zalo-monitor"].config
│  ├─ state.ts               # state paths + atomic JSON writes
│  └─ *.test.ts              # 59 test, node:test
├─ scripts\
│  ├─ vendor-refresh.mjs     # vendor + patch upstream zalouser channel
│  ├─ copy-vendor.mjs        # build step: vendor/zalouser/dist → dist/zalouser
│  ├─ clean-dist.mjs         # build step: xoá dist/ trước khi tsc
│  └─ link-host-sdk.mjs      # trỏ node_modules/openclaw về bản cài openclaw của host
├─ vendor\zalouser\          # vendored, đã patch @openclaw/zalouser 2026.5.28 (23 file tracked)
├─ dist\                     # output của `npm run build` (entry plugin nạp từ đây)
└─ docs\superpowers\         # design spec + implementation plan
```

## Hợp đồng backend

`POST` tới `backendUrl`, body **đúng sáu field**:

```json
{
  "platform": "zalo",
  "content": "<text nguyên văn>",
  "groupId": "<chatId>",
  "groupName": "<tên group>",
  "userId": "<senderId>",
  "senderName": "<tên người gửi>"
}
```

| Kết quả | Hành động |
|---|---|
| `2xx` | **delivered** — ghi `checkpoint.json` **trước**, rồi xoá record khỏi queue. |
| `408` / `429` | **retryable** — lỗi **tạm thời** (server timeout / giới hạn tần suất) ⇒ **retry** cùng backoff `1s → 4s → 16s`, tối đa **4 request**; hết lượt thì **giữ record trong `pending/`** để giao lại sau. Nhãn lỗi: `post_failed_retryable_4xx:408` / `post_failed_retryable_4xx:429`. |
| `4xx` khác (400, 401, 403, 404, 422…) | **rejected** — **không retry**; record chuyển vào `pending/rejected/` và **không bao giờ được gửi lại tự động**. Operator phải **tự re-queue bằng tay** (xem [Duy trì state](#duy-trì-state)). |
| `5xx` / lỗi mạng / timeout | **retry** với backoff `1s → 4s → 16s`, tối đa **4 request**; hết lượt thì giữ record trong queue để giao lại sau. Nhãn lỗi: `post_failed_5xx:<status>` / `post_failed_network:<message>`. |

Plugin **không** phân loại, **không** lọc, **không** bỏ tin nào — forward nguyên text. Việc phân loại thuộc về backend.

### Re-queue tay một record bị từ chối

Record trong `pending/rejected/` **không** tự gửi lại. Muốn gửi lại thì chuyển file về `pending/` (giữ nguyên tên file `<id>.json` — `id` là hash tất định của `(groupId, messageId)`):

```bash
STATE="$(node -e "const p=require('node:path'),o=require('node:os');process.stdout.write(p.join(o.homedir(),'.openclaw','plugin-state','zalo-monitor'))")"
mv "$STATE/pending/rejected/<id>.json" "$STATE/pending/<id>.json"
```

Lượt flush kế tiếp sẽ gửi lại record đó.

## Bền vững

Bảo đảm của plugin là **at-least-once** (giao **ít nhất một lần**), **không** phải exactly-once.

- Tin nhắn được ghi vào đĩa **trước** bất kỳ lần gọi mạng nào.
- **Id record là tất định**: `buildRecordId(groupId, messageId)` = **32 ký tự hex** của SHA-1 trên `groupId\0messageId` — **không có timestamp**. Capture lại cùng một tin (zca-js reconnect, tap chạy lại) sẽ **ghi đè đúng file pending cũ** thay vì tạo file thứ hai ⇒ reconnect **không** giao trùng lên backend.
- Backend trả `2xx` ⇒ ghi `checkpoint.json` **trước**, rồi mới xoá file pending. Thứ tự này chọn **at-least-once**: nếu tiến trình chết **sau** khi backend đã trả `2xx` nhưng **trước** khi ghi checkpoint, record vẫn nằm trong `pending/` và **có thể được giao lại** ⇒ **backend phải chịu được duplicate**. Ngược lại (xoá file pending trước, ghi checkpoint sau) sẽ **mất tin** khi tiến trình chết giữa chừng — vì zca-js không bảo đảm giao lại tin đã gửi. ⇒ **Không có cửa sổ mất tin**, chỉ có thể giao trùng.
- Lượt flush bỏ qua (và dọn) record đã có trong `checkpoint.json` — file pending sót lại sau crash không bị gửi lại lần nữa.
- `checkpoint.json` ghi lại message id đã giao theo từng group ⇒ khi reconnect, tin đã giao không bị giao lại.
- Backend chết lâu ⇒ `pending/` tích tụ, tin không mất; lần khởi động sau sẽ replay (`capture_replayed_on_start`).

### Duy trì state

- `pending/`, `pending/rejected/` và `checkpoint.json` đều **phình theo thời gian**.
- `checkpoint.json` được **giới hạn 2000 message id mỗi group** — khi vượt ngưỡng, entry **cũ nhất bị bỏ trước**. ⇒ không vô hạn theo một group, nhưng **số group** thì không bị giới hạn.
- `status.json` là chỗ **theo dõi**: `pending` (đang chờ giao), `rejected` (bị 4xx từ chối vĩnh viễn), `lastPostAt`, `lastPostStatus`, `lastError`.
- `pending/rejected/` **không** được tự dọn — operator phải xem và dọn/cấu hình lại bằng tay.

## State trên đĩa

Nằm dưới state dir của OpenClaw (`~/.openclaw` mặc định):

```
<state-dir>/plugin-state/zalo-monitor/
├─ checkpoint.json     # { "<groupId>": { "<messageId>": { "at": "<iso>" } } } — tối đa 2000 id mỗi group
├─ pending/            # mỗi tin 1 file JSON: đã capture, chưa giao được
│  └─ rejected/        # tin backend từ chối bằng 4xx — không tự gửi lại, phải re-queue tay
└─ status.json         # { pending, rejected, lastPostAt, lastPostStatus, lastError, updatedAt }
```

```json
{
  "pending": 0,
  "rejected": 0,
  "lastPostAt": "2026-11-24T09:12:33.120Z",
  "lastPostStatus": 201,
  "lastError": null,
  "updatedAt": "2026-11-24T09:12:33.121Z"
}
```

Log: `message_forwarded`, `post_rejected_4xx`, `post_failed_after_retries`, `capture_replayed_on_start`, `capture_failed` — do subsystem `zalo-monitor` ghi ra. Xem bằng:

```bash
openclaw channels logs --channel all --lines 400
```

> `openclaw channels logs --channel zalouser` **không** hiện các dòng này: bộ lọc của lệnh đó chỉ match subsystem `gateway/channels/zalouser` hoặc module có chứa `zalouser`, còn log của plugin mang subsystem `zalo-monitor` ⇒ phải xem `--channel all`.

## Cấu hình

Đọc từ entry riêng của plugin trong `~/.openclaw/openclaw.json`:

```json5
"plugins": {
  "entries": {
    "zalo-monitor": {
      "enabled": true,
      "config": {
        "backendUrl": "http://localhost:3001/clientV2/sdAnalysis/analyzeAndSaveSdData",
        "timeoutMs": 10000,
        "maxAttempts": 4,
        "retryDelaysMs": [1000, 4000, 16000],
        "captureDm": false,
        "flushIntervalMs": 60000
      }
    }
  }
}
```

Mọi field đều **optional**; giá trị sai kiểu rơi về default chứ không làm sập channel. `captureDm: false` ⇒ chỉ capture tin nhắn **group**.

`backendUrl` cấu hình được **dùng ngay từ lúc khởi động**: runtime nạp config của chính plugin (`plugins.entries["zalo-monitor"].config`) trước khi replay backlog và trước khi hẹn timer ⇒ backlog cũng được POST về đúng backend đã cấu hình, không phải về default.

## Cài đặt

Thứ tự **bắt buộc** — làm đúng theo thứ tự dưới đây:

```bash
cd e:/projectVN/zalo-monitor
npm install --legacy-peer-deps   # (1) cài deps — BƯỚC NÀY LUÔN KHÔI PHỤC BẢN SDK THẬT TRONG REPO
npm run link:host-sdk            # (2) trỏ node_modules/openclaw về bản cài openclaw của HOST
npm run build                    # (3) build dist/
openclaw plugins install --link e:/projectVN/zalo-monitor   # (4) link plugin vào openclaw
```

`--link` ghi đường dẫn repo vào `plugins.load.paths` trong `~/.openclaw/openclaw.json` (không copy), nên sửa code ở repo này rồi restart gateway là xong, không cần cài lại.

### Vì sao phải `npm run link:host-sdk`

`openclaw` nằm trong **devDependencies** ⇒ `npm install` đặt một **bản thật** vào `<repo>/node_modules/openclaw`. Node resolve `openclaw/plugin-sdk/*` từ đó ⇒ process chạy plugin dùng **một SDK thứ hai**, khác SDK của host ⇒ **sau khi gateway nâng cấp, plugin vẫn chạy trên SDK cũ**.

`npm run link:host-sdk` thay thư mục đó bằng **symlink** (junction trên Windows) trỏ tới bản cài openclaw của host — đúng cách bản npm-installed `@openclaw/zalouser` làm. Script in ra host path, path của link và version của host; nếu không tìm thấy openclaw trên máy host thì **exit 1** kèm hướng dẫn.

> **Bắt buộc:** `npm install` **luôn** khôi phục bản thật trong `node_modules/openclaw` ⇒ **phải chạy lại `npm run link:host-sdk` sau mỗi lần `npm install`**, không chỉ một lần lúc cài đặt.
>
> `npm run build` **không** phụ thuộc script này (build được với bản thật trong repo). Với host cùng version `openclaw` như `devDependencies` thì build khi đã link cũng OK; nếu host lệch version và `npm run build` báo lỗi kiểu ⇒ build **trước**, link **sau**.

Sau đó sửa **`~/.openclaw/openclaw.json`**:

1. **BẮT BUỘC — tắt bản npm gốc** để chỉ có **một** kết nối Zalo: set `plugins.entries.zalouser.enabled` thành `false`. Bật cả hai sẽ chạy **hai** client `zca-js` trên cùng một tài khoản Zalo.
2. Thêm entry `zalo-monitor` như ở mục [Cấu hình](#cấu-hình).

```json5
{
  "plugins": {
    "entries": {
      // (1) BẮT BUỘC — tắt bản npm của zalouser
      "zalouser": {
        "enabled": false
      },
      // (2) Entry của zalo-monitor
      "zalo-monitor": {
        "enabled": true,
        "config": {
          "backendUrl": "http://localhost:3001/clientV2/sdAnalysis/analyzeAndSaveSdData",
          "timeoutMs": 10000,
          "maxAttempts": 4,
          "retryDelaysMs": [1000, 4000, 16000],
          "captureDm": false,
          "flushIntervalMs": 60000
        }
      }
    }
  }
}
```

Rồi restart gateway:

```bash
openclaw gateway restart
```

### Ai giữ channel `zalouser`? (thứ tự nạp quyết định)

OpenClaw đăng ký **đúng một** plugin cho mỗi channel id. Plugin **thua** (đăng ký sau) nhận diagnostic:

```
channel already registered: zalouser (<pluginId của người thắng>)
```

và **không đăng ký được** channel đó ⇒ channel thuộc về plugin thắng, **code channel của plugin thua (chứa tap) không bao giờ chạy**.

> `preferOver` (`"preferOver": ["zalouser"]` trong manifest) **không** có tác dụng ở đường này — nó chỉ quyết định **auto-enable**, không quyết định thắng/thua khi tranh channel.

⇒ Nếu bản npm `@openclaw/zalouser` đăng ký trước, `zalo-monitor` **thua channel** ⇒ **tap không bao giờ chạy** ⇒ plugin im lặng: không có `message_forwarded`, `checkpoint.json` không đổi, `status.json` đứng yên — và **không** có lỗi nào hiện ra ngoài diagnostic của `plugins doctor`.

Vì vậy sau mỗi lần restart gateway, **phải** kiểm tra:

```bash
openclaw plugins doctor
```

- Nếu in ra `channel already registered: zalouser (...)` ⇒ `zalo-monitor` đã thua channel ⇒ tắt bản npm (`plugins.entries.zalouser.enabled = false`) rồi restart lại.
- Nếu in `No plugin issues detected.` ⇒ không có xung đột channel.

## Kiểm tra sau cài

```bash
openclaw plugins list          # zalo-monitor enabled, zalouser (npm) disabled
openclaw plugins doctor        # KHÔNG có dòng "channel already registered"
openclaw channels status       # channel zalouser có đúng MỘT owner
openclaw channels logs --channel all --lines 200
```

- `openclaw plugins list` → `zalo-monitor` enabled, `zalouser` (bản npm) disabled.
- `openclaw plugins doctor` → **không** có diagnostic `channel already registered` (nếu có ⇒ tap sẽ không chạy, xem mục [Ai giữ channel `zalouser`?](#ai-giữ-channel-zalouser-thứ-tự-nạp-quyết-định)).
- `openclaw channels status` → channel `zalouser` có **đúng một** owner. Nếu có hai ⇒ bản npm chưa được tắt.
- `openclaw channels logs --channel all --lines 200` → thấy event `message_forwarded` sau khi có tin nhắn group.
- `<state-dir>/plugin-state/zalo-monitor/status.json` → `pending` về `0`.

## Checklist nghiệm thu end-to-end

Các bước dưới đây **không tự động hoá được** (cần boot gateway và gửi tin thật trong Zalo) ⇒ làm **tay** sau khi cài xong, theo thứ tự. Chuẩn bị trước:

```bash
# State dir của plugin (Windows + POSIX)
STATE="$(node -e "const p=require('node:path'),o=require('node:os');process.stdout.write(p.join(o.homedir(),'.openclaw','plugin-state','zalo-monitor'))")"

# Tổng số message id đã giao (checkpoint) — dùng để so trước/sau
node -e "const c=JSON.parse(require('node:fs').readFileSync(process.argv[1]+'/checkpoint.json','utf8'));console.log(Object.values(c).reduce((n,g)=>n+Object.keys(g||{}).length,0))" "$STATE"

# Log của plugin (subsystem zalo-monitor)
openclaw channels logs --channel all --lines 400
```

> Nhớ: `openclaw channels logs --channel zalouser` **không** hiện log của plugin ⇒ phải dùng `--channel all`.

---

### Kịch bản 1 — tin group **CÓ tag** bot

**Gửi:** trong một group **được allowlist**, gửi tin `@bot xin chào`.

**Kỳ vọng:** tin **được capture đúng một lần** (backend nhận **đúng 1** POST với 6 field) **và** bot **vẫn trả lời**.

**Kiểm tra:**

```bash
# 1. Plugin giao đúng 1 lần: đếm dòng message_forwarded cho messageId vừa gửi
openclaw channels logs --channel all --lines 400 | grep message_forwarded

# 2. Queue đã sạch, không có lỗi
node -e "console.log(require('node:fs').readFileSync(process.argv[1]+'/status.json','utf8'))" "$STATE"
#    → "pending": 0, "lastError": null, "lastPostStatus": 2xx

# 3. Checkpoint có messageId dưới đúng groupId (một entry duy nhất)
node -e "const c=JSON.parse(require('node:fs').readFileSync(process.argv[1]+'/checkpoint.json','utf8'));console.log(Object.keys(c['<groupId>']||{}))" "$STATE"

# 4. Không còn file pending cho tin đó
node -e "const fs=require('node:fs');console.log(fs.readdirSync(process.argv[1]+'/pending').filter(f=>f.endsWith('.json')))" "$STATE"
```

- **Backend nhận đúng 1 lần:** kiểm tra access log của backend — đúng **một** POST tới `<backendUrl>` với `content` đúng bằng nội dung vừa gửi, body có **đúng 6 field**.
- **Bot vẫn trả lời:** nhìn trong group — bot phải trả lời tin vừa tag (đây là hành vi của channel, không phải của plugin).

---

### Kịch bản 2 — tin group **KHÔNG tag** bot

**Gửi:** trong cùng group, gửi tin thường (không `@bot`).

**Kỳ vọng:** tin **được capture đúng một lần** (backend nhận **đúng 1** POST) **và** bot **im lặng**.

**Kiểm tra:** y hệt Kịch bản 1, nhưng thêm hai điều:

```bash
# Số message id trong checkpoint PHẢI TĂNG đúng 1
node -e "const c=JSON.parse(require('node:fs').readFileSync(process.argv[1]+'/checkpoint.json','utf8'));console.log(Object.values(c).reduce((n,g)=>n+Object.keys(g||{}).length,0))" "$STATE"

# Log PHẢI có dòng "zalouser: skip group ... (mention required, not mentioned)"
# → bằng chứng channel đã bỏ qua tin không tag, bot không chạy agent
# (dòng này chỉ hiện khi bật log level verbose)
openclaw channels logs --channel all --lines 400 | grep "skip group"
```

- **Bot im lặng:** nhìn trong group — bot **không** trả lời tin không tag.

---

### Kịch bản 3 — tin **DM**

**Gửi:** nhắn tin trực tiếp (DM) cho bot.

**Kỳ vọng:** tin DM **không** được capture (mặc định `captureDm: false`).

**Kiểm tra:**

```bash
# 1. Không có message_forwarded mới cho tin DM
openclaw channels logs --channel all --lines 400 | grep message_forwarded

# 2. Số message id trong checkpoint KHÔNG đổi so với trước khi gửi
node -e "const c=JSON.parse(require('node:fs').readFileSync(process.argv[1]+'/checkpoint.json','utf8'));console.log(Object.values(c).reduce((n,g)=>n+Object.keys(g||{}).length,0))" "$STATE"

# 3. pending/ không có file mới cho tin DM
node -e "const fs=require('node:fs');console.log(fs.readdirSync(process.argv[1]+'/pending').filter(f=>f.endsWith('.json')))" "$STATE"
```

> Lưu ý: nếu bật `captureDm: true` thì DM **có** được capture — kịch bản này chỉ áp dụng cho cấu hình mặc định.

---

### Kịch bản 4 — tin trong group **ngoài allowlist**

**Gửi:** gửi tin trong một group **không** nằm allowlist (`groupPolicy: allowlist`).

**Kỳ vọng:** tin **không** được capture — tap nằm **sau** access gate nên tin bị chặn **trước** khi tới tap.

**Kiểm tra:**

```bash
# 1. Log của kênh phải có dòng "drop group ... not allowlisted" (bật log level verbose)
openclaw channels logs --channel all --lines 400 | grep "drop group"

# 2. Số message id trong checkpoint KHÔNG đổi
node -e "const c=JSON.parse(require('node:fs').readFileSync(process.argv[1]+'/checkpoint.json','utf8'));console.log(Object.values(c).reduce((n,g)=>n+Object.keys(g||{}).length,0))" "$STATE"

# 3. pending/ không có file mới
node -e "const fs=require('node:fs');console.log(fs.readdirSync(process.argv[1]+'/pending').filter(f=>f.endsWith('.json')))" "$STATE"
```

---

**Kết luận checklist:** đủ 4 kịch bản pass ⇒ plugin capture đúng nhóm tin, đúng một lần, và **không** thay đổi hành vi trả lời của bot.

## Nâng cấp `@openclaw/zalouser`

```bash
# 1. bump version @openclaw/zalouser trong package.json
npm install --legacy-peer-deps
npm run link:host-sdk      # npm install vừa khôi phục bản SDK thật trong repo → link lại
npm run vendor:refresh
npm run build
openclaw gateway restart
openclaw plugins doctor    # không có "channel already registered"
```

Nếu cấu trúc file upstream thay đổi, `vendor:refresh` **fail loudly** và cây vendor cũ được giữ nguyên — không bao giờ thay bằng cây hỏng.

## Development

```bash
npm run build       # tsc + copy vendor → dist/
npm test            # 59 test, node:test (chạy trên JS đã build)
npm run typecheck   # tsc --noEmit
```

## Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Zalo automation không chính thức ⇒ khoá/ban tài khoản | Cảnh báo ở đầu README; fork không thay đổi mức phơi nhiễm, chỉ quan sát tin channel đã nhận. |
| Quên tắt bản npm ⇒ hai kết nối Zalo | Bước 1 ở mục *Cài đặt* là bắt buộc; kiểm tra bằng `openclaw channels status`. |
| Bản npm đăng ký channel trước ⇒ `zalo-monitor` thua channel, **tap không chạy (no-op im lặng)** | `preferOver` không cứu được; phải tắt bản npm và kiểm tra `openclaw plugins doctor` sau mỗi lần restart. |
| `npm install` khôi phục bản SDK cũ trong repo ⇒ plugin chạy trên SDK không phải của host | `npm run link:host-sdk` là bước bắt buộc **sau mỗi** `npm install`; script in ra host path + version để đối chiếu. |
| Backend chết lâu ⇒ `pending/` phình | `status.json` + `pending/rejected/` để soi; tin không mất. |
| `4xx` (không phải 408/429) ⇒ tin bị từ chối **vĩnh viễn** | Record nằm trong `pending/rejected/`, không tự gửi lại — operator phải re-queue tay; theo dõi `status.json`. |
| Backend nhận trùng tin (duplicate) | Đây là hệ quả **có chủ ý** của bảo đảm at-least-once; backend phải chịu được duplicate. |
| Fork lệch khi upstream nâng cấp | `vendor-refresh` fail-safe; version pin trong `package.json`. |
| Tap làm chậm luồng chat | Tap non-blocking, không await network, fail-safe. |

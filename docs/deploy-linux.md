# Cài đặt `zalo-monitor` trên máy chủ Linux

Tài liệu này hướng dẫn cài plugin `zalo-monitor` (fork của channel plugin `@openclaw/zalouser`) trên một máy chủ Linux — VPS, máy chủ nội bộ, container có quyền ghi ra đĩa.

> **Bản chốt tương đương với bản Windows** đã chạy ở local. Mọi khác biệt đều nằm ở cách cài openclaw, cách chạy service và cách đăng nhập Zalo bằng QR khi không có màn hình.

## 0. Tóm tắt: Linux khác Windows ở chỗ nào

| Việc | Windows (đã làm) | Linux |
|---|---|---|
| Cài openclaw | npm global trên Windows | npm global, root ở `<prefix>/lib/node_modules/openclaw` |
| Chạy gateway | Windows Scheduled Task | systemd **user** unit (mặc định) hoặc system unit |
| Đăng nhập Zalo | quét QR trên cùng máy | QR được ghi ra file PNG → copy về laptop để quét |
| Đường dẫn state | `C:\Users\<u>\.openclaw` | `~/.openclaw` |
| Script `link:host-sdk` | tạo **junction** | tạo **symlink** (script tự xử lý) |
| Lỗi `fs.rename` → `EPERM` | có, đã xử lý bằng retry | không có (POSIX không khoá file khi rename) |
| `nvm` / đổi Node version | ảnh hưởng symlink SDK | **cũng ảnh hưởng** — xem §9.1 |

## 1. Yêu cầu

- **Node.js 22.19+ (LTS) hoặc 24** — openclaw khuyến nghị Node 24; Node 22 LTS vẫn chạy tốt. Kiểm tra: `node -v`.
  > ⚠️ Bản `openclaw` dùng `Array.prototype.toSorted` — cần Node 20+. Node 16/18 sẽ **không** load được plugin.
- Máy chủ có outbound HTTPS tới Zalo (zca-js) và tới backend của bạn.
- Một tài khoản Zalo để quét QR (chỉ dùng lúc đăng nhập lần đầu).
- User hệ thống riêng cho gateway (không chạy bằng `root`).

## 2. Cài openclaw

```bash
# Node — dùng node source hoặc nvm; xem §9.1 về hệ quả với nvm
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

npm i -g openclaw@latest
openclaw --version
```

Đặt biến môi trường cho đường dẫn global (để `link-host-sdk` tìm đúng bản cài):

```bash
npm root -g     # ví dụ: /usr/lib/node_modules  hoặc  ~/.nvm/versions/node/v24.x/lib/node_modules
```

## 3. Cài plugin

```bash
# 1. đưa code lên máy chủ
sudo -u deploy git clone <url-repo> /opt/zalo-monitor
# hoặc: rsync -a --exclude node_modules --exclude dist ./ /opt/zalo-monitor/

cd /opt/zalo-monitor

# 2. cài dependency + build
npm ci --legacy-peer-deps
npm run build

# 3. BẮT BUỘC: trỏ node_modules/openclaw về SDK của host
npm run link:host-sdk
```

**Bước 3 không được bỏ qua.** `openclaw` nằm trong `devDependencies`, nên `npm ci` đặt một **bản thật** của SDK vào `node_modules/openclaw`; Node sẽ resolve `openclaw/plugin-sdk/*` từ đó — tức là tiến trình chạy plugin dùng **SDK thứ hai**, khác SDK của gateway. Sau khi gateway nâng cấp, plugin vẫn chạy trên SDK cũ. Script `link:host-sdk` thay bản đó bằng symlink tới bản cài global của host, giống hệt cách bản npm `@openclaw/zalouser` làm.

> Sau **mỗi lần** `npm ci` / `npm install`, phải chạy lại `npm run link:host-sdk` — `npm install` sẽ khôi phục lại bản thật.

Kiểm tra lại:

```bash
ls -l node_modules/openclaw        # phải là symlink → <prefix>/lib/node_modules/openclaw
node -e "console.log(require('./node_modules/openclaw/package.json').version)"
```

Đăng ký plugin vào openclaw:

```bash
openclaw plugins install --link /opt/zalo-monitor
openclaw plugins list | grep -i zalo
```

Kết quả mong đợi: `Zalo Monitor | zalo-monitor | openclaw | enabled | /opt/zalo-monitor/dist/index.js`.

> Dùng **đường dẫn tuyệt đối**. `--link` ghi đường dẫn vào `plugins.load.paths` trong `~/.openclaw/openclaw.json` — đường dẫn tương đối sẽ hỏng khi systemd chạy service với working directory khác.

## 4. Cấu hình `~/.openclaw/openclaw.json`

Ba chỗ cần sửa. **Đừng nhầm channel id với plugin id**: channel id là `zalouser`, plugin id là `zalo-monitor`.

```json5
{
  "channels": {
    "zalouser": {
      "enabled": true,              // (1) BẬT channel — fork của chúng ta cung cấp channel này
      "dmPolicy": "open",
      "allowFrom": ["*"],
      "groupPolicy": "open",
      "groups": { "*": { "enabled": true, "requireMention": true } },
      "groupAllowFrom": ["*"]
    }
    // KHÔNG được có "zalo-monitor" ở đây — sẽ báo "unknown channel id"
  },
  "plugins": {
    "entries": {
      "zalouser": { "enabled": false },   // (2) TẮT plugin npm gốc — tránh tranh channel
      "zalo-monitor": {                   // (3) BẬT plugin fork + config của nó
        "enabled": true,
        "config": {
          "backendUrl": "http://127.0.0.1:3001/clientV2/sdAnalysis/analyzeAndSaveSdData",
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

Ba điểm dễ sai:

1. **`channels.zalouser.enabled` phải là `true`.** Đây là công tắc bật *channel*; tắt nó thì fork cũng không chạy.
2. **`plugins.entries.zalouser.enabled` phải là `false`.** Đây mới là *plugin npm* gốc. openclaw chỉ cho phép **một** plugin giữ mỗi channel id; kẻ thua bị bỏ qua với diagnostic `channel already registered`. `preferOver` **không** ảnh hưởng đường này (nó chỉ dẫn auto-enable) — nếu plugin npm đăng ký trước, tap của chúng ta sẽ **không chạy, im lặng**. Vì vậy tắt plugin npm là bắt buộc.
3. **Config của plugin nằm ở `plugins.entries["zalo-monitor"].config`**, không phải ở `channels.*`.

Kiểm tra:

```bash
openclaw config validate
openclaw plugins doctor        # không được có "channel already registered"
```

## 5. Chạy gateway như service

### 5.1. systemd user unit (mặc định, đơn giản nhất)

```bash
openclaw onboard --install-daemon     # hoặc: openclaw gateway install
systemctl --user enable --now openclaw-gateway.service
systemctl --user status openclaw-gateway.service
```

Unit nằm ở `~/.config/systemd/user/openclaw-gateway.service`.

Với máy chủ yếu, thêm tuning (theo khuyến nghị chính thức của openclaw cho VM nhỏ):

```bash
mkdir -p /var/tmp/openclaw-compile-cache
systemctl --user edit openclaw-gateway.service
```

```ini
[Service]
Environment=OPENCLAW_NO_RESPAWN=1
Environment=NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
Restart=always
RestartSec=2
TimeoutStartSec=90
```

```bash
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
```

### 5.2. system unit (máy chạy 24/7, nhiều user dùng chung)

User unit dừng khi user logout. Với máy chủ luôn bật, dùng system unit:

```bash
sudo systemctl edit openclaw-gateway.service   # nếu đã cài system unit
```

Phải chạy gateway bằng **user không phải root**, và user đó phải sở hữu `~/.openclaw` (nơi chứa credential Zalo) và `/opt/zalo-monitor`.

### 5.3. Truy cập Control UI từ laptop

Control UI chỉ bind loopback. Dùng SSH tunnel:

```bash
ssh -N -L 18789:127.0.0.1:18789 <user>@<host>
# rồi mở http://127.0.0.1:18789/ và đăng nhập bằng token
```

Token nằm ở `gateway.auth.token` trong `~/.openclaw/openclaw.json`.

## 6. Đăng nhập Zalo bằng QR trên máy không có màn hình

Lệnh `openclaw channels login` tạo QR, ghi ra **file PNG** trong thư mục tạm của openclaw, rồi chờ tối đa **180 giây**:

```bash
openclaw channels login --channel zalouser
```

Trong log sẽ có dòng:

```
Scan QR image: /tmp/openclaw/openclaw-zalouser-qr-default.png
```

Thực hiện trên máy chủ:

```bash
# tìm file QR (thư mục tạm có thể là /tmp/openclaw hoặc $TMPDIR/openclaw)
find /tmp ~/.openclaw -name 'openclaw-zalouser-qr-*.png' 2>/dev/null

# copy về laptop để quét
scp <user>@<host>:/tmp/openclaw/openclaw-zalouser-qr-default.png .
```

Quét bằng app Zalo trên điện thoại trong vòng 3 phút. Thành công thì credential được ghi vào:

```
~/.openclaw/credentials/zalouser/credentials.json
```

Kiểm tra:

```bash
openclaw channels status --probe
```

Cookie Zalo có **thời hạn** (thường vài tuần–vài tháng). Hết hạn thì channel báo `not configured` và phải đăng nhập lại — nên đặt lịch nhắc.

## 7. Nghiệm thu 4 kịch bản

Sau khi đăng nhập và có tin nhắn thật:

```bash
# nơi theo dõi
cat ~/.openclaw/plugin-state/zalo-monitor/status.json
cat ~/.openclaw/plugin-state/zalo-monitor/checkpoint.json
ls ~/.openclaw/plugin-state/zalo-monitor/pending/        # phải rỗng nếu backend nhận hết
```

| # | Kịch bản | Mong đợi |
|---|---|---|
| 1 | Tin group **có** @bot | Backend nhận 1 lần; **bot vẫn trả lời** |
| 2 | Tin group **không** @bot | Backend nhận 1 lần; **bot im lặng** |
| 3 | Tin **DM** | Backend **không** nhận |
| 4 | Tin trong group **ngoài allowlist** | Backend **không** nhận |

Đọc log của plugin (log nằm dưới subsystem `zalo-monitor`, nên `--channel zalouser` **không** bắt được — phải dùng `--channel all`):

```bash
openclaw channels logs --channel all | grep zalo-monitor
```

Kỳ vọng thấy `message_forwarded` (INFO). Nếu backend chết: `post_failed_after_retries` và file vẫn nằm trong `pending/` — không mất tin.

## 8. Vận hành

### Nâng cấp plugin

```bash
cd /opt/zalo-monitor
git pull
npm ci --legacy-peer-deps
npm run build
npm run link:host-sdk        # BẮT BUỘC sau npm ci
openclaw gateway restart
```

### Nâng cấp openclaw (gateway)

```bash
sudo npm i -g openclaw@latest
openclaw gateway restart
```

Sau khi gateway lên version mới, **kiểm tra lại symlink SDK** trong repo — nếu openclaw được cài bằng nvm, đường dẫn global đổi theo version Node:

```bash
npm run link:host-sdk
```

### Dọn `pending/rejected/`

Tin bị backend từ chối bằng 4xx (trừ 408/429) nằm vĩnh viễn trong `pending/rejected/`, **không** được retry tự động. Muốn gửi lại thì đưa file về `pending/` rồi chờ lượt flush kế tiếp:

```bash
cd ~/.openclaw/plugin-state/zalo-monitor
mv pending/rejected/<id>.json pending/
```

### Theo dõi

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | grep zalo-monitor
du -sh ~/.openclaw/plugin-state/zalo-monitor/*        # pending/rejected/checkpoint phình theo thời gian
```

`checkpoint.json` bị giới hạn 2000 message id mỗi group (bỏ cũ nhất), nhưng `pending/` và `pending/rejected/` thì không — cần dọn thủ công nếu backend trả 4xx hàng loạt.

## 9. Những cái bẫy riêng của Linux

### 9.1. `nvm` làm hỏng symlink SDK

`link-host-sdk` trỏ tới `<prefix>/lib/node_modules/openclaw`. Với nvm, prefix đó là `~/.nvm/versions/node/v<version>/lib/node_modules` — **đổi mỗi lần đổi Node version**. Sau `nvm use` (hoặc khi systemd chạy service bằng version Node khác với shell của bạn), symlink sẽ trỏ tới thư mục không tồn tại → plugin không load được.

Cách xử lý:
- **Khuyến nghị:** cài openclaw bằng Node **cài hệ thống** (nodejs.org tarball hoặc apt), không dùng nvm. Khi đó prefix ổn định.
- Nếu buộc dùng nvm: chạy `npm run link:host-sdk` sau mỗi lần đổi version, và đảm bảo service systemd dùng **cùng** Node version (qua `Environment=PATH=...` trong unit).

### 9.2. `npm ci` xoá symlink

`npm ci` xoá sạch `node_modules` → symlink SDK biến mất, và `npm install` sẽ tạo lại bản thật. Luôn chạy `npm run link:host-sdk` sau đó.

### 9.3. systemd user unit dừng khi logout

Nếu gateway phải chạy 24/7 dù không ai đăng nhập SSH, dùng **system unit** (§5.2) hoặc bật `loginctl enable-linger <user>`.

### 9.4. Thư mục tạm bị dọn

File QR nằm ở thư mục tạm (`/tmp/openclaw/…`). Trên VPS có `systemd-tmpfiles` dọn `/tmp` theo lịch — file QR chỉ cần trong 3 phút nên không sao, nhưng log gateway cũng nằm ở `/tmp/openclaw/` và sẽ **mất khi reboot** nếu `/tmp` không được ghi lâu dài. Cân nhắc đặt `TMPDIR` riêng cho service, ví dụ:

```ini
[Service]
Environment=TMPDIR=/var/lib/openclaw-tmp
```

và tạo thư mục đó với quyền ghi cho user chạy service.

### 9.5. Không có `EPERM` khi rename

Bản Windows cần retry `fs.rename` khi tranh chấp file (đã xử lý trong `state.ts`). Trên Linux không có hành vi đó nên phần retry đó chỉ là vô hại — **không** cần sửa gì.

### 9.6. Quyền sở hữu

User chạy gateway phải sở hữu:
- `/opt/zalo-monitor` (gồm `node_modules/` và `dist/`)
- `~/.openclaw/` (chứa credential Zalo và state của plugin)

Nếu clone bằng `sudo` rồi chạy service bằng user khác → plugin sẽ không đọc được credential.

## 10. Đối chiếu nhanh Windows ↔ Linux

| Bước | Windows | Linux |
|---|---|---|
| Cài openclaw | `npm i -g openclaw` | `npm i -g openclaw` (root ở `lib/node_modules`) |
| Cài deps | `npm install --legacy-peer-deps` | `npm ci --legacy-peer-deps` |
| Build | `npm run build` | `npm run build` |
| Trỏ SDK host | `npm run link:host-sdk` (junction) | `npm run link:host-sdk` (symlink) |
| Link plugin | `openclaw plugins install --link <abs>` | `openclaw plugins install --link <abs>` |
| Tắt plugin npm | `plugins.entries.zalouser.enabled=false` | như cột bên trái |
| Bật channel | `channels.zalouser.enabled=true` | như cột bên trái |
| Config plugin | `plugins.entries["zalo-monitor"].config` | như cột bên trái |
| Service | Scheduled Task `OpenClaw Gateway` | `systemctl --user enable --now openclaw-gateway.service` |
| QR login | quét tại chỗ | `scp` file PNG về laptop để quét |
| Log plugin | `openclaw channels logs --channel all` | như cột bên trái |
| State | `%USERPROFILE%\.openclaw\plugin-state\zalo-monitor` | `~/.openclaw/plugin-state/zalo-monitor` |

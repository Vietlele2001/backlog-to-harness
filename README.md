# Autonomous Backlog-to-Harness Stream-Aligned Pipeline

Repository tích hợp tự động giữa **GitHub Issues (Backlog)** và **DeepSeek Harness (DSH Engine)**, thiết lập chu trình tự trị khép kín:
**Backlog Task $\to$ Webhook Dispatcher $\to$ Atomic Task Lock $\to$ DSH Headless Execution $\to$ QA Gate $\to$ Review Ready**.

---

## 1. Kiến trúc Tổng thể (C4 Level 2 Container)

```
+-------------------------------------------------------------------------------+
| GitHub Repository: Vietlele2001/backlog-to-harness                            |
|                                                                               |
|  [ Product Backlog ] --(assign label 'status:ready')--> [ GitHub Webhook /   |
|                                                           Actions Trigger ]   |
+-----------------------------------------------------------------------+-------+
                                                                        |
                                            HTTP POST /webhook/github   |
                                            (X-Hub-Signature-256)       v
+-------------------------------------------------------------------------------+
| DSH Webhook Dispatcher Service (Node.js)                                      |
|                                                                               |
|  1. Xác thực HMAC SHA-256 Signature.                                          |
|  2. Lọc sự kiện: action = 'labeled', label = 'status:ready' | 'type:ci-repair'|
|  3. Atomic Task Locking (Chống race condition):                               |
|     - Remove label 'status:ready'                                             |
|     - Add label 'status:in-progress'                                          |
|     - Post audit comment lên issue                                            |
|  4. Kích hoạt DSH Engine (dsh --profile headless / Cordis Webhook Runtime)    |
+-----------------------------------------------------------------------+-------+
                                                                        |
                                              Invoke Headless Session   v
+-------------------------------------------------------------------------------+
| DeepSeek Harness (DSH) Autonomous Execution Engine                            |
|                                                                               |
|  - Mount Workspace & C4 Architecture Spec                                     |
|  - Viết code, chạy test, thực hiện Fast Auto-Healing                          |
|  - Khi thành công: chuyển nhãn -> 'status:review-ready'                       |
|  - Khi gặp bế tắc: chuyển nhãn -> 'need:human-input' (Escalation)            |
+-------------------------------------------------------------------------------+
```

---

## 2. Hệ thống Nhãn Chuẩn C4 (State Machine)

| Label | Màu sắc | Vai trò trong State Machine |
|---|---|---|
| `status:ready` | `#0e8a16` | Task đã đạt DoR, sẵn sàng để Dispatcher tiếp nhận |
| `status:in-progress` | `#fbca04` | Task đã được **Atomic Locked**, DSH Session đang thực thi |
| `status:review-ready` | `#1d76db` | Agent hoàn tất code & pass tests, chờ Human Review |
| `type:ci-repair` | `#d93f0b` | Fast Auto-Healing Loop khi CI/CD gặp lỗi |
| `need:human-input` | `#e99695` | Bế tắc kỹ thuật, yêu cầu Human Developer can thiệp |
| `status:done` | `#6f42c1` | Pull Request đã merge, tính năng hoàn thành |
| `type:story` | `#5319e7` | User Story tính năng phân rã từ backlog |

---

## 3. Cấu trúc Repository

```
.
├── .github/
│   └── workflows/
│       └── agent-dispatch.yml      # GitHub Actions Autonomous Dispatcher
├── config/
│   └── cordis.patch.yml            # DSH Cordis Webhook Plugin Layer configuration
├── tools/
│   └── webhook-dispatcher.mjs      # Standalone Node.js Webhook Server & Dispatcher
├── tests/
│   └── webhook-dispatcher.test.mjs # Automated unit & integration test suite
├── package.json
└── README.md
```

---

## 4. Hướng dẫn Vận hành & Kiểm thử

### 4.1. Chạy Bộ Kiểm thử Tự động (Unit & Integration Tests)
```bash
npm test
# hoặc
node tests/webhook-dispatcher.test.mjs
```
Kết quả: **16/16 tests passing** (xác thực HMAC, lọc nhãn, atomic lock, prompt builder, HTTP endpoints).

### 4.2. Khởi chạy Webhook Dispatcher Server
```bash
# Khởi chạy server ở cổng 3085
export GITHUB_WEBHOOK_SECRET="your_webhook_secret_here"
export GITHUB_TOKEN="ghp_your_github_token_here"
npm start
```

### 4.3. Giả lập Event Webhook (Dry-Run / Simulation Mode)
```bash
# Giả lập tiếp nhận Issue #42 với nhãn status:ready
node tools/webhook-dispatcher.mjs --simulate-issue 42 --label status:ready --dry-run
```

---

## 5. Tác giả & Giấy phép
- **Nhóm dự án:** Autonomous Stream-Aligned Team (`Vietlele2001/backlog-to-harness`)
- **Giấy phép:** MIT

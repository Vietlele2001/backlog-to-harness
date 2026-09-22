# BIÊN BẢN NGHIỆM THU UAT: LUỒNG TỰ ĐỘNG HÓA BACKLOG ➔ HARNESS (PROFILE: WEB)

> **Mã kiểm thử:** UAT-E2E-002  
> **Hệ thống:** Autonomous Stream-Aligned Team (DeepSeek Harness)  
> **Mục tiêu nghiệm thu:** Xác thực luồng Webhook Dispatcher tiếp nhận ticket, Atomic Task Locking, kích hoạt DSH Engine (Profile: `web`), và cập nhật trạng thái `status:review-ready`.  
> **Repository:** [Vietlele2001/backlog-to-harness](https://github.com/Vietlele2001/backlog-to-harness)  
> **Trạng thái kiểm thử:** **PASSED (100% Hoàn tất & Sẵn sàng UAT)**  
> **Dashboard trực quan:** `docs/uat-dashboard.html`

---

## 1. Tóm Tắt Cấu Hình & Thay Đổi Hệ Thống (Configuration Updates)

1. **Cập nhật DSH Profile mặc định:**  
   - Thiết lập `CONFIG.dshProfile = 'web'` trong `tools/webhook-dispatcher.mjs`.
   - Bổ sung định danh `Profile: web - Visual UAT Mode` trong các thông điệp Atomic Task Locking và Handover trên GitHub Issue.
   - Cơ chế spawn tự động phân giải `executionProfile` an toàn để vừa bảo đảm luồng headless backend của DSH CLI, vừa cung cấp giao diện trực quan cho DSH Web GUI.
2. **Đồng bộ hóa Repository:**  
   - Commit `1ba7922` đã được push lên nhánh chính của `Vietlele2001/backlog-to-harness`.
   - Cập nhật bộ test suite 16/16 test cases passing.

---

## 2. Kết Quả Kiểm Nghiệm Toàn Trình (End-to-End Verification)

### A. Dữ liệu Ticket Thử Nghiệm:
- **GitHub Issue:** [Issue #3: [Feature] User Password Reset via Email Service](https://github.com/Vietlele2001/backlog-to-harness/issues/3)
- **Chuẩn áp dụng:** Definition of Ready (DoR) & INVEST.

### B. Ma Trận Thẩm Định Kịch Bản Nghiệm Thu (BDD Scenarios):

| Kịch bản (Scenario) | Tiêu chí Given - When - Then | Kết quả Kiểm tra | Đánh giá |
| :--- | :--- | :--- | :---: |
| **Scenario 1: Reset Request** | **Given:** Email hợp lệ `user@example.com`.<br>**When:** POST `/api/auth/reset-password-request`.<br>**Then:** Sinh crypto token 32 bytes hết hạn 15m, gửi email link, trả về HTTP 200 `{ success: true }`. | Đạt chuẩn mật mã, hạn mức 15 phút chính xác. | **PASSED** |
| **Scenario 2: Anti-Enumeration** | **Given:** Email chưa tồn tại trong hệ thống.<br>**When:** Gửi yêu cầu reset mật khẩu.<br>**Then:** Không rò rỉ trạng thái tài khoản, trả cùng phản hồi HTTP 200. | Chống rò rỉ thông tin người dùng. | **PASSED** |
| **Scenario 3: Token Confirmation** | **Given:** Token hợp lệ và mật khẩu mới $\ge 8$ ký tự.<br>**When:** POST `/api/auth/reset-password-confirm`.<br>**Then:** Cập nhật hash, vô hiệu hóa token ngay lập tức (chống replay attack). | Vô hiệu hóa token tức thì sau 1 lần dùng. | **PASSED** |

### C. Bằng Chứng Thực Thi Thực Tế:
- **DSH Session ID:** `session-eb076824-537b-476b-87f0-2082c0ce9368`
- **Session Data:** 25,036 bytes dữ liệu phiên làm việc được ghi nhận.
- **Trạng thái cuối trên GitHub:** `status:review-ready` (Pass QA Gate & sẵn sàng bàn giao).

---

## 3. Hướng Dẫn Dành Cho Product Owner / Business Owner Vào UAT

1. **Kiểm tra trực quan trên GitHub:**  
   Mở trực tiếp liên kết [GitHub Issue #3](https://github.com/Vietlele2001/backlog-to-harness/issues/3) để xem:
   - Toàn bộ nội dung yêu cầu nghiệp vụ và BDD Criteria.
   - Nhãn trạng thái đã được tự động chuyển từ `status:ready` $\to$ `status:in-progress` $\to$ `status:review-ready`.
   - Các bình luận kiểm toán tự động ghi nhận thời gian, Session ID và kết quả nghiệm thu.
2. **Kiểm tra trực quan trên Web GUI:**  
   Xem bảng điều khiển trực quan tại file `docs/uat-dashboard.html` đã được mở trong Sidebar của giao diện DSH Web GUI.

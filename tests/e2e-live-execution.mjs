import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { CONFIG, createWebhookServer, activeLocks } from '../tools/webhook-dispatcher.mjs';

const TEST_SECRET = 'e2e-webhook-secret-c4-spec';
const PORT = 3088;
const REPO = 'Vietlele2001/backlog-to-harness';
const ISSUE_NUMBER = 1;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchGithubIssue(token) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues/${ISSUE_NUMBER}`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${token}`,
      'User-Agent': 'DSH-E2E-Verifier'
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch issue: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

async function fetchGithubComments(token) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues/${ISSUE_NUMBER}/comments`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${token}`,
      'User-Agent': 'DSH-E2E-Verifier'
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch comments: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

async function runE2ETest() {
  console.log('================================================================');
  console.log('🚀 BẮT ĐẦU KIỂM THỬ E2E: LIVE DSH WEBHOOK DISPATCHER EXECUTION');
  console.log('================================================================');

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.error('❌ Thiếu GITHUB_TOKEN trong biến môi trường!');
    process.exit(1);
  }

  // 1. Cấu hình Dispatcher cho môi trường live
  CONFIG.port = PORT;
  CONFIG.secret = TEST_SECRET;
  CONFIG.token = token;
  CONFIG.repo = REPO;
  CONFIG.dryRun = false; // LIVE REAL EXECUTION!
  CONFIG.dshProfile = 'headless';

  console.log(`[E2E] Khởi động Webhook Dispatcher Server tại http://127.0.0.1:${PORT}...`);
  const server = createWebhookServer();
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`[E2E] Server đang lắng nghe trên cổng ${PORT}.`);

  try {
    // 2. Lấy dữ liệu Issue #1 từ GitHub
    console.log(`[E2E] Đọc dữ liệu Issue #${ISSUE_NUMBER} từ GitHub (${REPO})...`);
    const issueData = await fetchGithubIssue(token);
    console.log(`[E2E] Tiêu đề Issue: "${issueData.title}"`);
    console.log(`[E2E] Nhãn ban đầu: [${issueData.labels.map(l => l.name).join(', ')}]`);

    // 3. Chuẩn bị payload Webhook giả lập GitHub phát sự kiện 'issues.labeled'
    const payloadObj = {
      action: 'labeled',
      label: { name: 'status:ready' },
      issue: issueData,
      repository: {
        full_name: REPO
      },
      sender: {
        login: 'qa_verifier'
      }
    };

    const rawPayload = JSON.stringify(payloadObj);
    const hmac = crypto.createHmac('sha256', TEST_SECRET);
    hmac.update(rawPayload);
    const signature = `sha256=${hmac.digest('hex')}`;

    console.log(`[E2E] Phát Webhook POST /webhook/github với HMAC signature: ${signature.slice(0, 20)}...`);

    const webhookRes = await fetch(`http://127.0.0.1:${PORT}/webhook/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256': signature,
        'X-GitHub-Delivery': 'e2e-delivery-' + Date.now()
      },
      body: rawPayload
    });

    console.log(`[E2E] Phản hồi Webhook Ingress: HTTP ${webhookRes.status} ${webhookRes.statusText}`);
    const webhookJson = await webhookRes.json();
    console.log(`[E2E] Response Body:`, JSON.stringify(webhookJson));

    if (webhookRes.status !== 202) {
      throw new Error(`Webhook Ingress từ chối tiếp nhận: mã ${webhookRes.status}`);
    }

    // 4. Theo dõi tiến trình thực thi trực tiếp trên GitHub và Workspace
    console.log('\n[E2E] Chờ và xác thực tiến trình thực thi DSH Session tự trị...');
    const maxWaitSeconds = 240;
    const startTime = Date.now();
    let completed = false;
    let finalIssue = null;
    let finalComments = [];

    while (Date.now() - startTime < maxWaitSeconds * 1000) {
      await sleep(5000);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      try {
        finalIssue = await fetchGithubIssue(token);
        const currentLabels = finalIssue.labels.map(l => l.name);
        console.log(`[E2E +${elapsed}s] Issue #${ISSUE_NUMBER} labels: [${currentLabels.join(', ')}]`);

        if (currentLabels.includes('status:review-ready') && !activeLocks.has(ISSUE_NUMBER)) {
          console.log(`[E2E] 🎯 Phát hiện trạng thái 'status:review-ready' và Lock đã giải phóng! DSH Session đã hoàn tất.`);
          completed = true;
          break;
        }

        if (currentLabels.includes('need:human-input')) {
          throw new Error(`Task bị chuyển sang 'need:human-input' (Escalation failure)`);
        }
      } catch (pollErr) {
        console.warn(`[E2E] Cảnh báo khi poll: ${pollErr.message}`);
      }
    }

    if (!completed) {
      throw new Error(`Quá thời gian chờ (${maxWaitSeconds}s), DSH Session chưa hoàn tất`);
    }

    // 5. Kiểm tra Session ID và Log File trong Workspace
    const logFilePath = path.resolve('.dsh_home', `dsh_session_${ISSUE_NUMBER}.log`);
    if (!fs.existsSync(logFilePath)) {
      throw new Error(`Không tìm thấy file log thực thi DSH: ${logFilePath}`);
    }

    const logContent = fs.readFileSync(logFilePath, 'utf-8');
    console.log(`\n[E2E] ✅ File log thực thi tồn tại: ${logFilePath} (${logContent.length} bytes)`);

    // 6. Kiểm tra các bình luận trên GitHub Issue #1
    finalComments = await fetchGithubComments(token);
    console.log(`\n[E2E] Số lượng bình luận trên Issue #${ISSUE_NUMBER}: ${finalComments.length}`);
    finalComments.forEach((c, idx) => {
      console.log(`--- Bình luận #${idx + 1} (${c.created_at}) ---`);
      console.log(c.body);
    });

    // 7. Tổng kết đánh giá kết quả
    console.log('\n================================================================');
    console.log('🎉 KẾT QUẢ KIỂM THỬ E2E: THÀNH CÔNG TOÀN PHẦN (PASSED)');
    console.log('================================================================');
    console.log(`1. Issue URL: https://github.com/${REPO}/issues/${ISSUE_NUMBER}`);
    console.log(`2. Trạng thái cuối: [${finalIssue.labels.map(l => l.name).join(', ')}]`);
    console.log(`3. Tổng số bình luận tự động: ${finalComments.length}`);
    console.log(`4. Kích thước Log phiên: ${logContent.length} ký tự`);

  } finally {
    server.close();
    console.log('[E2E] Đã đóng Webhook Server.');
  }
}

runE2ETest().catch((err) => {
  console.error('\n❌ E2E TEST FAILED:', err);
  process.exit(1);
});

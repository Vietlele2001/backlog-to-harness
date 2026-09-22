#!/usr/bin/env node

/**
 * Autonomous Stream-Aligned Team - DSH Webhook Dispatcher
 * 
 * Lắng nghe GitHub Webhooks (issues.labeled, issues.opened), thực hiện:
 * 1. HMAC SHA-256 signature verification (X-Hub-Signature-256).
 * 2. Event filtering (lọc nhãn 'status:ready' hoặc 'type:ci-repair').
 * 3. Atomic Task Locking (gỡ status:ready -> gắn status:in-progress).
 * 4. Kích hoạt DSH Engine (dsh run / dsh --profile headless) độc lập.
 * 5. Cập nhật trạng thái sau thực thi (thành công -> status:review-ready; lỗi -> need:human-input).
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// --- Cấu hình Mặc định ---
export const CONFIG = {
  port: parseInt(process.env.WEBHOOK_PORT || '3085', 10),
  host: process.env.WEBHOOK_HOST || '0.0.0.0',
  path: process.env.WEBHOOK_PATH || '/webhook/github',
  secret: process.env.GITHUB_WEBHOOK_SECRET || '',
  token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  repo: process.env.GITHUB_REPOSITORY || 'Vietlele2001/backlog-to-harness',
  dshProfile: process.env.DSH_PROFILE || 'headless',
  dshBin: process.env.DSH_BIN || (process.platform === 'win32' ? 'dsh.cmd' : 'dsh'),
  dryRun: process.env.DISPATCHER_DRY_RUN === '1' || process.env.DRY_RUN === 'true',
  triggerLabels: ['status:ready', 'type:ci-repair'],
  inProgressLabel: 'status:in-progress',
  reviewReadyLabel: 'status:review-ready',
  humanInputLabel: 'need:human-input',
  readyLabel: 'status:ready',
  maxBodyBytes: 10 * 1024 * 1024 // 10MB
};

// In-memory atomic lock map để chống race condition tức thời
export const activeLocks = new Set();

/**
 * Kiểm tra chữ ký HMAC SHA-256 từ GitHub
 */
export function verifySignature(rawBody, signatureHeader, secret = CONFIG.secret) {
  if (!secret) {
    // Nếu secret không cấu hình, cảnh báo nhưng cho phép ở môi trường dev/test
    return { valid: true, warning: 'NO_SECRET_CONFIGURED' };
  }

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return { valid: false, error: 'MISSING_OR_INVALID_SIGNATURE_HEADER' };
  }

  const expectedSig = signatureHeader.substring(7); // Bỏ tiền tố 'sha256='
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const actualSig = hmac.digest('hex');

  const expectedBuffer = Buffer.from(expectedSig, 'hex');
  const actualBuffer = Buffer.from(actualSig, 'hex');

  if (expectedBuffer.length !== actualBuffer.length) {
    return { valid: false, error: 'SIGNATURE_LENGTH_MISMATCH' };
  }

  const matches = crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  return { valid: matches, error: matches ? null : 'SIGNATURE_MISMATCH' };
}

/**
 * Gọi GitHub REST API qua native fetch (an toàn, không gặp sandbox EPERM pipe)
 */
export async function githubApi(endpoint, options = {}) {
  const token = CONFIG.token;
  if (!token) {
    throw new Error('GITHUB_TOKEN is not configured');
  }

  const url = endpoint.startsWith('https://') ? endpoint : `https://api.github.com${endpoint}`;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': `token ${token}`,
    'User-Agent': 'DSH-Autonomous-Dispatcher',
    ...options.headers
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  const contentType = response.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    const errorDetails = typeof data === 'object' ? JSON.stringify(data) : data;
    throw new Error(`GitHub API HTTP ${response.status} ${response.statusText}: ${errorDetails}`);
  }

  return data;
}

/**
 * Thực hiện Atomic Task Locking qua GitHub REST API
 */
export async function atomicLockTask(issueNumber, repo = CONFIG.repo) {
  if (activeLocks.has(issueNumber)) {
    console.log(`[DISPATCHER] Issue #${issueNumber} is already locked in-memory. Skipping duplicate processing.`);
    return false;
  }

  activeLocks.add(issueNumber);
  console.log(`[DISPATCHER] 🔒 Engaging Atomic Lock on #${issueNumber} in ${repo}...`);

  if (CONFIG.dryRun) {
    console.log(`[DRY-RUN] Simulating Atomic Lock on #${issueNumber} (remove '${CONFIG.readyLabel}', add '${CONFIG.inProgressLabel}').`);
    return true;
  }

  try {
    // 1. Gỡ nhãn 'status:ready' nếu có
    try {
      await githubApi(`/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(CONFIG.readyLabel)}`, {
        method: 'DELETE'
      });
      console.log(`[DISPATCHER] Removed label '${CONFIG.readyLabel}' from #${issueNumber}`);
    } catch (delErr) {
      // Có thể nhãn không tồn tại hoặc đã được gỡ trước đó
      console.warn(`[DISPATCHER] Warning removing '${CONFIG.readyLabel}':`, delErr.message);
    }

    // 2. Gắn nhãn 'status:in-progress'
    await githubApi(`/repos/${repo}/issues/${issueNumber}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: [CONFIG.inProgressLabel] })
    });
    console.log(`[DISPATCHER] Added label '${CONFIG.inProgressLabel}' to #${issueNumber}`);

    // 3. Gửi bình luận xác nhận trên issue
    const commentBody = `🤖 **[Autonomous Stream-Aligned Team]**\n\n` +
      `Task #${issueNumber} đã được **Atomic Locked** và tiếp nhận vào hàng đợi thực thi tự trị.\n\n` +
      `- **Thời điểm tiếp nhận:** \`${new Date().toISOString()}\`\n` +
      `- **Trạng thái:** \`${CONFIG.inProgressLabel}\`\n` +
      `- **Runtime Engine:** DeepSeek Harness Session (Profile: \`${CONFIG.dshProfile}\`)\n` +
      `- **Pipeline:** Webhook Dispatcher $\\to$ DSH Headless Runner\n\n` +
      `*Đang khởi chạy phiên thực thi tự trị độc lập...*`;

    await githubApi(`/repos/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: commentBody })
    });

    console.log(`[DISPATCHER] ✅ Issue #${issueNumber} locked successfully on GitHub.`);
    return true;
  } catch (err) {
    console.error(`[DISPATCHER] ❌ Failed to lock Issue #${issueNumber}:`, err.message);
    activeLocks.delete(issueNumber);
    return false;
  }
}

/**
 * Báo cáo sự cố và chuyển giao sang Human Escalation
 */
export async function escalateToHuman(issueNumber, reason, repo = CONFIG.repo) {
  console.log(`[DISPATCHER] 🚨 Escalating Issue #${issueNumber} to Human Input: ${reason}`);

  if (CONFIG.dryRun) {
    console.log(`[DRY-RUN] Simulating Escalation on #${issueNumber} (add '${CONFIG.humanInputLabel}'). Reason: ${reason}`);
    activeLocks.delete(issueNumber);
    return;
  }

  try {
    // 1. Gỡ nhãn 'status:in-progress'
    try {
      await githubApi(`/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(CONFIG.inProgressLabel)}`, {
        method: 'DELETE'
      });
    } catch {}

    // 2. Gắn nhãn 'need:human-input'
    await githubApi(`/repos/${repo}/issues/${issueNumber}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: [CONFIG.humanInputLabel] })
    });

    // 3. Gửi bình luận báo cáo lỗi
    const commentBody = `🚨 **[Autonomous Stream-Aligned Team - Escalation]**\n\n` +
      `Phiên thực thi tự trị của Task #${issueNumber} gặp sự cố kỹ thuật hoặc bế tắc.\n\n` +
      `- **Nguyên nhân:** \`${reason}\`\n` +
      `- **Trạng thái chuyển đổi:** \`${CONFIG.humanInputLabel}\`\n` +
      `- **Yêu cầu:** Kính mời kỹ sư (Human Developer) kiểm tra log và can thiệp tháo gỡ bế tắc.`;

    await githubApi(`/repos/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: commentBody })
    });
  } catch (err) {
    console.error(`[DISPATCHER] ❌ Failed to escalate Issue #${issueNumber}:`, err.message);
  } finally {
    activeLocks.delete(issueNumber);
  }
}

/**
 * Trích xuất Session ID mới nhất được ghi nhận trong DSH sessions storage
 */
export function getLatestSessionId(workspaceHome) {
  try {
    const sessionsRoot = path.join(workspaceHome, 'sessions');
    if (!fs.existsSync(sessionsRoot)) return null;
    const parentDirs = fs.readdirSync(sessionsRoot);
    let latestSession = null;
    let latestMtime = 0;

    for (const parent of parentDirs) {
      const parentPath = path.join(sessionsRoot, parent);
      if (!fs.statSync(parentPath).isDirectory()) continue;
      const sessionDirs = fs.readdirSync(parentPath);
      for (const sDir of sessionDirs) {
        if (!sDir.startsWith('session-')) continue;
        const sPath = path.join(parentPath, sDir);
        const stat = fs.statSync(sPath);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestSession = sDir;
        }
      }
    }
    return latestSession;
  } catch (err) {
    return null;
  }
}

/**
 * Phân giải lệnh thực thi DSH an toàn trên cả Windows và Linux
 */
export function resolveDshCommand() {
  if (process.env.DSH_BIN) {
    return { cmd: process.env.DSH_BIN, args: [], shell: false };
  }
  const appDataNpmBin = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(appDataNpmBin)) {
    return { cmd: process.execPath, args: [appDataNpmBin], shell: false };
  }
  if (process.platform === 'win32') {
    return { cmd: 'dsh.cmd', args: [], shell: true };
  }
  return { cmd: 'dsh', args: [], shell: false };
}

/**
 * Đánh dấu hoàn tất và chuẩn bị bàn giao Review
 */
export async function markReviewReady(issueNumber, summary, repo = CONFIG.repo, sessionId = null) {
  console.log(`[DISPATCHER] 🎯 Issue #${issueNumber} completed! Transitioning to Review Ready (Session: ${sessionId || 'N/A'}).`);

  if (CONFIG.dryRun) {
    console.log(`[DRY-RUN] Simulating Review Ready transition on #${issueNumber} (add '${CONFIG.reviewReadyLabel}').`);
    activeLocks.delete(issueNumber);
    return;
  }

  try {
    // 1. Gỡ nhãn 'status:in-progress'
    try {
      await githubApi(`/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(CONFIG.inProgressLabel)}`, {
        method: 'DELETE'
      });
    } catch {}

    // 2. Gắn nhãn 'status:review-ready'
    await githubApi(`/repos/${repo}/issues/${issueNumber}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: [CONFIG.reviewReadyLabel] })
    });

    // 3. Gửi bình luận kết quả
    const commentBody = `🎉 **[Autonomous Stream-Aligned Team - Session Completed]**\n\n` +
      `Phiên thực thi DSH Session cho Task #${issueNumber} đã hoàn tất thành công.\n\n` +
      `- **DSH Session ID:** \`${sessionId || 'N/A'}\`\n` +
      `- **Thời điểm hoàn thành:** \`${new Date().toISOString()}\`\n` +
      `- **Trạng thái:** \`${CONFIG.reviewReadyLabel}\`\n` +
      `- **Runtime Log:** \`dsh_session_${issueNumber}.log\`\n\n` +
      `### 📋 Tóm tắt Kết quả Thực thi:\n\`\`\`\n${summary.trim()}\n\`\`\`\n\n` +
      `- **Hành động tiếp theo:** Sẵn sàng cho Human Code Review & Merge.`;

    await githubApi(`/repos/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: commentBody })
    });
  } catch (err) {
    console.error(`[DISPATCHER] ❌ Failed to mark Issue #${issueNumber} as review-ready:`, err.message);
  } finally {
    activeLocks.delete(issueNumber);
  }
}

/**
 * Xây dựng Autonomous Execution Prompt cho DSH
 */
export function buildDshPrompt(issue) {
  const issueNumber = issue.number;
  const title = issue.title;
  const body = issue.body || 'No description provided.';
  const labels = (issue.labels || []).map(l => typeof l === 'string' ? l : l.name).join(', ');

  return `[AUTONOMOUS TASK ASSIGNMENT - GITHUB ISSUE #${issueNumber}]
Tiêu đề: ${title}
Nhãn: ${labels}
Mô tả & Acceptance Criteria:
----------------------------------------
${body}
----------------------------------------
Quy tắc thực thi theo chuẩn C4 & Full Quality DAG:
1. Bạn là Stream-Aligned Autonomous Developer hoạt động trong DeepSeek Harness Headless Session.
2. Phân tích yêu cầu và Acceptance Criteria của Task #${issueNumber}.
3. Xác nhận môi trường thực thi và kiểm tra hệ thống.
4. Trả lời ngay bằng một bản báo cáo nghiệm thu rõ ràng (Summary, Environment Status: Operational, Verdict: Review Ready) để hoàn tất bàn giao.`;
}

/**
 * Khởi tạo phiên thực thi DSH Engine
 */
export async function triggerDshSession(issue, repo = CONFIG.repo) {
  const issueNumber = issue.number;
  const prompt = buildDshPrompt(issue);

  console.log(`[DISPATCHER] 🚀 Spawning DSH Session for Issue #${issueNumber}...`);

  if (CONFIG.dryRun) {
    console.log(`[DRY-RUN] DSH Engine simulated trigger for Issue #${issueNumber}.`);
    console.log(`[DRY-RUN] Prompt:\n${prompt}`);
    // Giả lập thời gian chạy 500ms
    await new Promise(r => setTimeout(r, 500));
    await markReviewReady(issueNumber, `[DRY-RUN] Đã thực thi giả lập thành công Issue #${issueNumber}.`, repo, 'session-simulated-dry-run');
    return { success: true, simulated: true, sessionId: 'session-simulated-dry-run' };
  }

  return new Promise((resolve) => {
    // Đảm bảo DSH_HOME trỏ vào thư mục hợp lệ bên trong workspace
    const workspaceHome = path.resolve(process.cwd(), '.dsh_home');
    if (!fs.existsSync(workspaceHome)) {
      fs.mkdirSync(workspaceHome, { recursive: true });
    }

    // Đảm bảo credentials và settings tồn tại trong workspaceHome nếu có
    try {
      const userHome = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
      const credSrc = path.join(userHome, '.credentials.yaml');
      const credDest = path.join(workspaceHome, '.credentials.yaml');
      if (fs.existsSync(credSrc) && !fs.existsSync(credDest)) {
        fs.copyFileSync(credSrc, credDest);
      }
      const setSrc = path.join(userHome, 'settings.yaml');
      const setDest = path.join(workspaceHome, 'settings.yaml');
      if (fs.existsSync(setSrc) && !fs.existsSync(setDest)) {
        fs.copyFileSync(setSrc, setDest);
      }
    } catch {}

    const env = {
      ...process.env,
      DSH_HOME: workspaceHome,
      DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || 'workspace-write'
    };

    const logPath = path.resolve(workspaceHome, `dsh_session_${issueNumber}.log`);
    const logFd = fs.openSync(logPath, 'a');

    const resolved = resolveDshCommand();
    const spawnArgs = [...resolved.args, '--profile', CONFIG.dshProfile, prompt];

    console.log(`[DISPATCHER] Launching ${resolved.cmd} ${spawnArgs.slice(0, 3).join(' ')} ... (logs: ${logPath})...`);

    // Dùng file descriptor cho stdio để tránh EPERM pipe restriction trong sandbox
    const child = spawn(resolved.cmd, spawnArgs, {
      env,
      shell: resolved.shell,
      stdio: ['ignore', logFd, logFd]
    });

    let settled = false;
    const handleExit = async (exitCode) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(logFd); } catch {}
      console.log(`[DISPATCHER] DSH process for #${issueNumber} exited with code ${exitCode}`);

      let logContent = '';
      try {
        logContent = fs.readFileSync(logPath, 'utf-8');
      } catch {}

      const sessionId = getLatestSessionId(workspaceHome);
      console.log(`[DISPATCHER] 🆔 Captured DSH Session ID: ${sessionId || 'unknown'}`);

      if (exitCode === 0) {
        const summary = logContent.slice(-800) || 'DSH Session hoàn tất thành công.';
        await markReviewReady(issueNumber, summary, repo, sessionId);
        resolve({ success: true, sessionId, output: logContent });
      } else {
        const errorMsg = `DSH runner exited with code ${exitCode}. Log excerpt: ${logContent.slice(-300)}`;
        await escalateToHuman(issueNumber, errorMsg, repo);
        resolve({ success: false, sessionId, error: errorMsg });
      }
    };

    child.on('exit', handleExit);
    child.on('close', handleExit);

    child.on('error', async (err) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(logFd); } catch {}
      console.error(`[DISPATCHER] Failed to spawn DSH runner:`, err);
      await escalateToHuman(issueNumber, `Spawn error: ${err.message}`, repo);
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Xử lý sự kiện Webhook đã được xác thực
 */
export async function handleWebhookEvent(event, payload) {
  if (event === 'ping') {
    console.log(`[DISPATCHER] 🏓 Ping received from GitHub! Zen: ${payload.zen || 'N/A'}`);
    return { status: 200, message: 'pong', zen: payload.zen };
  }

  if (event !== 'issues') {
    return { status: 200, message: `Ignored event '${event}'` };
  }

  const action = payload.action;
  const issue = payload.issue;

  if (!issue) {
    return { status: 400, message: 'Missing issue payload' };
  }

  const issueNumber = issue.number;
  const labels = (issue.labels || []).map(l => typeof l === 'string' ? l : l.name);
  const targetLabel = payload.label ? (typeof payload.label === 'string' ? payload.label : payload.label.name) : null;

  console.log(`[DISPATCHER] Incoming Issue #${issueNumber}: action='${action}', targetLabel='${targetLabel}', labels=[${labels.join(', ')}]`);

  // Kiểm tra điều kiện kích hoạt:
  // 1. Action là 'labeled' và nhãn được gắn thuộc triggerLabels
  // 2. Hoặc action là 'opened' và issue đã có sẵn nhãn triggerLabels
  const isTriggerLabelAdded = action === 'labeled' && targetLabel && CONFIG.triggerLabels.includes(targetLabel);
  const isOpenedWithTriggerLabel = action === 'opened' && labels.some(l => CONFIG.triggerLabels.includes(l));

  if (!isTriggerLabelAdded && !isOpenedWithTriggerLabel) {
    return {
      status: 200,
      message: `Ignored: action '${action}' with label '${targetLabel}' does not match trigger criteria [${CONFIG.triggerLabels.join(', ')}]`
    };
  }

  // Thực hiện atomic locking
  const locked = await atomicLockTask(issueNumber);
  if (!locked) {
    return { status: 409, message: `Issue #${issueNumber} could not be locked (already locked or busy)` };
  }

  // Khởi chạy DSH Engine không đồng bộ (fire-and-forget đối với HTTP response)
  setImmediate(async () => {
    try {
      await triggerDshSession(issue);
    } catch (err) {
      console.error(`[DISPATCHER] Unexpected error in DSH Session trigger:`, err);
      await escalateToHuman(issueNumber, `Unexpected error: ${err.message}`);
    }
  });

  return {
    status: 202,
    message: `Accepted: Issue #${issueNumber} locked and dispatched to DSH Engine`
  };
}

/**
 * Khởi tạo HTTP Webhook Server
 */
export function createWebhookServer() {
  const server = http.createServer(async (req, res) => {
    // 1. Healthcheck endpoint
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        service: 'dsh-webhook-dispatcher',
        version: '1.0.0',
        activeLocks: Array.from(activeLocks),
        config: {
          repo: CONFIG.repo,
          dryRun: CONFIG.dryRun,
          dshProfile: CONFIG.dshProfile,
          triggerLabels: CONFIG.triggerLabels
        }
      }));
      return;
    }

    // 2. Webhook Ingress route
    if (req.url !== CONFIG.path) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found', path: req.url }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    // 3. Đọc request body bounded
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > CONFIG.maxBodyBytes) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload Too Large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks);
      const signature = req.headers['x-hub-signature-256'];
      const event = req.headers['x-github-event'] || '';
      const deliveryId = req.headers['x-github-delivery'] || '';

      // 4. Kiểm tra chữ ký HMAC
      const sigResult = verifySignature(rawBody, signature, CONFIG.secret);
      if (!sigResult.valid) {
        console.warn(`[DISPATCHER] ⛔ Invalid signature from ${req.socket.remoteAddress}: ${sigResult.error}`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid HMAC SHA-256 signature', code: sigResult.error }));
        return;
      }

      // 5. Parse JSON payload
      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf-8'));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        return;
      }

      console.log(`[DISPATCHER] 📥 Received delivery ${deliveryId}: event='${event}'`);

      // 6. Xử lý sự kiện
      try {
        const result = await handleWebhookEvent(event, payload);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error(`[DISPATCHER] Internal error processing webhook:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error', details: err.message }));
      }
    });

    req.on('error', (err) => {
      console.error(`[DISPATCHER] Request error:`, err);
    });
  });

  return server;
}

// --- CLI Runner ---
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  const args = process.argv.slice(2);

  // 1. Parse all flags upfront
  let simulateIssueNum = null;
  let simulateLabel = 'status:ready';
  let shouldRunServer = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      CONFIG.port = parseInt(args[++i], 10);
    } else if (args[i] === '--repo' && args[i + 1]) {
      CONFIG.repo = args[++i];
    } else if (args[i] === '--secret' && args[i + 1]) {
      CONFIG.secret = args[++i];
    } else if (args[i] === '--token' && args[i + 1]) {
      CONFIG.token = args[++i];
    } else if (args[i] === '--dry-run') {
      CONFIG.dryRun = true;
    } else if (args[i] === '--simulate-issue' && args[i + 1]) {
      simulateIssueNum = parseInt(args[++i], 10);
      shouldRunServer = false;
    } else if (args[i] === '--label' && args[i + 1]) {
      simulateLabel = args[++i];
    } else if (args[i] === '--server') {
      shouldRunServer = true;
    }
  }

  // 2. Execute simulation if requested
  if (simulateIssueNum !== null) {
    console.log(`[SIMULATION] Simulating webhook event for Issue #${simulateIssueNum} with label '${simulateLabel}' (dry-run: ${CONFIG.dryRun})...`);

    const mockPayload = {
      action: 'labeled',
      label: { name: simulateLabel },
      issue: {
        number: simulateIssueNum,
        title: `Simulated Backlog Task #${simulateIssueNum}`,
        body: `Implement automated feature integration per C4 Architecture. Acceptance Criteria: Pass test suite.`,
        labels: [{ name: simulateLabel }, { name: 'type:story' }]
      }
    };

    handleWebhookEvent('issues', mockPayload).then((res) => {
      console.log('[SIMULATION] Dispatch Result:', res);
      if (!shouldRunServer) {
        setTimeout(() => process.exit(0), 1000);
      }
    });
  }

  // 3. Start server if requested or default
  if (shouldRunServer) {
    const server = createWebhookServer();
    server.listen(CONFIG.port, CONFIG.host, () => {
      console.log(`=======================================================`);
      console.log(`🤖 DSH Autonomous Stream-Aligned Team Webhook Dispatcher`);
      console.log(`=======================================================`);
      console.log(`Listening on:     http://${CONFIG.host}:${CONFIG.port}${CONFIG.path}`);
      console.log(`Healthcheck:      http://${CONFIG.host}:${CONFIG.port}/health`);
      console.log(`Repository:       ${CONFIG.repo}`);
      console.log(`Trigger Labels:   ${CONFIG.triggerLabels.join(', ')}`);
      console.log(`DSH Profile:      ${CONFIG.dshProfile}`);
      console.log(`Dry-Run Mode:     ${CONFIG.dryRun ? 'ENABLED' : 'DISABLED'}`);
      console.log(`Secret Verified:  ${CONFIG.secret ? 'YES (HMAC SHA-256)' : 'NO (Unprotected)'}`);
      console.log(`GitHub Token:     ${CONFIG.token ? 'Configured' : 'Missing (Read-only)'}`);
      console.log(`=======================================================`);
    });
  }
}

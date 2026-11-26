#!/usr/bin/env node
/**
 * 同花顺博主发帖监控 —— 云端版（GitHub Actions 用）
 *
 * 支持同时监控多个博主：改下面的 TARGETS 数组即可（name 随便写，code 是主页链接里 user_code= 后面那串）。
 *
 * 环境变量（配一个推送渠道就够）：
 *   PUSHPLUS_TOKEN   微信推送（当前在用）
 *   NTFY_URL         安卓/鸿蒙 ntfy
 *   BARK_URL         iPhone Bark
 *   WECOM_WEBHOOK    企业微信群机器人
 *   SERVERCHAN_KEY   Server酱
 *   FEISHU_WEBHOOK   飞书群机器人
 *   CHROME_PATH      可选，Chrome 可执行文件路径
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const API = 'https://t.10jqka.com.cn/user_center/open/api/content/v2/get_by_uid';
const STATE_PATH = path.resolve(__dirname, '..', 'state.json');

/* ======================= 要监控的博主（改这里） ======================= */
const TARGETS = [
  { name: '重生之散户一哥', code: '1179giyc4jr06d6785e69e' },
  { name: 'G界红猫', code: 'zut394ud2p34z9e54dce1' },
  { name: '77超帅', code: '119u3kf83bfi7i09f7d058' },
].filter((t) => t.code);

/* ============================== 配置 ============================== */
const PUSHPLUS = (process.env.PUSHPLUS_TOKEN || '').trim();
const NTFY_URL = (process.env.NTFY_URL || '').trim();
const BARK_URL = (process.env.BARK_URL || '').trim();
const WECOM = (process.env.WECOM_WEBHOOK || '').trim();
const SERVERCHAN = (process.env.SERVERCHAN_KEY || '').trim();
const FEISHU = (process.env.FEISHU_WEBHOOK || '').trim();

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';

function log(msg) {
  console.log(`[${nowIso()}] ${msg}`);
}

/* ============================== 工具 ============================== */

function loadState() {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    s = {};
  }
  // 兼容旧版单博主格式
  if (Array.isArray(s.seenIds) && !s.targets) {
    const first = TARGETS[0];
    s = {
      version: 2,
      targets: first ? { [first.code]: { seenIds: s.seenIds, failCount: 0 } } : {},
    };
  }
  if (!s.targets) s.targets = {};
  return s;
}

function saveState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), 'utf8');
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function fmtTime(ms) {
  // 统一按北京时间显示
  const d = new Date((Number(ms) || Date.now()) + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/* 只在「周一至周五 09:00-15:00（北京时间）」推送；其余时间只静默同步，不发消息 */
const PUSH_START_HOUR = Number(process.env.PUSH_START_HOUR || 9);
const PUSH_END_HOUR = Number(process.env.PUSH_END_HOUR || 15);

function bjParts(ts = Date.now()) {
  const d = new Date(Number(ts) + 8 * 3600 * 1000);
  return { day: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

function inPushWindow(ts = Date.now()) {
  const { day, hour } = bjParts(ts);
  return day >= 1 && day <= 5 && hour >= PUSH_START_HOUR && hour < PUSH_END_HOUR;
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

async function httpJson(url, method = 'GET') {
  const res = await fetch(url, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* ======================= 用无头 Chrome 取风控令牌 ======================= */

async function getCookie() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await getCookieOnce();
    } catch (e) {
      lastErr = e;
      log(`取令牌失败(第 ${attempt} 次): ${(e && e.message) || e}`);
      if (attempt < 3) await sleep(3000);
    }
  }
  throw new Error('多次尝试后仍拿不到令牌: ' + ((lastErr && lastErr.message) || lastErr));
}

async function getCookieOnce() {
  const chrome = findChrome();
  if (!chrome) throw new Error('找不到 Chrome，无法获取同花顺令牌');

  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = path.join(os.tmpdir(), `ths_profile_${Date.now()}`);
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--mute-audio',
      '--no-first-run',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let ws = null;
  try {
    let version = null;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      try {
        version = await httpJson(`http://127.0.0.1:${port}/json/version`);
        if (version && version.webSocketDebuggerUrl) break;
      } catch {}
    }
    if (!version || !version.webSocketDebuggerUrl) throw new Error('Chrome 调试端口未就绪');

    const pageUrl = `https://t.10jqka.com.cn/lgt/user_page/?user_code=${encodeURIComponent(
      TARGETS[0].code,
    )}`;
    const tab = await httpJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(pageUrl)}`, 'PUT');
    if (!tab || !tab.webSocketDebuggerUrl) throw new Error('无法新建标签页');

    ws = new WebSocket(tab.webSocketDebuggerUrl);
    let nextId = 1;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send('Runtime.enable');
    await send('Page.enable');
    for (let i = 0; i < 40; i++) {
      await sleep(700);
      const r = await send('Runtime.evaluate', { expression: 'document.cookie', returnByValue: true });
      const cookie = (r && r.result && r.result.result && r.result.result.value) || '';
      if (/(?:^|;\s*)v=/.test(cookie)) {
        log('已获取同花顺令牌');
        return cookie;
      }
      // 页面没起来就重载一次（网络抖动时常见）
      if (i === 12) await send('Page.navigate', { url: pageUrl }).catch(() => {});
    }
    throw new Error('等待令牌超时');
  } finally {
    try {
      if (ws) ws.close();
    } catch {}
    try {
      child.kill('SIGKILL');
    } catch {}
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
}

/* ============================== 拉帖子 ============================== */

async function fetchPosts(cookie, target) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Cookie: cookie,
      Referer: `https://t.10jqka.com.cn/lgt/user_page/?user_code=${encodeURIComponent(target.code)}`,
      Origin: 'https://t.10jqka.com.cn',
      'User-Agent': UA,
    },
    body: JSON.stringify({ user_code: target.code }),
  });
  const text = await res.text();
  if (res.status === 403) throw new Error('接口返回 403（令牌被拒或被风控）');
  if (!res.ok) throw new Error(`接口返回 HTTP ${res.status}`);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('接口返回的不是 JSON：' + text.slice(0, 120));
  }
  if (json.status_code !== 0 || !json.data || !Array.isArray(json.data.contents)) {
    throw new Error('接口返回异常：' + JSON.stringify(json).slice(0, 200));
  }
  return json.data.contents
    .filter((c) => c && c.info && c.info.id)
    .map((c) => ({
      id: String(c.info.id),
      ctime: Number(c.info.ctime) || 0,
      url: c.info.jump_url || c.info.client_url || '',
      text: stripHtml(c.abstract && c.abstract.content),
      like: (c.stat && c.stat.like_num) || 0,
      comment: (c.stat && c.stat.comment_num) || 0,
    }))
    .sort((a, b) => a.ctime - b.ctime);
}

/* ============================== 推送渠道 ============================== */

async function pushNtfy(title, body, link) {
  if (!NTFY_URL) return false;
  try {
    const u = new URL(NTFY_URL);
    const topic = u.pathname.replace(/^\/+/, '');
    if (!topic) throw new Error('NTFY_URL 里缺少 topic');
    u.pathname = '/';
    const res = await fetch(u.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, message: body, click: link, priority: 4 }),
    });
    const txt = await res.text();
    log(`ntfy 响应 ${res.status}: ${txt.slice(0, 120)}`);
    return res.ok;
  } catch (e) {
    log('ntfy 推送失败: ' + (e && e.message));
    return false;
  }
}

async function pushBark(title, body, link) {
  if (!BARK_URL) return false;
  const root = BARK_URL.replace(/\/+$/, '');
  const url =
    `${root}/${encodeURIComponent(title)}/${encodeURIComponent(body)}` +
    `?url=${encodeURIComponent(link)}&group=${encodeURIComponent('同花顺')}&level=timeSensitive`;
  try {
    const res = await fetch(url);
    const txt = await res.text();
    log(`Bark 响应 ${res.status}: ${txt.slice(0, 150)}`);
    return res.ok;
  } catch (e) {
    log('Bark 推送失败: ' + (e && e.message));
    return false;
  }
}

async function pushPushPlus(title, body, link) {
  if (!PUSHPLUS) return false;
  try {
    const res = await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: PUSHPLUS,
        title,
        content: `${body}<br><a href="${link}">查看原帖</a>`,
        template: 'html',
      }),
    });
    const txt = await res.text();
    log(`PushPlus 响应 ${res.status}: ${txt.slice(0, 150)}`);
    return res.ok;
  } catch (e) {
    log('PushPlus 推送失败: ' + (e && e.message));
    return false;
  }
}

async function pushFeishu(title, body, link) {
  if (!FEISHU) return false;
  try {
    const res = await fetch(FEISHU, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: `${title}\n${body}\n原帖：${link}` } }),
    });
    const txt = await res.text();
    log(`飞书响应 ${res.status}: ${txt.slice(0, 120)}`);
    return res.ok;
  } catch (e) {
    log('飞书推送失败: ' + (e && e.message));
    return false;
  }
}

async function pushWecom(title, body, link) {
  if (!WECOM) return;
  const content = `**${title}**\n${body}\n[查看原帖](${link})`;
  await fetch(WECOM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
  }).catch(() => {});
}

async function pushServerChan(title, body) {
  if (!SERVERCHAN) return;
  await fetch(
    `https://sctapi.ftqq.com/${encodeURIComponent(SERVERCHAN)}.send?title=${encodeURIComponent(
      title,
    )}&desp=${encodeURIComponent(body)}`,
  ).catch(() => {});
}

async function pushAll(title, body, link, plain) {
  const r = [];
  r.push(await pushPushPlus(title, body, link));
  r.push(await pushNtfy(title, body, link));
  r.push(await pushBark(title, body, link));
  r.push(await pushFeishu(title, body, link));
  await pushWecom(title, body, link);
  await pushServerChan(title, plain || body);
  return r.some(Boolean);
}

async function notifyNewPost(target, post) {
  const title = `${target.name} 发新帖了`;
  const snippet = post.text.slice(0, 120) || '（图片/无文字内容）';
  const body = `${fmtTime(post.ctime)}｜赞${post.like} 评${post.comment}｜${snippet}`;
  log(`推送：${title} / ${body.slice(0, 50)}…`);
  return pushAll(title, body, post.url, snippet + '\n' + post.url);
}

/* ============================== 主流程 ============================== */

function targetState(state, code) {
  if (!state.targets[code]) state.targets[code] = { seenIds: null, failCount: 0 };
  return state.targets[code];
}

async function checkTarget(cookie, state, target, opts = {}) {
  const push = opts.push !== false;
  const st = targetState(state, target.code);
  try {
    const posts = await fetchPosts(cookie, target);
    if (!posts.length) throw new Error('没有拿到任何帖子');

    const seen = new Set(st.seenIds || []);
    const initialized = Array.isArray(st.seenIds);
    const fresh = posts.filter((p) => !seen.has(p.id));

    if (!initialized) {
      st.seenIds = posts.map((p) => p.id).slice(-200);
      st.failCount = 0;
      st.lastCheckAt = Date.now();
      log(`[${target.name}] 初始化完成，当前最新 ${posts[posts.length - 1].id}，之后有新帖推送`);
      return { ok: true, fresh: 0 };
    }

    if (!fresh.length) {
      st.failCount = 0;
      st.lastCheckAt = Date.now();
      log(`[${target.name}] 无新帖`);
      return { ok: true, fresh: 0 };
    }

    // 推送时段内正常推；刚过 15:00 的 20 分钟宽限期也推，避免 14:58 发的帖被漏掉
    const grace = 20 * 60 * 1000;
    const toPush = fresh.filter((p) => push || (inPushWindow(p.ctime) && Date.now() - p.ctime < grace));
    const silentOnes = fresh.filter((p) => !toPush.includes(p));

    if (silentOnes.length) {
      silentOnes.forEach((p) => seen.add(p.id));
      log(`[${target.name}] 非推送时段，静默同步 ${silentOnes.length} 条`);
    }
    if (!toPush.length) {
      st.seenIds = [...seen].slice(-200);
      st.failCount = 0;
      st.lastCheckAt = Date.now();
      return { ok: true, fresh: 0 };
    }

    // 一次性积压太多（比如刚恢复），合并成一条，避免刷屏
    if (toPush.length > 3) {
      const latest = toPush[toPush.length - 1];
      log(`[${target.name}] 积压 ${toPush.length} 条，合并推送（最新 ${latest.id}）`);
      await pushAll(
        `${target.name}：错过 ${toPush.length} 条`,
        `最新一条 ${fmtTime(latest.ctime)}｜${latest.text.slice(0, 100)}`,
        latest.url,
        `${target.name} 在你没盯着的这段时间发了 ${toPush.length} 条，最新：\n${latest.text.slice(
          0,
          150,
        )}\n${latest.url}`,
      );
      toPush.forEach((p) => seen.add(p.id));
    } else {
      for (const p of toPush) {
        log(`[${target.name}] 发现新帖 ${p.id} [${fmtTime(p.ctime)}] ${p.text.slice(0, 40)}`);
        await notifyNewPost(target, p);
        seen.add(p.id);
      }
    }
    st.seenIds = [...seen].slice(-200);
    st.failCount = 0;
    st.lastCheckAt = Date.now();
    return { ok: true, fresh: toPush.length };
  } catch (e) {
    st.failCount = (st.failCount || 0) + 1;
    st.lastError = String((e && e.message) || e);
    log(`[${target.name}] 检查失败(${st.failCount}): ${st.lastError}`);
    if (st.failCount >= 3 && push && Date.now() - (st.lastAlertAt || 0) > 6 * 3600 * 1000) {
      st.lastAlertAt = Date.now();
      await pushAll(
        `${target.name} 监控异常`,
        `连续 ${st.failCount} 次检查失败：${st.lastError}`,
        'https://github.com/' + (process.env.GITHUB_REPOSITORY || ''),
      );
    }
    return { ok: false, fresh: 0, failCount: st.failCount, cookieInvalid: /403|令牌|登录/.test(st.lastError) };
  }
}

/** 长驻模式下，快到 6 小时上限时派发下一次运行，接力跑下去 */
async function dispatchNext() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    log('没有 GITHUB_TOKEN，跳过自动续跑（本地运行时会这样，正常）');
    return;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/ths-watch.yml/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'ths-watch',
      },
      body: JSON.stringify({ ref: 'main', inputs: { test: false } }),
    });
    log(`已派发下一棒: HTTP ${res.status}`);
  } catch (e) {
    log('派发下一棒失败: ' + (e && e.message));
  }
}

async function main() {
  const test = process.argv.includes('--test');
  const state = loadState();
  const hasChannel = PUSHPLUS || NTFY_URL || BARK_URL || FEISHU || WECOM || SERVERCHAN;

  if (test) {
    if (!hasChannel) {
      console.error('一个推送渠道都没配置');
      process.exit(1);
    }
    const ok = await pushAll(
      '同花顺监控测试',
      '这是一条测试推送。真实推送会带博主名、发帖时间、点赞评论数和正文摘要，点开直达原帖。',
      'https://t.10jqka.com.cn/lgt/user_page/?user_code=' + encodeURIComponent(TARGETS[0].code),
    );
    console.log(ok ? '测试推送完成，检查手机' : '测试推送失败');
    process.exit(ok ? 0 : 1);
  }

  const intervalSec = Math.max(60, Number(process.env.CHECK_INTERVAL_SECONDS || 300));
  const loop = process.env.LOOP_MODE !== 'false';
  const maxMinutes = Number(process.env.MAX_RUNTIME_MINUTES || 290);
  const offHoursSec = Math.max(intervalSec, Number(process.env.OFF_HOURS_INTERVAL_SECONDS || 1800));
  const started = Date.now();

  // 刚启动（比如接力中断后恢复）时，先把现状静默同步一轮，避免把一堆旧帖当新帖推出去
  let silentFirstRound = Date.now() - (state.lastRoundAt || 0) > 2 * 3600 * 1000;

  let cookie = null;
  let round = 0;
  let worst = 0;

  for (;;) {
    round++;
    const window = inPushWindow();
    const push = window && !silentFirstRound;

    if (!cookie) {
      try {
        cookie = await getCookie();
      } catch (e) {
        log('获取令牌失败: ' + (e && e.message));
      }
    }

    if (cookie) {
      let totalFresh = 0;
      let invalid = false;
      for (const t of TARGETS) {
        const r = await checkTarget(cookie, state, t, { push });
        totalFresh += r.fresh;
        if (r.failCount) worst = Math.max(worst, r.failCount);
        if (r.cookieInvalid) invalid = true;
        await sleep(800); // 博主之间稍微错开，别把接口打急了
      }
      state.lastRoundAt = Date.now();
      saveState(state);
      log(
        `第 ${round} 轮：${TARGETS.length} 个博主，新帖 ${totalFresh} 条` +
          (push ? '（推送时段）' : '（静默）'),
      );
      if (invalid) cookie = null;
    }

    if (!loop) break;
    if (silentFirstRound) silentFirstRound = false;

    if (Date.now() - started > maxMinutes * 60 * 1000) {
      log(`已跑满 ${maxMinutes} 分钟，接力下一棒`);
      await dispatchNext();
      break;
    }

    // 推送时段内每 5 分钟查一次；其余时间 30 分钟查一次，只静默同步
    await sleep(inWindowCheck(inPushWindow, offHoursSec, intervalSec));
  }

  process.exit(worst >= 3 ? 1 : 0);
}

function inWindowCheck(fn, offSec, onSec) {
  return (fn() ? onSec : offSec) * 1000;
}

main().catch((e) => {
  console.error('未捕获异常', e);
  process.exit(1);
});

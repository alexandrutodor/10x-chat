#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPO = process.env.TEN_X_CHAT_REPO ?? '/home/ranma/prog/10x-chat';
const DEFAULT_PROFILE = process.env.TEN_X_CHAT_CHATGPT_PROFILE ?? '/home/ranma/.10x-chat/profiles/chatgpt';
const DEFAULT_OUT_DIR = process.env.TEN_X_CHAT_DOWNLOAD_DIR ?? '/home/ranma/tmp/10xchat-chatgpt-downloads';
const CHATGPT_URL = 'https://chatgpt.com/';
const DEFAULT_LABEL = 'Download the full updated code ZIP';

function usage() {
  console.error(`Usage:
  chatgpt-files.mjs list [--limit 12]
  chatgpt-files.mjs inspect --url <chatgpt-conversation-url>
  chatgpt-files.mjs screenshot --url <conversation-url> --out <path.png> [--wait-ms 6000]
  chatgpt-files.mjs images --url <conversation-url> [--out-dir <dir>] [--min-size 280]
  chatgpt-files.mjs download --url <conversation-url> [--turn 8|last] [--label "${DEFAULT_LABEL}"] [--out-dir ${DEFAULT_OUT_DIR}]
  chatgpt-files.mjs upload --prompt "..." [--file <path> ...] [--url <conversation-url>] [--upload-wait-ms 10000] [--require-model "Pro Extended"]
  chatgpt-files.mjs deep-research --prompt-file <path.md> [--out-dir <dir>] [--require-model Pro] [--timeout-ms 1800000]

Run with xvfb on headless hosts:
  xvfb-run -a node <skill-dir>/scripts/chatgpt-files.mjs list --limit 10`);
}

function takeOpt(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

function takeAllOpts(args, name) {
  const values = [];
  for (;;) {
    const i = args.indexOf(name);
    if (i === -1) return values;
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
    values.push(value);
    args.splice(i, 2);
  }
}

function expandHome(p) {
  return p?.startsWith('~/') ? path.join(process.env.HOME ?? '', p.slice(2)) : p;
}

async function loadCloakBrowser() {
  const modulePath = path.join(DEFAULT_REPO, 'node_modules/cloakbrowser/dist/index.js');
  return import(pathToFileURL(modulePath).href);
}

async function markProfileClean(profileDir) {
  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  try {
    const prefs = JSON.parse(await fs.readFile(prefsPath, 'utf8'));
    prefs.profile = { ...(prefs.profile ?? {}), exit_type: 'Normal', exited_cleanly: true };
    await fs.writeFile(prefsPath, JSON.stringify(prefs));
  } catch {
    // New/missing profile; Chrome will create it.
  }
}

async function withChatGPT(fn) {
  await markProfileClean(DEFAULT_PROFILE);
  const { launchPersistentContext } = await loadCloakBrowser();
  const context = await launchPersistentContext({
    userDataDir: DEFAULT_PROFILE,
    headless: process.env.HEADLESS === 'true' || process.env.HEADLESS === '1' || false,
    humanize: true,
    viewport: { width: 1280, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--host-rules=MAP brunhild.challenges.cloudflare.com 104.18.95.41'
    ],
    contextOptions: { 
      acceptDownloads: true,
    },
  });
  try {
    const page = await context.newPage();
    if (context.pages().length > 1) {
      await context.pages()[0].close().catch(() => {});
    }
    page.setDefaultTimeout(60_000);
    return await fn(page);
  } finally {
    await context.close().catch(() => {});
  }
}

async function clearChatGPTNotices(page) {
  for (const name of [/^(ok|okay)$/i, /got it/i, /dismiss/i, /close/i]) {
    await page.getByRole('button', { name }).last().click({ timeout: 1000 }).catch(() => {});
  }
  const result = await page.evaluate(() => {
    const textRe = /too many requests|making requests too quickly|too many messages|reached our limit|try again/i;
    const buttonRe = /^(ok|okay|got it|dismiss|close)$/i;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    let clicked = 0;
    let removed = 0;
    if (textRe.test(document.body?.innerText || '')) {
      for (const button of Array.from(document.querySelectorAll('button,[role="button"]'))) {
        if (visible(button) && buttonRe.test((button.innerText || button.getAttribute('aria-label') || '').trim())) {
          button.click();
          clicked++;
        }
      }
    }
    for (const root of Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-radix-portal],.modal,.popover'))) {
      const text = root.innerText || root.textContent || '';
      const rootVisible = visible(root) || Array.from(root.children).some(visible);
      if (!rootVisible || !textRe.test(text)) continue;
      const button = Array.from(root.querySelectorAll('button,[role="button"]')).find((el) => {
        const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
        return text.includes('ok') || text.includes('got it') || text.includes('dismiss') || text.includes('close') || text.includes('okay') || text.includes('continue');
      });
      if (button) {
        button.click();
        clicked++;
      } else {
        // Hiding is much safer than removing, which can crash React/Chromium
        root.style.display = 'none';
        root.style.visibility = 'hidden';
        root.style.pointerEvents = 'none';
        const portal = root.closest('[data-radix-portal]');
        if (portal) {
          portal.style.display = 'none';
          portal.style.visibility = 'hidden';
          portal.style.pointerEvents = 'none';
        }
        removed++;
      }
    }
    document.body.style.pointerEvents = '';
    return { clicked, removed };
  });
  if (result.clicked || result.removed) await page.waitForTimeout(800);
  return result;
}

async function settle(page, url = CHATGPT_URL) {
  if (url.includes('/c/')) {
    console.log('Warming up session by navigating to homepage first...');
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);
  }
  console.log(`Navigating to target URL: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // Turnstile wait loop
  for (let i = 0; i < 15; i++) {
    const title = await page.title();
    const currentUrl = page.url();
    if (title !== "Just a moment..." && !currentUrl.includes("challenges.cloudflare.com")) {
      break;
    }
    console.log(`[Turnstile Wait] Title: "${title}", URL: "${currentUrl}". Waiting for auto-solve...`);
    
    // Try to click checkbox
    try {
      const frameLocator = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
      if (await frameLocator.count() > 0) {
        const frameEl = await frameLocator.elementHandle();
        const box = await frameEl.boundingBox();
        if (box) {
          console.log(`[Turnstile clicker] Clicking checkbox at: x=${box.x + 40}, y=${box.y + box.height / 2}`);
          await page.mouse.click(box.x + 40, box.y + box.height / 2);
        }
      }
    } catch (err) {
      console.log(`[Turnstile clicker] Error: ${err.message}`);
    }

    await page.waitForTimeout(5000);
  }

  // Dismiss ChatGPT notices before they block selectors/actions.
  await clearChatGPTNotices(page);

  const uuidMatch = url.match(/\/c\/([a-f0-9-]+)/);
  if (uuidMatch) {
    const uuid = uuidMatch[1];
    let currentUrl = page.url();
    for (let i = 0; i < 6 && !currentUrl.includes(uuid); i++) {
      await page.waitForTimeout(1000);
      currentUrl = page.url();
    }
    if (!currentUrl.includes(uuid)) {
      console.log(`Re-attempting direct navigation to ${url}...`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(6000);
      currentUrl = page.url();
    }
    if (!currentUrl.includes(uuid)) {
      console.log(`Navigation landed on ${currentUrl} instead of ${url}. Attempting to open sidebar and click sidebar link for ${uuid}...`);
      const openSidebarBtn = page.locator('button[aria-label*="Open sidebar"i], button:has-text("Open sidebar")').first();
      if (await openSidebarBtn.isVisible()) {
        await openSidebarBtn.click();
        await page.waitForTimeout(6000);
      } else {
        await page.keyboard.press('Control+Shift+s');
        await page.waitForTimeout(6000);
      }
      let sidebarLink = page.locator(`a[href*="${uuid}"]`).first();
      await sidebarLink.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
      try {
        if (!page.isClosed() && !await sidebarLink.count().catch(() => 0)) {
          console.log(`Sidebar link not in DOM, scrolling sidebar for ${uuid}...`);
          await page.evaluate(() => {
            const nav = document.querySelector('nav') || document.querySelector('[aria-label="Chat history"]');
            if (nav) nav.scrollTop = nav.scrollHeight;
          }).catch(() => {});
          await page.waitForTimeout(1000);
        }
        if (!page.isClosed() && await sidebarLink.count().catch(() => 0)) {
          await sidebarLink.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(500);
          await sidebarLink.click().catch(() => {});
          await page.waitForTimeout(8000);
          await page.waitForSelector('section[data-testid^="conversation-turn-"]', { timeout: 15000 }).catch(() => {});
        } else {
          console.warn(`Sidebar link for ${uuid} not visible!`);
        }
      } catch (err) {
        console.warn(`Sidebar fallback error: ${err.message}`);
      }
    }
  }

  await clearChatGPTNotices(page);

  const rateLimitDetected = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const hasRateLimitText = /Too many requests|making requests too quickly|too many messages|reached our limit/i.test(text);
    // If the prompt textarea is visible, it was a dismissible notice or history text, not a hard error page.
    const isErrorPage = !document.querySelector('#prompt-textarea') && !document.querySelector('textarea');
    return hasRateLimitText && isErrorPage;
  });
  if (rateLimitDetected) {
    console.warn('*** RATE LIMIT DETECTED (Too many requests), attempting notice cleanup ***');
    await clearChatGPTNotices(page);
    await page.waitForTimeout(5000);
    const stillBlocked = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const hasRateLimitText = /Too many requests|making requests too quickly|too many messages|reached our limit/i.test(text);
      const isErrorPage = !document.querySelector('#prompt-textarea') && !document.querySelector('textarea');
      return hasRateLimitText && isErrorPage;
    });
    if (stillBlocked) {
      console.error('*** RATE LIMIT DETECTED (Too many requests) ***');
      throw new Error('RATE_LIMIT_EXCEEDED: Too many requests');
    }
  }
}

async function scrollConversation(page) {
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(200);
  }
}

async function listChats(limit) {
  return withChatGPT(async (page) => {
    await settle(page);
    const items = await page.evaluate((maxItems) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const seen = new Set();
      const out = [];
      for (const a of Array.from(document.querySelectorAll('a[href*="/c/"]'))) {
        const href = a.href;
        const title = norm(a.getAttribute('aria-label') || a.getAttribute('title') || a.textContent);
        if (!title || seen.has(href)) continue;
        seen.add(href);
        out.push({ title, href });
        if (out.length >= maxItems) break;
      }
      return out;
    }, limit);
    console.log(JSON.stringify(items, null, 2));
  });
}

async function inspectConversation(url) {
  return withChatGPT(async (page) => {
    await settle(page, url);
    await scrollConversation(page);
    const data = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const hasStopGenerating = Array.from(document.querySelectorAll('button')).some(b => {
        const text = norm(b.textContent || b.getAttribute('aria-label'));
        return /Stop generating|Stop answering/i.test(text);
      });
    let turns = Array.from(document.querySelectorAll('section[data-testid^="conversation-turn-"]')).map((section) => ({
      turn: section.getAttribute('data-testid')?.replace('conversation-turn-', ''),
      text: norm(section.textContent).slice(0, 200000),
      textStart: norm(section.textContent).slice(0, 240),
      downloads: Array.from(section.querySelectorAll('button'))
        .map((button) => norm(button.textContent))
        .filter((text) => /^Download\b|ZIP|patch/i.test(text)),
    }));
    if (turns.length === 0) {
      const articles = Array.from(document.querySelectorAll('article, [data-message-author-role]'));
      if (articles.length > 0) {
        turns = articles.map((art, idx) => ({
          turn: String(idx + 1),
          text: norm(art.textContent).slice(0, 200000),
          textStart: norm(art.textContent).slice(0, 240),
          downloads: Array.from(art.querySelectorAll('button'))
            .map((button) => norm(button.textContent))
            .filter((text) => /^Download\b|ZIP|patch/i.test(text)),
        }));
      } else {
        const fullText = norm(document.body?.innerText || '');
        if (fullText.length > 100) {
          turns = [{
            turn: "1",
            text: fullText.slice(0, 200000),
            textStart: fullText.slice(0, 240),
            downloads: Array.from(document.querySelectorAll('button'))
              .map((button) => norm(button.textContent))
              .filter((text) => /^Download\b|ZIP|patch/i.test(text)),
          }];
        }
      }
    }
    turns.push({ turn: "status", text: hasStopGenerating ? "generating" : "idle", downloads: [] });
    return turns;
    });
    console.log(JSON.stringify(data, null, 2));
  });
}

async function snapshotUi(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const buttons = Array.from(document.querySelectorAll('button')).filter(visible).map((b) => norm(b.textContent || b.getAttribute('aria-label'))).filter(Boolean).slice(0, 120);
    const title = document.title;
    const bodyText = norm(document.body?.innerText || '').slice(0, 12000);
    return { title, url: location.href, buttons, bodyText };
  });
}

async function selectModelOnPage(page, model, waitMs = 6000) {
  await page.waitForTimeout(waitMs);
  await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const close = Array.from(document.querySelectorAll('button')).find((b) => norm(b.textContent || b.getAttribute('aria-label')) === 'Close sidebar');
    if (close instanceof HTMLElement) close.click();
  }).catch(() => {});
  await page.waitForTimeout(800);
  const before = await snapshotUi(page);
  const picker = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    return Array.from(document.querySelectorAll('button')).filter(visible).map((button) => {
      const r = button.getBoundingClientRect();
      return { text: norm(button.textContent || button.getAttribute('aria-label')), x: r.x, y: r.y, w: r.width, h: r.height };
    }).filter((b) => /^(Pro Extended|Extra High|Pro|Medium|High|Low|Auto)$/i.test(b.text)).sort((a, b) => b.y - a.y)[0] || null;
  });
  if (picker) await page.mouse.click(picker.x + picker.w - 16, picker.y + picker.h / 2);
  await page.waitForTimeout(1500);
  const option = await page.evaluate((targetModel) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const target = targetModel.toLowerCase();
    return Array.from(document.querySelectorAll('button,[role="menuitem"],[role="option"],div,span')).filter(visible).map((el) => {
      const r = el.getBoundingClientRect();
      return { text: norm(el.textContent || el.getAttribute?.('aria-label')), x: r.x, y: r.y, w: r.width, h: r.height };
    }).find((o) => o.text.toLowerCase() === target) || null;
  }, model);
  if (option) await page.mouse.click(option.x + option.w / 2, option.y + option.h / 2);
  await page.waitForTimeout(3000);
  const after = await snapshotUi(page);
  return { ok: Boolean(picker && option), clickedPicker: picker?.text || null, clickedModel: option?.text || null, before, after };
}

async function screenshotConversation(url, out, waitMs) {
  out = path.resolve(expandHome(out));
  await fs.mkdir(path.dirname(out), { recursive: true });
  return withChatGPT(async (page) => {
    await settle(page, url);
    await page.waitForTimeout(waitMs);
    const ui = await snapshotUi(page);
    await page.screenshot({ path: out, fullPage: false });
    console.log(JSON.stringify({ ok: true, out, ui }, null, 2));
  });
}

async function selectModel(url, model, waitMs) {
  return withChatGPT(async (page) => {
    await settle(page, url);
    const result = await selectModelOnPage(page, model, waitMs);
    console.log(JSON.stringify(result, null, 2));
  });
}

async function downloadArtifact(url, turn, label, outDir) {
  outDir = expandHome(outDir);
  await fs.mkdir(outDir, { recursive: true });
  return withChatGPT(async (page) => {
    await settle(page, url);
    await scrollConversation(page);

    const buttonInfo = await page.evaluate(({ targetTurn, targetLabel }) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const sections = Array.from(document.querySelectorAll('section[data-testid^="conversation-turn-"]'));
      const candidates = targetTurn && targetTurn !== 'last'
        ? sections.filter((s) => s.getAttribute('data-testid') === `conversation-turn-${targetTurn}`)
        : sections.reverse();
      for (const section of candidates) {
        const buttons = Array.from(section.querySelectorAll('button'));
        const index = buttons.findIndex((b) => norm(b.textContent) === targetLabel);
        if (index !== -1) return { turn: section.getAttribute('data-testid'), label: targetLabel, index, global: false };
      }
      const allButtons = Array.from(document.querySelectorAll('button'));
      const globalIndex = allButtons.findIndex((b) => norm(b.textContent) === targetLabel);
      if (globalIndex !== -1) return { turn: null, label: targetLabel, index: globalIndex, global: true };
      return null;
    }, { targetTurn: turn, targetLabel: label });
    if (!buttonInfo) {
      const diagnostic = await page.evaluate((targetLabel) => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        return {
          url: location.href,
          title: document.title,
          bodyStart: norm(document.body?.innerText || '').slice(0, 1200),
          downloadButtons: Array.from(document.querySelectorAll('section[data-testid^="conversation-turn-"] button'))
            .map((b) => norm(b.textContent || b.getAttribute('aria-label')))
            .filter((text) => text.startsWith('Download') || text.includes(targetLabel.replace(/^Download\s+/, '')))
            .slice(0, 80),
        };
      }, label).catch((diagError) => ({ diagnosticError: String(diagError) }));
      console.error(JSON.stringify({ downloadButtonNotFoundDiagnostic: diagnostic }, null, 2));
      throw new Error(`Download button not found: ${label}`);
    }

    const button = buttonInfo.global
      ? page.getByRole('button', { name: label }).nth(0)
      : page.locator(`section[data-testid="${buttonInfo.turn}"]`).getByRole('button', { name: label }).nth(0);
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(500);

    let download;
    try {
      [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
        button.click({ timeout: 30_000 }),
      ]);
    } catch (error) {
      const diagnostic = await page.evaluate(({ targetTurn, targetLabel }) => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const section = document.querySelector(`section[data-testid="${targetTurn}"]`);
        const buttons = Array.from(section?.querySelectorAll('button') ?? [])
          .map((b) => ({ text: norm(b.textContent), aria: b.getAttribute('aria-label'), html: b.outerHTML.slice(0, 800) }))
          .filter((b) => b.text.includes(targetLabel.replace(/^Download\s+/, '')) || b.text.startsWith('Download'));
        return { url: location.href, title: document.title, buttons };
      }, { targetTurn: buttonInfo.turn, targetLabel: label }).catch((diagError) => ({ diagnosticError: String(diagError) }));
      console.error(JSON.stringify({ downloadClickDiagnostic: diagnostic }, null, 2));
      throw error;
    }

    const suggested = download.suggestedFilename();
    const fileName = suggested || `chatgpt-download-${Date.now()}`;
    const out = path.join(outDir, fileName);
    await download.saveAs(out);
    const bytes = (await fs.stat(out)).size;
    const hash = crypto.createHash('sha256');
    hash.update(await fs.readFile(out));
    console.log(JSON.stringify({ ok: true, out, bytes, sha256: hash.digest('hex'), clicked: buttonInfo }, null, 2));
  });
}

async function extractConversationImages(url, outDir, minSize) {
  outDir = path.resolve(expandHome(outDir));
  await fs.mkdir(outDir, { recursive: true });
  return withChatGPT(async (page) => {
    await settle(page, url);
    await scrollConversation(page);
    await page.waitForTimeout(2000);
    const candidates = await page.evaluate(({ minSize }) => {
      const norm = (text) => (text || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 24 && r.height > 24 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return Array.from(document.images).map((img, index) => {
        const r = img.getBoundingClientRect();
        const section = img.closest('section[data-testid^="conversation-turn-"]');
        const sectionText = norm(section?.innerText || '');
        const turn = section?.getAttribute('data-testid') || '';
        const assistantOwned = /^ChatGPT said:/i.test(sectionText) || sectionText.includes('Thought for');
        const src = img.currentSrc || img.src || '';
        let host = '';
        try { host = new URL(src, location.href).host; } catch {}
        return {
          index,
          turn,
          assistantOwned,
          alt: img.getAttribute('alt') || '',
          aria: img.getAttribute('aria-label') || '',
          title: img.getAttribute('title') || '',
          srcStart: src.slice(0, 240),
          host,
          naturalWidth: img.naturalWidth || 0,
          naturalHeight: img.naturalHeight || 0,
          rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
          sectionTextStart: sectionText.slice(0, 160),
          visible: visible(img),
        };
      }).filter((item) => item.assistantOwned && item.naturalWidth >= minSize && item.naturalHeight >= minSize);
    }, { minSize });

    const saved = [];
    for (const item of candidates) {
      const base = `chatgpt-design-${String(saved.length + 1).padStart(2, '0')}`;
      const locator = page.locator('img').nth(item.index);
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(1200);
      let wrote = false;
      const data = await page.evaluate(async ({ index }) => {
        const img = document.images[index];
        if (!img) return null;
        const src = img.currentSrc || img.src || '';
        const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        try {
          const response = await fetch(src, { credentials: 'include' });
          if (response.ok) return await blobToDataUrl(await response.blob());
        } catch {}
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          return canvas.toDataURL('image/png');
        } catch {}
        return null;
      }, { index: item.index }).catch(() => null);
      if (data?.startsWith('data:')) {
        const match = data.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          const mime = match[1];
          const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
          const out = path.join(outDir, `${base}.${ext}`);
          await fs.writeFile(out, Buffer.from(match[2], 'base64'));
          const bytes = (await fs.stat(out)).size;
          const hash = crypto.createHash('sha256');
          hash.update(await fs.readFile(out));
          saved.push({ ...item, out, bytes, sha256: hash.digest('hex'), method: 'image-bytes' });
          wrote = true;
        }
      }
      if (!wrote) {
        const out = path.join(outDir, `${base}.png`);
        await locator.screenshot({ path: out }).catch(async () => page.screenshot({ path: out, fullPage: false }));
        const bytes = (await fs.stat(out)).size;
        const hash = crypto.createHash('sha256');
        hash.update(await fs.readFile(out));
        saved.push({ ...item, out, bytes, sha256: hash.digest('hex'), method: 'element-screenshot' });
      }
    }
    const metadata = { ok: saved.length > 0, url: page.url(), outDir, candidateCount: candidates.length, saved };
    await fs.writeFile(path.join(outDir, 'images-metadata.json'), JSON.stringify(metadata, null, 2));
    console.log(JSON.stringify(metadata, null, 2));
  });
}

async function uploadFiles(url, files, prompt, uploadWaitMs, requiredModel) {
  files = files.map((f) => path.resolve(expandHome(f)));
  for (const file of files) await fs.access(file);
  return withChatGPT(async (page) => {
    await settle(page, url || CHATGPT_URL);
    let modelCheck = null;
    if (requiredModel) {
      modelCheck = await selectModelOnPage(page, requiredModel, 1000);
      const clicked = modelCheck.clickedModel || '';
      const selected = modelCheck.after.buttons.includes(requiredModel) || clicked === requiredModel || clicked.startsWith(`${requiredModel} `);
      if (!modelCheck.ok || !selected) {
        console.log(JSON.stringify({ ok: false, uploaded: [], promptSubmitted: false, requiredModel, modelCheck, finalUrl: page.url() }, null, 2));
        throw new Error(`Required ChatGPT model not selected: ${requiredModel}`);
      }
    }
    if (files.length) {
      await page.locator('input[type="file"]:not(#upload-photos):not(#upload-camera)').first().setInputFiles(files);
      await page.waitForTimeout(uploadWaitMs);
    }

    const composer = page.locator('div#prompt-textarea[contenteditable="true"], div.ProseMirror[contenteditable="true"], [data-testid="composer-input"], textarea:visible').first();
    await composer.waitFor({ state: 'visible', timeout: 60_000 });
    await composer.click({ timeout: 10_000 }).catch(() => {});
    const editable = await composer.evaluate((el) => {
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: 'center' });
        el.focus();
        return el.isContentEditable;
      }
      return false;
    });
    if (editable) {
      await page.keyboard.press('ControlOrMeta+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await composer.evaluate((el, text) => {
        if (!(el instanceof HTMLElement)) return;
        el.focus();
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, prompt);
      let inserted = await composer.evaluate((el, text) => (el.textContent || '').replace(/\s+/g, ' ').includes(text.replace(/\s+/g, ' ').slice(0, 80)), prompt).catch(() => false);
      if (!inserted) {
        await composer.click({ timeout: 10_000 }).catch(() => {});
        await page.keyboard.press('ControlOrMeta+a').catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await page.keyboard.insertText(prompt).catch(() => {});
        inserted = await composer.evaluate((el, text) => (el.textContent || '').replace(/\s+/g, ' ').includes(text.replace(/\s+/g, ' ').slice(0, 80)), prompt).catch(() => false);
      }
      if (!inserted) {
        await composer.click({ timeout: 10_000 }).catch(() => {});
        await page.evaluate((text) => document.execCommand('insertText', false, text), prompt).catch(() => {});
        inserted = await page.evaluate((text) => (document.body?.innerText || '').replace(/\s+/g, ' ').includes(text.replace(/\s+/g, ' ').slice(0, 80)), prompt).catch(() => false);
      }
      if (!inserted) {
        const diag = await page.evaluate(() => {
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
          const active = document.activeElement;
          return {
            activeTag: active?.tagName || null,
            activeId: active?.id || null,
            activeText: norm(active?.textContent || '').slice(0, 300),
            bodyTail: norm(document.body?.innerText || '').slice(-1000),
            editables: Array.from(document.querySelectorAll('[contenteditable="true"], textarea')).map((el) => ({
              tag: el.tagName,
              id: el.id || null,
              testid: el.getAttribute('data-testid'),
              aria: el.getAttribute('aria-label'),
              text: norm(el.textContent || el.value || '').slice(0, 200),
              html: (el.outerHTML || '').slice(0, 500),
            })).slice(0, 10),
          };
        }).catch((error) => ({ error: String(error) }));
        console.error(JSON.stringify({ promptInsertionDiagnostic: diag }, null, 2));
        throw new Error('Prompt insertion failed; refusing to submit stale composer text');
      }
    } else {
      await composer.fill(prompt);
      const inserted = await composer.inputValue().then((value) => value.includes(prompt.slice(0, 80))).catch(() => false);
      if (!inserted) throw new Error('Prompt insertion failed; refusing to submit stale textarea text');
    }

    // Wait dynamically for upload completion / send button to become active
    console.log('Waiting for upload completion (send button enabled)...');
    let uploadReady = false;
    for (let i = 0; i < 60; i++) {
      uploadReady = await page.evaluate(() => {
        const selectors = [
          '[data-testid="send-button"]',
          'button[aria-label="Send prompt"]',
          'button[aria-label*="Send" i]',
        ].join(',');
        const btn = document.querySelector(selectors);
        return btn && !btn.hasAttribute('disabled') && btn.getAttribute('aria-disabled') !== 'true';
      }).catch(() => false);
      if (uploadReady) break;
      await page.waitForTimeout(1000);
    }
    console.log(`Upload ready status: ${uploadReady}`);

    await page.waitForTimeout(500);
    const sent = await page.evaluate(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true';
      };
      const selectors = [
        '[data-testid="send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label*="Send" i]',
      ].join(',');
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const button = Array.from(document.querySelectorAll(selectors)).find(visible)
        || Array.from(document.querySelectorAll('button')).find((b) => visible(b) && /^Send prompt$/i.test(norm(b.textContent || b.getAttribute('aria-label'))));
      button?.click();
      return Boolean(button);
    });
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter').catch(() => {});
    if (!sent) await page.keyboard.press('Enter');
    if (!url) {
      await page.waitForFunction(() => location.href.includes('/c/'), { timeout: 60_000 }).catch(() => {});
    }
    await page.waitForTimeout(3000);
    console.log('Waiting for response generation to complete...');
    let started = false;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const active = await page.locator('button[aria-label="Stop generating"], button[aria-label="Stop"], [data-testid="stop-button"]').first().isVisible().catch(() => false);
      if (active) {
        started = true;
        break;
      }
    }
    for (let i = 0; i < 180; i++) {
      await page.waitForTimeout(1000);
      const active = await page.locator('button[aria-label="Stop generating"], button[aria-label="Stop"], [data-testid="stop-button"]').first().isVisible().catch(() => false);
      if (!active && started) {
        break;
      }
    }
    console.log('Generation completed.');
    await page.waitForTimeout(5000);
    
    // Attempt to download artifact in the same live session
    const downloadBtn = page.locator('button:has-text("Download"), button:has-text("ZIP"), button:has-text("patch")').last();
    let downloadResult = null;
    if (await downloadBtn.count() > 0) {
      console.log('Download button detected in live session! Attempting download...');
      try {
        await downloadBtn.scrollIntoViewIfNeeded().catch(() => {});
        const [download] = await Promise.all([
          page.context().waitForEvent('download', { timeout: 120000 }),
          downloadBtn.click({ force: true, timeout: 30000 }),
        ]);
        const suggested = download.suggestedFilename();
        const outDir = DEFAULT_OUT_DIR;
        await fs.mkdir(outDir, { recursive: true });
        const out = path.join(outDir, suggested);
        await download.saveAs(out);
        const bytes = (await fs.stat(out)).size;
        const sha = crypto.createHash('sha256').update(await fs.readFile(out)).digest('hex');
        downloadResult = { out, bytes, sha256: sha };
        console.log('Successfully downloaded artifact in live session:', downloadResult);
      } catch (err) {
        console.warn('Live download attempt failed:', String(err));
      }
    }

    const finalUrl = page.url();
    const ok = Boolean(url || finalUrl.includes('/c/'));
    if (!ok) {
      console.log(JSON.stringify({ ok: false, uploaded: files, promptSubmitted: false, requiredModel: requiredModel || null, modelCheck, finalUrl, reason: 'fresh upload did not navigate to a conversation URL' }, null, 2));
      throw new Error(`Fresh upload did not navigate to a ChatGPT conversation URL: ${finalUrl}`);
    }
    console.log(JSON.stringify({ ok: true, uploaded: files, promptSubmitted: true, requiredModel: requiredModel || null, modelCheck, finalUrl, downloadResult }, null, 2));
  });
}

async function visibleLabels(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    return Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],.__menu-item'))
      .filter(visible)
      .map((el) => (el.textContent || el.getAttribute('aria-label') || el.getAttribute('data-testid') || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter((label, index, all) => all.indexOf(label) === index)
      .slice(0, 80);
  }).catch(() => []);
}

async function isDeepResearchActive(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const composer = document.querySelector('#prompt-textarea,[data-testid="composer-input"],div[contenteditable="true"],textarea')?.closest('form');
    const scopes = [document.querySelector('[data-testid="composer-footer-actions"]'), composer].filter(Boolean);
    return scopes.some((scope) => /deep\s+research/i.test(scope.textContent || '') || Array.from(scope.querySelectorAll('button,[role="button"],[aria-label],[data-testid]')).some((el) => visible(el) && /deep\s+research/i.test(`${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-testid') || ''}`)));
  }).catch(() => false);
}

async function activateDeepResearch(page) {
  await page.locator('[data-testid="create-new-chat-button"]').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(2000);
  await clearChatGPTNotices(page);
  if (await isDeepResearchActive(page)) return true;

  const plusButton = page.locator('[data-testid="composer-plus-btn"], button[aria-label="Add files and more"], button[aria-label*="Add files" i], button[aria-label*="attach" i]').first();
  await plusButton.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});

  const menuVisible = () => page.evaluate(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    // ChatGPT's composer popup recently stopped exposing menu/dialog roles; it is now
    // often a plain div.popover containing div.__menu-item rows.
    return Array.from(document.querySelectorAll('[role="menu"],[data-radix-popper-content-wrapper],[role="dialog"],.popover,.__menu-item')).some((el) => visible(el) && /add photos|create image|deep research|web search|look something up|more/i.test((el.textContent || '').replace(/\s+/g, ' ')));
  });

  let opened = false;
  for (let attempt = 0; attempt < 4 && !opened; attempt++) {
    const box = await plusButton.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      await page.mouse.down().catch(() => {});
      await page.waitForTimeout(80);
      await page.mouse.up().catch(() => {});
    } else {
      await plusButton.click({ force: true, timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(900);
    opened = await menuVisible().catch(() => false);
  }
  if (!opened) return false;

  const expanded = new Set();
  for (let attempt = 0; attempt < 16; attempt++) {
    const clicked = await page.locator('[role="menuitemradio"]:has-text("Deep research"), [role="menuitem"]:has-text("Deep research"), [role="option"]:has-text("Deep research"), button:has-text("Deep research"), [role="button"]:has-text("Deep research"), .__menu-item:has-text("Deep research")')
      .first()
      .click({ force: true, timeout: 1000 })
      .then(() => true)
      .catch(async () => page.evaluate(() => {
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
        };
        const scopes = Array.from(document.querySelectorAll('[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],[data-headlessui-portal],[data-floating-ui-portal],[role="dialog"],.popover'));
        const roots = scopes.length ? [...scopes, document.body] : [document.body];
        const matches = [];
        for (const root of roots) {
          for (const el of Array.from(root.querySelectorAll('*'))) {
            if (!visible(el)) continue;
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            const aria = el.getAttribute('aria-label') || '';
            const testId = el.getAttribute('data-testid') || '';
            const textMatch = /^deep\s+research$/i.test(text);
            if (!textMatch && !/deep\s+research/i.test(`${aria} ${testId}`)) continue;
            matches.push({ el, textMatch });
          }
        }
        const target = matches.map(({ el }) => el.matches('.__menu-item,[data-radix-collection-item]') ? el : el.closest('.__menu-item,[data-radix-collection-item]')).find((el) => el && visible(el))
          || matches.map(({ el }) => el.closest('[role="menuitemradio"],[role="menuitem"],button,[role="button"],a')).find((el) => el && visible(el))
          || matches.find((m) => m.textMatch)?.el;
        if (!(target instanceof HTMLElement)) return false;
        target.scrollIntoView({ block: 'center', inline: 'center' });
        target.click();
        return true;
      }));
    if (clicked) {
      await page.waitForTimeout(1200);
      return await isDeepResearchActive(page);
    }

    const submenuLabel = ['Look something up', 'More'].find((label) => !expanded.has(label));
    if (submenuLabel) {
      const didExpand = await page.evaluate((label) => {
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
        };
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (!visible(el)) continue;
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (text !== label) continue;
          const target = el.closest('[role="menuitemradio"],[role="menuitem"],button,[role="button"],a,.__menu-item,[data-radix-collection-item]') || el;
          target.click();
          return true;
        }
        return false;
      }, submenuLabel).catch(() => false);
      expanded.add(submenuLabel);
      if (didExpand) {
        await page.waitForTimeout(800);
        continue;
      }
    }
    await page.mouse.wheel(0, 320).catch(() => {});
    await page.waitForTimeout(300);
  }
  return false;
}

async function submitPrompt(page, prompt) {
  const composer = page.locator('div#prompt-textarea[contenteditable="true"], div.ProseMirror[contenteditable="true"], [data-testid="composer-input"], textarea:visible').first();
  await composer.waitFor({ state: 'visible', timeout: 60000 });
  await composer.click({ timeout: 10000 }).catch(() => {});
  const editable = await composer.evaluate((el) => {
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'center' });
      el.focus();
      return el.isContentEditable;
    }
    return false;
  });
  if (editable) {
    await page.keyboard.press('ControlOrMeta+a').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await composer.evaluate((el, text) => {
      if (!(el instanceof HTMLElement)) return;
      el.focus();
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, prompt);
    const inserted = await composer.evaluate((el, text) => (el.textContent || '').replace(/\s+/g, ' ').includes(text.replace(/\s+/g, ' ').slice(0, 80)), prompt).catch(() => false);
    if (!inserted) {
      await composer.click({ timeout: 10000 }).catch(() => {});
      await page.keyboard.insertText(prompt).catch(() => {});
    }
  } else {
    await composer.fill(prompt);
  }

  await page.waitForTimeout(500);
  const sent = await page.evaluate(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true';
    };
    const button = Array.from(document.querySelectorAll('[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label*="Send" i]')).find(visible);
    button?.click();
    return Boolean(button);
  });
  await page.waitForTimeout(700);
  if (!sent) await page.keyboard.press('Enter').catch(() => {});
}

async function getResearchReport(page) {
  if (page.url().includes('/deep-research')) {
    await page.waitForFunction(() => location.href.includes('/c/'), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);
  }
  return page.evaluate(() => {
    const selectors = ['[data-message-author-role="assistant"]', 'main article', 'main [class*="prose"]'];
    let best = '';
    for (const sel of selectors) {
      for (const n of Array.from(document.querySelectorAll(sel))) {
        const t = (n.textContent || '').trim();
        if (t.length > best.length && !t.startsWith('window.__oai_')) best = t;
      }
    }
    return best;
  }).catch(() => '');
}

async function isResearching(page) {
  if (page.url().includes('/deep-research')) return true;
  const stop = await page.locator('button[aria-label="Stop streaming"], button[aria-label="Stop generating"]').first().isVisible().catch(() => false);
  if (stop) return true;
  const report = await getResearchReport(page);
  return Boolean(report && report.length < 500);
}

async function runDeepResearch(prompt, outDir, timeoutMs, pollIntervalMs, requiredModel) {
  await fs.mkdir(outDir, { recursive: true });
  return withChatGPT(async (page) => {
    await settle(page, CHATGPT_URL);
    let modelCheck = null;
    await clearChatGPTNotices(page);
    if (requiredModel) {
      modelCheck = await selectModelOnPage(page, requiredModel, 2000);
      const clicked = modelCheck.clickedModel || '';
      const selected = modelCheck.after.buttons.includes(requiredModel) || clicked === requiredModel || clicked.startsWith(`${requiredModel} `);
      if (!modelCheck.ok || !selected) throw new Error(`Required ChatGPT model not selected: ${requiredModel}`);
    }
    const active = await activateDeepResearch(page);
    const labels = await visibleLabels(page);
    await page.screenshot({ path: path.join(outDir, 'deep-research-before-submit.png'), fullPage: true }).catch(() => {});
    if (!active) throw new Error(`ChatGPT Deep Research mode was not detected from CloakBrowser helper. Visible labels: ${labels.join(', ')}`);

    await submitPrompt(page, prompt);
    await page.waitForTimeout(5000);
    const startedUrl = page.url();
    const startedDeepResearch = startedUrl.includes('/deep-research') || await isDeepResearchActive(page);
    const startedAt = Date.now();
    let lastHash = '';
    let stable = 0;
    let latestReport = '';
    const progressLog = [];
    while (Date.now() - startedAt < timeoutMs) {
      const report = await getResearchReport(page);
      if (report.length > latestReport.length) latestReport = report;
      const running = await isResearching(page);
      const hash = crypto.createHash('sha256').update(report).digest('hex');
      const row = { t: new Date().toISOString(), url: page.url(), running, chars: report.length };
      progressLog.push(row);
      await fs.writeFile(path.join(outDir, 'progress.jsonl'), progressLog.map((r) => JSON.stringify(r)).join('\n') + '\n');
      if (report) await fs.writeFile(path.join(outDir, 'research-output-latest.md'), report + '\n');
      if (!running && report.length > 1200) {
        stable = hash === lastHash ? stable + 1 : 0;
        if (stable >= 2) break;
      }
      lastHash = hash;
      await page.waitForTimeout(pollIntervalMs);
    }
    latestReport = (await getResearchReport(page)) || latestReport;
    const reportPath = path.join(outDir, 'research-output.md');
    if (latestReport) await fs.writeFile(reportPath, latestReport + '\n');
    await page.screenshot({ path: path.join(outDir, 'deep-research-final.png'), fullPage: true }).catch(() => {});
    const result = { ok: Boolean(latestReport), deepResearchModeActive: active, startedDeepResearch, chars: latestReport.length, finalUrl: page.url(), reportPath, modelCheck };
    await fs.writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  });
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || ['-h', '--help', 'help'].includes(cmd)) return usage();

  if (cmd === 'list') {
    const limit = Number(takeOpt(args, '--limit', '12')) || 12;
    return listChats(limit);
  }
  if (cmd === 'inspect') {
    const url = takeOpt(args, '--url');
    if (!url) throw new Error('--url is required');
    return inspectConversation(url);
  }
  if (cmd === 'screenshot') {
    const url = takeOpt(args, '--url');
    if (!url) throw new Error('--url is required');
    const out = takeOpt(args, '--out');
    if (!out) throw new Error('--out is required');
    const waitMs = Number(takeOpt(args, '--wait-ms', '6000')) || 6000;
    return screenshotConversation(url, out, waitMs);
  }
  if (cmd === 'images') {
    const url = takeOpt(args, '--url');
    if (!url) throw new Error('--url is required');
    const outDir = takeOpt(args, '--out-dir', DEFAULT_OUT_DIR);
    const minSize = Number(takeOpt(args, '--min-size', '280')) || 280;
    return extractConversationImages(url, outDir, minSize);
  }
  if (cmd === 'select-model') {
    const url = takeOpt(args, '--url');
    if (!url) throw new Error('--url is required');
    const model = takeOpt(args, '--model', 'Pro');
    const waitMs = Number(takeOpt(args, '--wait-ms', '6000')) || 6000;
    return selectModel(url, model, waitMs);
  }
  if (cmd === 'download') {
    const url = takeOpt(args, '--url');
    if (!url) throw new Error('--url is required');
    const turn = takeOpt(args, '--turn', 'last');
    const label = takeOpt(args, '--label', DEFAULT_LABEL);
    const outDir = takeOpt(args, '--out-dir', DEFAULT_OUT_DIR);
    return downloadArtifact(url, turn, label, outDir);
  }
  if (cmd === 'upload') {
    const url = takeOpt(args, '--url', undefined);
    const prompt = takeOpt(args, '--prompt', '');
    const promptFile = takeOpt(args, '--prompt-file', '');
    const files = takeAllOpts(args, '--file');
    const uploadWaitMs = Number(takeOpt(args, '--upload-wait-ms', '10000')) || 10000;
    const requiredModel = takeOpt(args, '--require-model', '');
    const text = promptFile ? await fs.readFile(expandHome(promptFile), 'utf8') : prompt;
    if (!text) throw new Error('--prompt or --prompt-file is required');
    return uploadFiles(url, files, text, uploadWaitMs, requiredModel);
  }
  if (cmd === 'deep-research') {
    const prompt = takeOpt(args, '--prompt', '');
    const promptFile = takeOpt(args, '--prompt-file', '');
    const outDir = takeOpt(args, '--out-dir', path.join(DEFAULT_OUT_DIR, `deep-research-${Date.now()}`));
    const timeoutMs = Number(takeOpt(args, '--timeout-ms', '1800000')) || 1800000;
    const pollIntervalMs = Number(takeOpt(args, '--poll-interval-ms', '10000')) || 10000;
    const requiredModel = takeOpt(args, '--require-model', 'Pro');
    const text = promptFile ? await fs.readFile(expandHome(promptFile), 'utf8') : prompt;
    if (!text) throw new Error('--prompt or --prompt-file is required');
    return runDeepResearch(text, expandHome(outDir), timeoutMs, pollIntervalMs, requiredModel);
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

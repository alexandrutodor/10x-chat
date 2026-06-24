import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { getIsolatedProfileDir, getSharedProfileDir } from '../paths.js';
import type { ProfileMode, ProviderName } from '../types.js';
import { launchSharedBrowserSession } from './daemon.js';
import { getChromium, getEngineName } from './engine.js';
import { acquireProfileLock, type ProfileLock } from './lock.js';
import { CHROMIUM_ARGS } from './process.js';
import { saveStorageState } from './state.js';
import { detectChromeChannel, STEALTH_INIT_SCRIPT } from './stealth.js';

async function markProfileClean(profileDir: string): Promise<void> {
  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  try {
    const prefs = JSON.parse(await readFile(prefsPath, 'utf8')) as {
      profile?: { exit_type?: string; exited_cleanly?: boolean };
    };
    prefs.profile = { ...(prefs.profile ?? {}), exit_type: 'Normal', exited_cleanly: true };
    await writeFile(prefsPath, JSON.stringify(prefs));
  } catch {
    // New profile or unreadable prefs; Chrome will create/fix it.
  }
}

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  /** Profile lock (only set in isolated mode; null in shared mode). */
  lock: ProfileLock | null;
  close: () => Promise<void>;
}

export interface LaunchOptions {
  provider: ProviderName;
  headless?: boolean;
  /** Initial URL to navigate to after launch. */
  url?: string;
  /**
   * Profile mode:
   * - 'shared': each process launches its own browser but loads shared
   *   cookies/storage from a common state file. Truly parallel across
   *   processes — no locks, no conflicts.
   * - 'isolated': per-provider persistent context with profile lock
   *   (original behavior).
   * Defaults to 'shared'.
   */
  profileMode?: ProfileMode;
  /** Named profile under ~/.10x-chat/profiles/<name>. Forces isolated persistent mode. */
  profile?: string;
  /**
   * If true, use a persistent context even in shared mode.
   * Used by `login` command which needs the user to interact and have
   * state auto-persisted to disk. After login, storage state is exported
   * for use by regular (non-persistent) shared sessions.
   */
  persistent?: boolean;
}

/**
 * Launch a browser session for a provider.
 *
 * **Shared mode (default):** Each process gets its own Chromium instance
 * loaded with shared cookies from `~/.10x-chat/profiles/default/storage-state.json`.
 * Multiple `npx 10x-chat` processes can run truly in parallel — no locks.
 * On close, updated cookies are saved back.
 *
 * **Shared + persistent** (login only): Uses `launchPersistentContext` on the
 * shared profile dir so the user can interact and cookies auto-persist.
 * Requires profile lock (only one login at a time).
 *
 * **Isolated mode:** Each provider gets its own persistent Chromium context
 * and profile directory. Original behavior with profile lock.
 */
export async function launchBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const { profileMode = 'shared', persistent = false, profile } = opts;

  if (profile || profileMode === 'isolated') {
    return launchIsolatedBrowser(opts);
  }

  if (persistent) {
    return launchSharedPersistentBrowser(opts);
  }

  return launchSharedBrowser(opts);
}

/**
 * Shared mode (non-persistent): connects to or launches a shared browser daemon.
 * Multiple CLI invocations share the same Chromium process. Browser is only
 * stopped when the last tab (across all invocations) is closed.
 */
async function launchSharedBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const { headless = true, url } = opts;
  const session = await launchSharedBrowserSession({ headless, url });
  return {
    context: session.context,
    page: session.page,
    lock: null,
    close: session.close,
  };
}

/**
 * Shared mode (persistent): for login command.
 * Uses persistent context so cookies auto-save to disk.
 * Requires lock since persistent contexts can't share a profile dir.
 */
async function launchSharedPersistentBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const { headless = true, url } = opts;
  const profileDir = getSharedProfileDir();
  await mkdir(profileDir, { recursive: true });

  const lock = await acquireProfileLock(profileDir);
  await markProfileClean(profileDir);

  let context: BrowserContext;
  let page: Page;
  try {
    const channel = detectChromeChannel();
    context = await (await getChromium()).launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1280, height: 900 },
      ...(channel ? { channel } : {}),
      args: CHROMIUM_ARGS,
    });
    if (getEngineName() !== 'cloakbrowser') {
      await context.addInitScript(STEALTH_INIT_SCRIPT);
    }

    page = context.pages()[0] ?? (await context.newPage());

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
  } catch (error) {
    await lock.release();
    throw error;
  }

  const close = async () => {
    try {
      // Export storage state for non-persistent sessions to use
      await saveStorageState(context);
    } catch {
      // best effort
    }
    try {
      await context.close();
    } finally {
      await lock.release();
    }
  };

  return { context, page, lock, close };
}

/**
 * Isolated mode (original behavior).
 * Per-provider persistent context with profile lock.
 */
async function launchIsolatedBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const { provider, headless = true, url, profile } = opts;
  const profileDir = getIsolatedProfileDir(profile ?? provider);
  await mkdir(profileDir, { recursive: true });

  const lock = await acquireProfileLock(profileDir);
  await markProfileClean(profileDir);

  let context: BrowserContext;
  let page: Page;
  try {
    const channel = detectChromeChannel();
    context = await (await getChromium()).launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1280, height: 900 },
      ...(channel ? { channel } : {}),
      args: CHROMIUM_ARGS,
    });
    if (getEngineName() !== 'cloakbrowser') {
      await context.addInitScript(STEALTH_INIT_SCRIPT);
    }

    page = context.pages()[0] ?? (await context.newPage());

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
  } catch (error) {
    await lock.release();
    throw error;
  }

  const close = async () => {
    try {
      await context.close();
    } finally {
      await lock.release();
    }
  };

  return { context, page, lock, close };
}

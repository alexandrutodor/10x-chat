/**
 * Browser engine abstraction.
 *
 * Tries to use CloakBrowser first, then Patchright,
 * then falls back to Playwright if neither stealth engine is installed.
 *
 * CloakBrowser/Patchright reduce automation detection signals that
 * Playwright leaks, making browser automation less likely to trip
 * Cloudflare, DataDome, etc.
 *
 * Both libraries export the same API surface — this module
 * re-exports `chromium` from whichever is available.
 */

import type { BrowserType } from 'playwright';

let _chromium: BrowserType | undefined;
let _engineName: 'cloakbrowser' | 'patchright' | 'playwright' | 'unknown' = 'unknown';
let _loaded = false;

async function loadEngine(): Promise<BrowserType> {
  if (_chromium) return _chromium;

  // Try CloakBrowser first. It exposes launch helpers, not a BrowserType, so
  // adapt only the two methods 10x-chat uses.
  try {
    const cloakbrowser = await import('cloakbrowser');
    const humanize = process.env.TEN_X_CHAT_CLOAK_HUMANIZE !== '0';
    const cleanOptions = (options?: Record<string, unknown>) => {
      const { channel: _channel, args: _args, ...rest } = options ?? {};
      return rest;
    };
    _chromium = {
      launch: async (options?: Record<string, unknown>) => {
        return cloakbrowser.launch({ ...cleanOptions(options), humanize });
      },
      launchPersistentContext: async (userDataDir: string, options?: Record<string, unknown>) => {
        return cloakbrowser.launchPersistentContext({
          userDataDir,
          ...cleanOptions(options),
          humanize,
        });
      },
    } as unknown as BrowserType;
    _engineName = 'cloakbrowser';
    _loaded = true;
    return _chromium;
  } catch {
    // CloakBrowser not installed or broken — try Patchright
  }

  try {
    const patchright = await import('patchright');
    if (patchright.chromium) {
      _chromium = patchright.chromium as unknown as BrowserType;
      _engineName = 'patchright';
      _loaded = true;
      return _chromium;
    }
  } catch {
    // Patchright not installed or broken — fall back to Playwright
  }

  try {
    const playwright = await import('playwright');
    _chromium = playwright.chromium as unknown as BrowserType;
    _engineName = 'playwright';
    _loaded = true;
    return _chromium;
  } catch {
    throw new Error(
      'No browser engine is installed. Run: npm install cloakbrowser playwright-core (recommended), patchright, or playwright',
    );
  }
}

/** Get the chromium browser type (async — loads engine on first call). */
export async function getChromium(): Promise<BrowserType> {
  return loadEngine();
}

/** Which engine is active. Returns 'unknown' if not yet loaded. */
export function getEngineName(): 'cloakbrowser' | 'patchright' | 'playwright' | 'unknown' {
  return _engineName;
}

/** Whether the engine has been loaded yet. */
export function isEngineLoaded(): boolean {
  return _loaded;
}

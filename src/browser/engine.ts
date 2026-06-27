/**
 * Browser engine abstraction.
 *
 * Tries to use CloakBrowser.
 *
 * CloakBrowser reduces automation detection signals that
 * Playwright leaks, making browser automation less likely to trip
 * Cloudflare, DataDome, etc.
 */

import type { BrowserType } from 'playwright';

let _chromium: BrowserType | undefined;
let _engineName: 'cloakbrowser' | 'unknown' = 'unknown';
let _loaded = false;

async function loadEngine(): Promise<BrowserType> {
  if (_chromium) return _chromium;

  // Try CloakBrowser. It exposes launch helpers, not a BrowserType, so
  // adapt only the two methods 10x-chat uses.
  try {
    const cloakbrowser = await import('cloakbrowser');
    const humanize = process.env.TEN_X_CHAT_CLOAK_HUMANIZE !== '0';
    const cleanOptions = (options?: Record<string, unknown>) => {
      const { channel: _channel, ...rest } = options ?? {};
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
  } catch (err) {
    throw new Error(
      `CloakBrowser is not installed or failed to load. Run: npm install cloakbrowser. Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Get the chromium browser type (async — loads engine on first call). */
export async function getChromium(): Promise<BrowserType> {
  return loadEngine();
}

/** Which engine is active. Returns 'unknown' if not yet loaded. */
export function getEngineName(): 'cloakbrowser' | 'unknown' {
  return _engineName;
}

/** Whether the engine has been loaded yet. */
export function isEngineLoaded(): boolean {
  return _loaded;
}

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import type { Page } from 'playwright';
import { launchBrowser } from '../browser/index.js';
import { resolveHeadlessMode } from '../browser/mode.js';
import { waitForUrlPathPrefix } from '../browser/page-utils.js';
import { loadConfig } from '../config.js';
import { activateGeminiTool } from '../providers/gemini.js';
import { getProvider } from '../providers/index.js';
import { createSession, saveBundle, saveResponse, updateSession } from '../session/index.js';
import type { ProviderName, ResearchOptions, ResearchResult } from '../types.js';

/**
 * Provider-specific deep research selectors and logic.
 * Each provider has a different UI flow for triggering "deep research" mode.
 */
interface ResearchProviderConfig {
  /** How to activate deep research mode before submitting the prompt. */
  activateResearch: (page: Page) => Promise<void>;
  /** Selector for the research progress/status indicator. */
  progressSelector: string;
  /** Extract progress text (e.g. "Searching 12 sources..."). */
  getProgress: (page: Page) => Promise<string>;
  /** Check if research is still running. */
  isResearching: (page: Page) => Promise<boolean>;
  /** Extract the final research report text. */
  getReport: (page: Page) => Promise<string>;
  /** Extract the final research report HTML. */
  getReportHtml: (page: Page) => Promise<string>;
}

const geminiResearch: ResearchProviderConfig = {
  async activateResearch(page: Page) {
    // Gemini Deep Research: click the "Deep Research" chip/button
    // It may appear as a button or in a menu depending on the model
    const deepResearchBtn = page
      .locator(
        'button:has-text("Deep Research"), [aria-label*="Deep Research"], button:has-text("Research")',
      )
      .first();
    const visible = await deepResearchBtn.isVisible().catch(() => false);
    if (visible) {
      await deepResearchBtn.click();
      await page.waitForTimeout(1000);
      return;
    }

    // Ultra accounts may expose Deep Research from the Gemini Tools menu.
    const activated = await activateGeminiTool(page, 'Deep Research');
    if (!activated) {
      const available = await page.evaluate(() => {
        const root = document.querySelector('.cdk-overlay-container') ?? document.body;
        return Array.from(
          root.querySelectorAll(
            'button,[role="menuitem"],[role="option"],toolbox-drawer-item,gem-menu-item',
          ),
        )
          .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .filter((label, index, all) => all.indexOf(label) === index)
          .slice(0, 20)
          .join(', ');
      });
      throw new Error(
        `Gemini Deep Research is not rendered in this profile${available ? ` (available: ${available})` : ''}. Use a profile/account where the Deep Research tool is visible.`,
      );
    }
  },
  progressSelector: '.research-progress, .thinking-indicator, model-response [class*="progress"]',
  async getProgress(page: Page) {
    const progress =
      (await page
        .locator('.research-progress, .thinking-indicator, model-response [class*="progress"]')
        .first()
        .textContent()
        .catch(() => '')) ?? '';
    if (progress.trim()) return progress.trim();

    // Gemini may answer normally when Deep Research is unavailable; use the response text
    // so the research command can finish instead of waiting for the full timeout.
    return page
      .locator('model-response .model-response-text, model-response message-content')
      .last()
      .evaluate((el) => ((el as HTMLElement).innerText || el.textContent || '').trim())
      .catch(() => '');
  },
  async isResearching(page: Page) {
    // Check for active research indicators
    const indicators = [
      '.research-progress',
      '.thinking-indicator',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Cancel"]',
      'model-response [class*="loading"]',
      'model-response [class*="progress"]',
    ];
    for (const sel of indicators) {
      const visible = await page
        .locator(sel)
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) return true;
    }
    return false;
  },
  async getReport(page: Page) {
    const responseTurn = page
      .locator('model-response .model-response-text, model-response message-content')
      .last();
    return (
      (await responseTurn
        .evaluate((el) => ((el as HTMLElement).innerText || el.textContent || '').trim())
        .catch(() => '')) ?? ''
    );
  },
  async getReportHtml(page: Page) {
    const responseTurn = page
      .locator('model-response .model-response-text, model-response message-content')
      .last();
    return (await responseTurn.innerHTML().catch(() => '')) ?? '';
  },
};

async function isChatGPTDeepResearchActive(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const visible = (el: Element | null): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const composer = document
      .querySelector(
        '#prompt-textarea,[data-testid="composer-input"],div[contenteditable="true"],textarea',
      )
      ?.closest('form');
    const scopes = [
      document.querySelector('[data-testid="composer-footer-actions"]'),
      composer,
    ].filter((el): el is Element => Boolean(el));
    return scopes.some((scope) =>
      Array.from(scope.querySelectorAll('button,[role="button"],[aria-label],[data-testid]')).some(
        (el) =>
          visible(el) &&
          /deep\s+research/i.test(
            `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('data-testid') ?? ''}`,
          ),
      ),
    );
  });
}

async function activateChatGPTDeepResearchFromComposer(page: Page): Promise<boolean> {
  await page
    .locator('[data-testid="create-new-chat-button"]')
    .first()
    .click({ force: true })
    .catch(() => {});
  await page.waitForTimeout(2_000);

  if (await isChatGPTDeepResearchActive(page)) return true;

  const plusButton = page
    .locator(
      '[data-testid="composer-plus-btn"], button[aria-label="Add files and more"], button[aria-label*="Add files" i], button[aria-label*="attach" i]',
    )
    .first();
  await plusButton.waitFor({ state: 'visible', timeout: 20_000 }).catch(async () => {
    await page
      .locator('[data-testid="create-new-chat-button"]')
      .first()
      .click({ force: true })
      .catch(() => {});
    await page.waitForTimeout(2_000);
  });

  let opened = false;
  const menuVisible = () =>
    page.evaluate(() => {
      const visible = (el: Element | null): el is HTMLElement => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      };
      return Array.from(
        document.querySelectorAll('[role="menu"],[data-radix-popper-content-wrapper]'),
      ).some((el) => {
        const text = (el.textContent ?? '').replace(/\s+/g, ' ');
        return visible(el) && /add photos|create image|deep research|web search/i.test(text);
      });
    });

  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    const box = await plusButton.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      await page.mouse.down().catch(() => {});
      await page.waitForTimeout(80);
      await page.mouse.up().catch(() => {});
      await page.waitForTimeout(700);
      opened = await menuVisible();
    } else {
      await plusButton.click({ force: true, timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(700);
      opened = await menuVisible();
    }
  }

  if (!opened) {
    opened = await page.evaluate(() => {
      const visible = (el: Element | null): el is HTMLElement => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      };
      const composer = document.querySelector(
        '#prompt-textarea,[data-testid="composer-input"],div[contenteditable="true"],textarea',
      );
      if (!(composer instanceof HTMLElement)) return false;
      const composerRect = composer.getBoundingClientRect();
      const buttons = Array.from(document.querySelectorAll('button,[role="button"]')).filter(
        visible,
      );
      const nearComposer = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        return Math.abs(rect.top - composerRect.top) < 180 && rect.right < composerRect.right + 260;
      };
      const scored = buttons
        .map((el) => {
          const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          const aria = el.getAttribute('aria-label') ?? '';
          const testId = el.getAttribute('data-testid') ?? '';
          const haystack = `${text} ${aria} ${testId}`;
          const score = /add photos and files|attach|upload|tool|^\+$|add/i.test(haystack) ? 0 : 1;
          const distance = composerRect
            ? Math.abs(el.getBoundingClientRect().top - composerRect.top)
            : 0;
          return { el, score, distance, near: nearComposer(el) };
        })
        .filter((x) => x.near)
        .sort((a, b) => a.score - b.score || a.distance - b.distance);
      const target = scored[0]?.el;
      target?.click();
      return Boolean(target);
    });
  }
  if (!opened) return false;
  await page.waitForTimeout(700);

  const expandedChatGptResearchSubmenus = new Set<string>();
  for (let attempt = 0; attempt < 12; attempt++) {
    const deepOption = page
      .locator(
        '[role="menuitemradio"]:has-text("Deep research"), [role="menuitem"]:has-text("Deep research"), [role="option"]:has-text("Deep research"), button:has-text("Deep research"), [role="button"]:has-text("Deep research")',
      )
      .first();
    const clicked = await deepOption
      .click({ force: true, timeout: 1_000 })
      .then(() => true)
      .catch(async () =>
        page.evaluate(() => {
          const visible = (el: Element | null): el is HTMLElement => {
            if (!(el instanceof HTMLElement)) return false;
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden'
            );
          };
          const scopes = Array.from(
            document.querySelectorAll(
              '[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],[data-headlessui-portal],[data-floating-ui-portal],[role="dialog"]',
            ),
          );
          const roots = scopes.length ? [...scopes, document.body] : [document.body];
          const matches: Array<{ el: Element; textMatch: boolean }> = [];
          for (const root of roots) {
            for (const el of Array.from(root.querySelectorAll('*'))) {
              if (!visible(el)) continue;
              const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
              const aria = el.getAttribute('aria-label') ?? '';
              const testId = el.getAttribute('data-testid') ?? '';
              const textMatch = /^deep\s+research$/i.test(text);
              if (!textMatch && !/deep\s+research/i.test(`${aria} ${testId}`)) continue;
              matches.push({ el, textMatch });
            }
          }
          const target =
            matches
              .map(({ el }) =>
                el.matches('.__menu-item,[data-radix-collection-item]')
                  ? el
                  : el.closest('.__menu-item,[data-radix-collection-item]'),
              )
              .find((el): el is Element => Boolean(el) && visible(el)) ??
            matches
              .map(({ el }) =>
                el.closest('[role="menuitemradio"],[role="menuitem"],button,[role="button"],a'),
              )
              .find((el): el is Element => Boolean(el) && visible(el)) ??
            matches.find((match) => match.textMatch)?.el;
          if (!(target instanceof HTMLElement)) return false;
          target.scrollIntoView({ block: 'center', inline: 'center' });
          target.click();
          return true;
        }),
      );
    if (clicked) {
      await page.waitForTimeout(1_000);
      return true;
    }

    const submenuLabel = ['Look something up', 'More'].find(
      (label) => !expandedChatGptResearchSubmenus.has(label),
    );
    if (submenuLabel) {
      const expanded = await page.evaluate((label) => {
        const visible = (el: Element | null): el is HTMLElement => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        };
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (!visible(el)) continue;
          const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (text !== label) continue;
          const target =
            el.closest(
              '[role="menuitemradio"],[role="menuitem"],button,[role="button"],a,.__menu-item,[data-radix-collection-item]',
            ) ?? el;
          (target as HTMLElement).click();
          return true;
        }
        return false;
      }, submenuLabel);
      expandedChatGptResearchSubmenus.add(submenuLabel);
      if (expanded) {
        await page.waitForTimeout(700);
        continue;
      }
    }

    const scrolled = await page.evaluate(() => {
      const roots = Array.from(
        document.querySelectorAll(
          '[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],[data-headlessui-portal],[data-floating-ui-portal],[role="dialog"]',
        ),
      ).filter((el): el is HTMLElement => el instanceof HTMLElement);
      const scrollables = roots.flatMap((root) =>
        Array.from(root.querySelectorAll('*')).filter((el): el is HTMLElement => {
          if (!(el instanceof HTMLElement)) return false;
          const style = getComputedStyle(el);
          return el.scrollHeight > el.clientHeight + 4 && style.display !== 'none';
        }),
      );
      for (const el of scrollables) el.scrollTop += 320;
      return scrollables.length > 0;
    });
    if (!scrolled) await page.mouse.wheel(0, 320).catch(() => {});
    await page.waitForTimeout(250);
  }
  return false;
}

const chatgptResearch: ResearchProviderConfig = {
  async activateResearch(page: Page) {
    // ChatGPT exposes Deep Research from the composer + menu, not reliably via /deep-research.
    const active = await activateChatGPTDeepResearchFromComposer(page);
    if (!active || !(await isChatGPTDeepResearchActive(page))) {
      const labels = await page.evaluate(() => {
        const visible = (el: Element | null): el is HTMLElement => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        };
        return Array.from(
          document.querySelectorAll(
            '[role="menu"] button,[role="menuitemradio"],[role="menuitem"],[role="option"],.__menu-item,[data-radix-popper-content-wrapper] button,[data-radix-popper-content-wrapper] .__menu-item,[data-headlessui-portal] button,[data-floating-ui-portal] button,[role="dialog"] button,button',
          ),
        )
          .filter(visible)
          .map((el) =>
            (el.textContent ?? el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim(),
          )
          .filter(Boolean)
          .filter((label, index, all) => all.indexOf(label) === index)
          .slice(0, 30)
          .join(', ');
      });
      throw new Error(
        `ChatGPT Deep Research mode was not detected from the composer + menu${labels ? ` (visible: ${labels})` : ''}.`,
      );
    }
    console.log('  Deep research mode active');
  },
  progressSelector: '[data-message-author-role="assistant"]',
  async getProgress(page: Page) {
    // ChatGPT deep research navigates: /deep-research → /c/<id> once result arrives.
    const url = page.url();
    if (url.includes('/deep-research')) {
      // Still researching — try to find any progress text in the page
      const bodyText = await page.evaluate(() => {
        const main = document.querySelector('main');
        if (!main) return '';
        const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
        const texts: string[] = [];
        let node = walker.nextNode() as Text | null;
        while (node) {
          const t = node.textContent?.trim();
          if (t && t.length > 20 && !t.startsWith('window.')) texts.push(t);
          node = walker.nextNode() as Text | null;
        }
        return texts.join(' ').slice(0, 300);
      });
      return bodyText || 'Researching...';
    }

    // At /c/<id> — extract assistant response robustly (DOM varies across experiments)
    const text = await page.evaluate(() => {
      const selectors = [
        '[data-message-author-role="assistant"]',
        'main article',
        'main [class*="prose"]',
      ];
      let best = '';
      for (const sel of selectors) {
        const nodes = Array.from(document.querySelectorAll(sel));
        for (const n of nodes) {
          const t = (n.textContent || '').trim();
          if (t.length > best.length && !t.startsWith('window.__oai_')) {
            best = t;
          }
        }
      }
      return best.slice(0, 5000);
    });

    if (!text) return '';
    return text.split('\n').slice(0, 3).join(' ').slice(0, 200);
  },
  async isResearching(page: Page) {
    const url = page.url();
    // If still at /deep-research, research is definitely still running
    if (url.includes('/deep-research')) return true;
    // At /c/<id> — check for streaming indicators
    const stopBtn = await page
      .locator('button[aria-label="Stop streaming"], button[aria-label="Stop generating"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (stopBtn) return true;
    const report = await chatgptResearch.getReport(page);
    if (report && report.length < 500) return true; // ponytail: ignore short preambles
    return false;
  },
  async getReport(page: Page) {
    // Wait briefly for /c/<id> navigation if needed
    const url = page.url();
    if (url.includes('/deep-research')) {
      await waitForUrlPathPrefix(page, '/c/', 30_000).catch(() => {});
      await page.waitForTimeout(5_000);
    }

    // Robust extraction across ChatGPT UI variants
    const text = await page.evaluate(() => {
      const selectors = [
        '[data-message-author-role="assistant"]',
        'main article',
        'main [class*="prose"]',
      ];
      let best = '';
      for (const sel of selectors) {
        const nodes = Array.from(document.querySelectorAll(sel));
        for (const n of nodes) {
          const t = (n.textContent || '').trim();
          if (t.length > best.length && !t.startsWith('window.__oai_')) best = t;
        }
      }
      return best;
    });
    return text.trim();
  },
  async getReportHtml(page: Page) {
    const lastTurn = page.locator('[data-message-author-role="assistant"]').last();
    return (await lastTurn.innerHTML().catch(() => '')) ?? '';
  },
};

const perplexityResearch: ResearchProviderConfig = {
  async activateResearch(page: Page) {
    // Perplexity: toggle "Pro Search" or "Deep Research" if available
    const proBtn = page
      .locator('button:has-text("Pro"), button:has-text("Deep"), [aria-label*="Pro Search"]')
      .first();
    const visible = await proBtn.isVisible().catch(() => false);
    if (visible) {
      await proBtn.click();
      await page.waitForTimeout(500);
    }
  },
  progressSelector: '.prose',
  async getProgress(page: Page) {
    const prose = page.locator('.prose').first();
    const text = (await prose.textContent().catch(() => ''))?.trim() ?? '';
    return text.slice(0, 200);
  },
  async isResearching(page: Page) {
    // Perplexity shows a pulsing indicator or "Searching..." text while working
    const searching = await page
      .locator('[class*="searching"], [class*="loading"], [class*="animate-pulse"]')
      .first()
      .isVisible()
      .catch(() => false);
    return searching;
  },
  async getReport(page: Page) {
    const prose = page.locator('.prose').first();
    return (await prose.textContent().catch(() => ''))?.trim() ?? '';
  },
  async getReportHtml(page: Page) {
    const prose = page.locator('.prose').first();
    return (await prose.innerHTML().catch(() => '')) ?? '';
  },
};

const RESEARCH_CONFIGS: Partial<Record<ProviderName, ResearchProviderConfig>> = {
  gemini: geminiResearch,
  chatgpt: chatgptResearch,
  perplexity: perplexityResearch,
};

/**
 * Run a deep research session:
 * 1. Launch browser → navigate to provider
 * 2. Activate deep research mode
 * 3. Submit the research query
 * 4. Poll for progress (non-blocking style with status updates)
 * 5. Wait for completion
 * 6. Extract and save the report
 */
export async function runResearch(options: ResearchOptions): Promise<ResearchResult> {
  const config = await loadConfig();
  const providerName = options.provider ?? 'gemini';
  const provider = getProvider(providerName);
  const researchConfig = RESEARCH_CONFIGS[providerName];

  if (!researchConfig) {
    throw new Error(
      `Provider "${providerName}" does not support deep research. Use: gemini, chatgpt, perplexity`,
    );
  }

  const timeoutMs = options.timeoutMs ?? 600_000; // 10 minutes default
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const headless = resolveHeadlessMode(providerName, config.headless, options.headed === true);
  const profileMode = options.profile || options.isolatedProfile ? 'isolated' : config.profileMode;

  // Create session
  const session = await createSession(providerName, options.prompt, options.model);
  await saveBundle(session.id, options.prompt);

  console.log(chalk.dim(`Session: ${session.id}`));
  console.log(chalk.blue(`Provider: ${provider.config.displayName}`));
  if (options.model) console.log(chalk.dim(`Model: ${options.model}`));
  console.log(chalk.dim(`Timeout: ${Math.round(timeoutMs / 1000)}s`));
  console.log(chalk.dim(`Poll interval: ${Math.round(pollIntervalMs / 1000)}s\n`));

  let browser: Awaited<ReturnType<typeof launchBrowser>>;
  try {
    await updateSession(session.id, { status: 'running' });
    browser = await launchBrowser({
      provider: providerName,
      headless,
      url: provider.config.url,
      profileMode,
      profile: options.profile,
    });
  } catch (error) {
    await updateSession(session.id, { status: 'failed' });
    throw error;
  }

  const startTime = Date.now();

  try {
    // Check login
    const loggedIn = await provider.actions.isLoggedIn(browser.page);
    if (!loggedIn) {
      throw new Error(
        `Not logged in to ${provider.config.displayName}. Run: 10x-chat login ${providerName}`,
      );
    }

    if (options.model && provider.actions.selectModel) {
      console.log(chalk.dim(`Selecting model: ${options.model}`));
      await provider.actions.selectModel(browser.page, options.model);
    }

    // Step 1: Activate deep research mode
    console.log(chalk.dim('Activating deep research mode...'));
    await researchConfig.activateResearch(browser.page);

    if (options.attach?.length) {
      if (!provider.actions.attachFiles) {
        throw new Error(`${provider.config.displayName} does not support file attachments`);
      }
      console.log(chalk.dim(`Attaching ${options.attach.length} file(s)...`));
      await provider.actions.attachFiles(browser.page, options.attach);
    }

    // Step 2: Submit the research query
    console.log(chalk.dim('Submitting research query...'));
    await provider.actions.submitPrompt(browser.page, options.prompt);

    // Step 3: Wait for the initial response to appear
    console.log(chalk.dim('Waiting for response...'));
    const initialWaitMs = Math.min(timeoutMs / 2, 60_000);
    let hasInitialContent = false;
    const waitStart = Date.now();
    while (Date.now() - waitStart < initialWaitMs) {
      const text = await researchConfig.getProgress(browser.page);
      const researching = await researchConfig.isResearching(browser.page);
      if (text.length > 0 || researching) {
        hasInitialContent = true;
        break;
      }
      await browser.page.waitForTimeout(2_000);
    }
    if (!hasInitialContent) {
      console.log(chalk.yellow('  No response detected yet, continuing to poll...'));
    }

    // Step 4: Poll for progress with non-blocking status updates
    console.log(chalk.dim('Research in progress...\n'));
    let lastProgress = '';
    let stableCount = 0;
    const stableThreshold = 5; // more conservative — deep research can pause between sections
    while (Date.now() - startTime < timeoutMs) {
      const researching = await researchConfig.isResearching(browser.page);
      const progress = await researchConfig.getProgress(browser.page);

      // Show progress updates
      if (progress && progress !== lastProgress && progress !== 'Researching...') {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const preview = progress.length > 120 ? `${progress.slice(0, 120)}...` : progress;
        console.log(chalk.dim(`  [${elapsed}s] ${preview}`));
        lastProgress = progress;
        stableCount = 0;
      } else if (!researching && progress.length > 0 && progress !== 'Researching...') {
        // Content exists and no streaming indicators — may be done
        stableCount++;
        if (stableCount >= stableThreshold) {
          console.log(chalk.green('\n✓ Research complete'));
          break;
        }
      } else if (researching) {
        // Still researching — log periodic heartbeat
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (elapsed % 30 < pollIntervalMs / 1000) {
          console.log(chalk.dim(`  [${elapsed}s] Still researching...`));
        }
        stableCount = 0;
      }

      await browser.page.waitForTimeout(pollIntervalMs);
    }

    // Step 4: Extract the final report
    let report = await researchConfig.getReport(browser.page);

    // Fallback: if custom extractor got nothing, use provider captureResponse
    // (handles provider-specific SPA/DOM edge cases).
    if (!report || report.trim().length < 10) {
      const remainingMs = Math.max(timeoutMs - (Date.now() - startTime), 15_000);
      const captured = await provider.actions
        .captureResponse(browser.page, { timeoutMs: remainingMs })
        .catch(() => null);
      if (captured?.text && captured.text.trim().length > report.trim().length) {
        report = captured.text;
      }
    }

    const truncated = Date.now() - startTime >= timeoutMs && stableCount < stableThreshold;

    // Save response
    await saveResponse(session.id, report);

    // Save report to file if requested
    let savedPath: string | undefined;
    if (options.saveDir || report.length > 0) {
      const saveDir =
        options.saveDir ?? path.join(os.homedir(), '.10x-chat', 'sessions', session.id);
      await mkdir(saveDir, { recursive: true });
      const filename = `research-${providerName}-${new Date().toISOString().slice(0, 10)}.md`;
      savedPath = path.join(saveDir, filename);
      await writeFile(savedPath, report);
    }

    const durationMs = Date.now() - startTime;
    await updateSession(session.id, {
      status: truncated ? 'timeout' : 'completed',
      durationMs,
    });

    return {
      sessionId: session.id,
      provider: providerName,
      report,
      truncated,
      durationMs,
      savedPath,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const isTimeout = error instanceof Error && error.message.toLowerCase().includes('timeout');
    await updateSession(session.id, {
      status: isTimeout ? 'timeout' : 'failed',
      durationMs,
    });
    throw error;
  } finally {
    await browser.close();
  }
}

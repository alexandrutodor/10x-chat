import type { Page } from 'playwright';

/**
 * Shared prompt submission helper.
 *
 * All chat providers follow the same pattern:
 * 1. Wait for composer → click → select-all → delete
 * 2. Insert text via the right input path for the element type
 * 3. Wait → click send button
 *
 * This helper encapsulates that pattern so each provider only needs
 * to specify its selectors.
 */
export async function clickSendButton(
  page: Page,
  sendButtonSelector: string,
  sendTimeout = 5_000,
): Promise<void> {
  const deadline = Date.now() + sendTimeout;
  let clicked = false;
  if (typeof page.evaluate === 'function') {
    while (!clicked && Date.now() < deadline) {
      clicked = await page.evaluate((selector: string) => {
        const visible = (el: Element): el is HTMLElement => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            !el.hasAttribute('disabled') &&
            el.getAttribute('aria-disabled') !== 'true'
          );
        };
        const button = Array.from(document.querySelectorAll(selector)).find(visible);
        button?.click();
        return Boolean(button);
      }, sendButtonSelector);
      if (!clicked) await page.waitForTimeout(200);
    }
    if (process.env.TEN_X_CHAT_DEBUG_SUBMIT === '1') {
      console.error(`submit-debug clicked=${clicked}`);
    }
  } else {
    const sendButton = page.locator(sendButtonSelector).first();
    clicked = await sendButton
      .waitFor({ state: 'visible', timeout: sendTimeout })
      .then(async () => {
        await sendButton.click();
        return true;
      })
      .catch(() => false);
  }

  if (!clicked) {
    // ponytail: headless ChatGPT can hide the send button; Enter still submits.
    await page.keyboard.press('Enter');
  }
}

export async function submitPromptToComposer(
  page: Page,
  prompt: string,
  opts: {
    composerSelector: string;
    sendButtonSelector: string;
    composerTimeout?: number;
    sendTimeout?: number;
    submit?: boolean;
  },
): Promise<void> {
  const {
    composerSelector,
    sendButtonSelector,
    composerTimeout = 15_000,
    sendTimeout = 5_000,
    submit = true,
  } = opts;

  // Find the first VISIBLE composer element.
  // ChatGPT has a hidden fallback textarea that locator.first() picks up,
  // so we try each sub-selector individually until we find a visible one.
  let composer = page.locator(composerSelector).first();
  const selectors = composerSelector.split(',').map((s) => s.trim());
  for (const sel of selectors) {
    const candidate = page.locator(sel).first();
    const visible = await candidate.isVisible().catch(() => false);
    if (visible) {
      composer = candidate;
      break;
    }
  }
  await composer.waitFor({ state: 'visible', timeout: composerTimeout });

  await composer.click().catch(() => {});

  const isContentEditable = await composer
    .evaluate((element) => {
      if (!(element instanceof HTMLElement)) return false;
      return element.isContentEditable || element.getAttribute('contenteditable') === 'true';
    })
    .catch(() => false);

  if (isContentEditable) {
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(prompt);
    await page.waitForTimeout(100);

    const inserted = await composer
      .evaluate((element, text) => (element.textContent ?? '').includes(text.trim()), prompt)
      .catch(() => false);
    if (!inserted) {
      await composer.evaluate((element, text) => {
        if (!(element instanceof HTMLElement)) return;
        element.focus();
        element.textContent = text;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, prompt);
    }
  } else {
    try {
      await composer.fill(prompt);
    } catch {
      await composer.evaluate((element, text) => {
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          element.value = text;
        } else if (element instanceof HTMLElement) {
          element.innerText = text;
        } else {
          return;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, prompt);
    }
  }

  await page.waitForTimeout(300);

  if (process.env.TEN_X_CHAT_DEBUG_SUBMIT === '1' && typeof page.evaluate === 'function') {
    const state = await page.evaluate(() => {
      const el = document.querySelector('#prompt-textarea, [data-testid="composer-input"]');
      return {
        text: el?.textContent ?? '',
        active: document.activeElement?.id || document.activeElement?.tagName || '',
        html: el instanceof HTMLElement ? el.innerHTML : '',
      };
    });
    console.error(`submit-debug after insert: ${JSON.stringify(state).slice(0, 500)}`);
  }

  if (submit) {
    await clickSendButton(page, sendButtonSelector, sendTimeout);
  }
}

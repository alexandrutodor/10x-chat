import { describe, expect, it, vi } from 'vitest';
import { CHATGPT_CONFIG, chatgptActions } from '../src/providers/chatgpt.js';
import { claudeActions } from '../src/providers/claude.js';
import { grokActions } from '../src/providers/grok.js';

function createModelPage(evaluateResults: unknown[]) {
  const queue = [...evaluateResults];
  const locatorState = new Map<
    string,
    {
      first: ReturnType<typeof vi.fn>;
      click: ReturnType<typeof vi.fn>;
      isVisible: ReturnType<typeof vi.fn>;
      waitFor: ReturnType<typeof vi.fn>;
      hover: ReturnType<typeof vi.fn>;
      textContent: ReturnType<typeof vi.fn>;
    }
  >();
  const locator = vi.fn((selector: string) => {
    let state = locatorState.get(selector);
    if (!state) {
      const click = vi.fn(async () => {});
      const isVisible = vi.fn(async () => false);
      const waitFor = vi.fn(async () => {});
      const hover = vi.fn(async () => {});
      const textContent = vi.fn(async () => '');
      const first = vi.fn(() => ({ click, isVisible, waitFor, hover, textContent }));
      state = { first, click, isVisible, waitFor, hover, textContent };
      locatorState.set(selector, state);
    }
    const chain = { first: state.first, filter: vi.fn(() => ({ first: state.first })) };
    return chain;
  });
  return {
    locator,
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async () => queue.shift()),
    keyboard: {
      press: vi.fn(async () => {}),
    },
    __locatorState: locatorState,
  };
}

describe('Model selection uses Playwright locator clicks to open the menu', () => {
  it('lists the current ChatGPT intelligence levels and GPT family models', () => {
    expect(CHATGPT_CONFIG.defaultModel).toBe('Pro');
    expect(CHATGPT_CONFIG.models).toContain('GPT-5.6 Sol');
    expect(CHATGPT_CONFIG.models).toContain('Pro');
  });

  it('selects a ChatGPT model through the composer model picker', async () => {
    const page = createModelPage([{ found: true, text: 'Pro' }, true, true]);

    await chatgptActions.selectModel(page as never, 'Instant');

    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(page.waitForTimeout).toHaveBeenCalledWith(750);
    expect(page.waitForTimeout).toHaveBeenCalledWith(500);
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('selects the GPT-5.6 family and High intelligence in two steps', async () => {
    const page = createModelPage([]);
    const composerSelector =
      'button.__composer-pill:has-text("Instant"), button.__composer-pill:has-text("Medium"), button.__composer-pill:has-text("High"), button.__composer-pill:has-text("Extra High"), button.__composer-pill:has-text("Pro"), button.__composer-pill:has-text("GPT-5")';
    const familyMenuSelector = '[role="menuitem"][aria-haspopup="menu"]:has-text("GPT-5")';
    const familyOptionSelector =
      '[role="menuitemradio"]:has-text("GPT-5.6 Sol"), [role="option"]:has-text("GPT-5.6 Sol"), button:has-text("GPT-5.6 Sol")';
    const levelOptionSelector =
      '[role="menuitemradio"]:has-text("High"), [role="option"]:has-text("High"), button:has-text("High")';

    const composer = page.locator(composerSelector).first();
    const familyMenu = page.locator(familyMenuSelector).first();
    const familyOption = page.locator(familyOptionSelector).first();
    const levelOption = page.locator(levelOptionSelector).first();
    page.__locatorState.get(composerSelector)?.isVisible.mockResolvedValue(true);
    page.__locatorState.get(composerSelector)?.textContent.mockResolvedValue('Pro');
    page.__locatorState.get(familyOptionSelector)?.isVisible.mockResolvedValue(true);
    page.__locatorState.get(levelOptionSelector)?.isVisible.mockResolvedValue(true);

    await chatgptActions.selectModel(page as never, 'GPT-5.6 Sol High');

    expect(composer.click).toHaveBeenCalledTimes(2);
    expect(familyMenu.hover).toHaveBeenCalledTimes(1);
    expect(familyOption.click).toHaveBeenCalledTimes(1);
    expect(levelOption.click).toHaveBeenCalledTimes(1);
  });

  it('warns and escapes when the Claude model option is missing', async () => {
    const page = createModelPage([{ found: true, text: 'Sonnet 4.6' }, false]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await claudeActions.selectModel(page as never, 'Opus 4.6');

    const modelPicker = page.__locatorState.get('button[data-testid="model-selector-dropdown"]');
    expect(page.locator).toHaveBeenCalledWith('button[data-testid="model-selector-dropdown"]');
    expect(modelPicker?.click).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(page.keyboard.press).toHaveBeenCalledWith('Escape');
    expect(warn).toHaveBeenCalledWith(
      'Model "Opus 4.6" not found in Claude picker — using current model',
    );

    warn.mockRestore();
  });

  it('selects a Grok model through the dropdown menu', async () => {
    const page = createModelPage([{ found: true, text: 'Auto' }, true]);

    await grokActions.selectModel(page as never, 'Expert');

    const modelPicker = page.__locatorState.get('button[aria-label="Model select"]');
    expect(page.locator).toHaveBeenCalledWith('button[aria-label="Model select"]');
    expect(modelPicker?.click).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(page.waitForTimeout).toHaveBeenCalledWith(750);
    expect(page.waitForTimeout).toHaveBeenCalledWith(500);
  });
});

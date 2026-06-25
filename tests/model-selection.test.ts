import { describe, expect, it, vi } from 'vitest';
import { chatgptActions } from '../src/providers/chatgpt.js';
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
    }
  >();
  const locator = vi.fn((selector: string) => {
    let state = locatorState.get(selector);
    if (!state) {
      const click = vi.fn(async () => {});
      const isVisible = vi.fn(async () => false);
      const waitFor = vi.fn(async () => {});
      const first = vi.fn(() => ({ click, isVisible, waitFor }));
      state = { first, click, isVisible, waitFor };
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
  it('selects a ChatGPT model through the composer model picker', async () => {
    const page = createModelPage([{ found: true, text: 'Pro Extended' }, true, true]);

    await chatgptActions.selectModel(page as never, 'Instant');

    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(page.waitForTimeout).toHaveBeenCalledWith(750);
    expect(page.waitForTimeout).toHaveBeenCalledWith(500);
    expect(page.keyboard.press).not.toHaveBeenCalled();
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

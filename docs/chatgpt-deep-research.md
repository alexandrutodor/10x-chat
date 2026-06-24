# ChatGPT Deep Research automation

ChatGPT Deep Research is a **composer tool**, not just a URL. The reliable UI flow is:

1. Open a normal ChatGPT composer.
2. Click the `+` button immediately before the prompt input (`Add files and more`).
3. In the popup menu, choose `Deep research`.
4. ChatGPT adds a `Deep research` pill/chip in the composer footer.
5. Submit the prompt.

To deselect Deep Research manually, click the active `Deep research` pill/chip in the composer footer (`Deep research, click to remove`). Opening a new chat without the pill also disables it.

## CLI usage

```bash
10x-chat research \
  --provider chatgpt \
  --profile chatgpt \
  --headed \
  --model "Extra High" \
  --timeout 900000 \
  --save-dir ./reports \
  -p "Research question..."
```

What the command does:

- opens the named ChatGPT browser profile;
- optionally selects the requested model/thinking level;
- clicks the composer `+` menu;
- selects `Deep research`;
- verifies the active `Deep research` composer pill is visible;
- submits the prompt and polls until completion or timeout.

Use long timeouts. Real ChatGPT Deep Research can take 5-15+ minutes; a short timeout can save an incomplete placeholder such as `Called tool`.

## Model / thinking level

In the current ChatGPT UI, the model/thinking level is the pill near the lower-right of the composer, for example `Extra High`.

Manual selection:

1. Click the model/thinking pill near the send button.
2. Choose from the `Intelligence` menu: `Instant`, `Medium`, `High`, `Extra High`, `Pro Extended`, or `GPT-5.5`.

CLI selection:

```bash
10x-chat chat --provider chatgpt --model "Medium" -p "..."
10x-chat research --provider chatgpt --model "Extra High" -p "..."
```

Aliases in code:

- `thinking` / `pro` -> `Pro Extended`
- `xhigh` / `extra high` -> `Extra High`
- `medium` -> `Medium`
- `high` -> `High`
- `instant` -> `Instant`

Deep Research and model selection are independent: choose the model/thinking level first, then select Deep Research from the `+` menu.

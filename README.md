# TestPad Pocket

A tiny Russian-language solver for OnlineTestPad. It sends the current question to Gemini 3.8 Flash on 302.ai, shows a short worked solution with the answer, and fills the answer in. It never presses «Далее» or «Завершить».

Your 302.ai key is stored in `extension/vault.json`, encrypted with your password (PBKDF2-SHA256, 600 000 rounds + AES-256-GCM). Without the password the file is useless, so the repo can stay public. No server is involved.

## One-time: seal your key

On your own computer, from the repo folder (needs Node 20+):

```
node tools/seal.mjs
```

It asks for the 302.ai key and a new password (at least 12 characters), checks the key and model on 302.ai, and writes `extension/vault.json`. Commit and push that file. Run it again any time to change the key or the password.

## On any computer

1. Download this repo (Code → Download ZIP) and unzip it somewhere it can stay.
2. Chrome: `chrome://extensions`. Yandex Browser: `browser://extensions`. Turn on developer mode, click **Load unpacked**, and pick the unzipped folder (the one with `manifest.json`).
3. Click the TestPad Pocket icon, type the password, then click **Открыть**. That's it. You can close the window. It stays unlocked across tabs and browser restarts. To unlock only until the browser closes (on a shared PC), untick «Запомнить на этом компьютере». To remove the key from that PC, use **Дополнительно → Выйти на этом компьютере**.

## Updating

Run **`update.cmd`** in the extension folder on Windows (double-click it), or **`update.command`** on Mac. It downloads the latest version over the same folder. There's no new ZIP and no need to load the extension again. Within about 30 seconds, or right away if you click the extension icon, the extension reloads itself and the open test tabs get the new panel without pressing F5. The popup tells you when a newer version is on GitHub. If it ever doesn't pick up an update, click the ⟳ reload arrow on the extension's card in `chrome://extensions`.

Tip: unpin the icon from the toolbar (puzzle-piece menu) so nothing is visible.

## Hotkeys

| | Windows / Linux | Mac |
|---|---|---|
| Solve the current question | `Ctrl+Shift+9` | `Control+Shift+9` |
| Show / hide the panel | `Ctrl+Shift+8` | `Control+Shift+8` |

Hiding removes the panel from the page completely. The answer is kept, so pressing the hotkey again brings it back. The hidden or shown state applies to every tab. Solving also works while the panel is hidden: the answer is filled in silently, and you can see the solution later. If a shortcut is taken on some PC, the page still reacts to the keys. You can also reassign them at `chrome://extensions/shortcuts`.

## Panel

The panel looks like one more ad tile («РЕКЛАМА» label, white card) and sits on top of an ad block next to the test. With no ads on screen, it goes to the bottom right. Its header has a tiny eye and a tiny «Решить» button. The eye shows or hides the answer text but keeps the card. A small dot on the closed eye means an answer is waiting. A thin grey line under the header fills up while it's solving. The answer appears in bold, with the short solution under it. Autofill handles radio buttons, checkboxes, text and number fields, and dropdowns. When a field can't be filled, the panel says so. Always check the answer before moving on, because the model can be wrong.

**Дополнительно** in the popup has two settings. Thinking depth: high (the default, more accurate) or medium (faster). The model name can be changed there if 302.ai renames the model.

## Tests

```
npm test               # vault crypto, prompt, reply parsing
python3 tests/e2e.py   # real Chromium + the extension on an OnlineTestPad page; 302.ai stubbed
```

# TestPad Pocket

A tiny Russian-language solver for OnlineTestPad. It sends the current question to Gemini 3.8 Flash on 302.ai or Polza.ai, shows a short worked solution with the answer, and fills the answer in. It never presses «Далее» or «Завершить».

Every password opens one key, and the key decides where requests go: the main 302.ai key, the main Polza.ai key (`google/gemini-3.8-flash` on `api.polza.ai`), or a named account, which is someone's own key on either provider behind their own password. Everything else works the same. The address probe below only applies to 302.ai, because Polza.ai has a single address.

302.ai has two addresses with the same key: `api.302.ai` (Microsoft Azure) and the mirror `api.302ai.cn` (Alibaba Cloud). In Russia, ISPs let small requests to `api.302.ai` through but freeze bigger ones, so a plain ping can't tell which works. When a test page opens, the extension sends each address a free, keyless probe that moves a 24 KB page down and a 96 KB body up, then uses the first one to finish. The choice lasts 10 minutes. A failed or stalled solve forgets it, and a key the mirror doesn't accept moves the solve to the other address. The popup shows the current server under **Дополнительно**, with a link to check again.

To see from a given computer which address works and whether the key is accepted on each (nothing is billed):

```
node tools/check.mjs
```

The keys are stored in `extension/vault.json`, each encrypted with its own password (PBKDF2-SHA256, 600 000 rounds + AES-256-GCM). Without the password the file is useless, so the repo can stay public. No server is involved.

## One-time: seal your keys

On your own computer, from the repo folder (needs Node 20+):

```
node tools/seal.mjs                                # main 302.ai key + its password
node tools/seal.mjs --provider polza               # main Polza.ai key + a different password
node tools/seal.mjs --provider polza --name Liza   # a named account: someone's own key + their password
node tools/seal.mjs --list                         # what's in the vault (no password needed)
node tools/seal.mjs --remove Liza                  # delete a named account
```

Each run asks for the key and a new password (at least 12 characters), checks the key and model with that provider, and saves the entry in `extension/vault.json` next to the others. It refuses a password that already opens another entry. Commit and push that file, then whoever uses that password runs `update.cmd` / `update.command` and types it into the extension.

Run it again any time to change a key or password. With `--name`, it replaces only the account with that name. Without `--name`, it replaces only that provider's main (unnamed) key. Every other entry stays as it is. The extension needs no change for a new account: it tries the typed password on every entry.

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

The panel looks like one more ad tile («РЕКЛАМА» label, white card) and sits on top of an ad block next to the test. With no ads on screen, it goes to the bottom right. Its header has a tiny eye and a tiny «?» button (solve). Answers never open by themselves: click the eye to read one, and click it again to fold it. Every new answer and every new question starts folded. The eye and «?» stay in the same spot whether the card is open or folded. While a solve is running the «?» is faded and can't be pressed. When it's done, a small green dot appears on the eye (red means an error, so open the eye to read it). If nothing comes back within 100 seconds, the «?» works again. The answer appears in bold, with the short solution under it. Autofill handles radio buttons, checkboxes, text and number fields, and dropdowns. When a field can't be filled, the panel says so. Always check the answer before moving on, because the model can be wrong.

**Дополнительно** in the popup has two settings. Thinking depth: high (the default, more accurate) or medium (faster). The model name can be changed there if the provider renames the model. The field shows which provider this computer is using, and the **Сервер** line shows its address.

## Tests

```
npm test               # vault crypto, seal tool, prompt, reply parsing
python3 tests/e2e.py   # real Chromium + the extension on an OnlineTestPad page; 302.ai and Polza.ai stubbed
```

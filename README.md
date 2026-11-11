# TestPad Pocket

A small Russian-language solver for OnlineTestPad. Load the extension on any computer and sign in to your own Render service. The 302.ai API key stays on the server.

## First setup

1. [Create the free Render service](https://dashboard.render.com/blueprint/new?repo=https://github.com/ayeepat/testpad-pocket). If you already created it, open its **Environment** settings instead.
2. Enter your 302.ai key in `API_302_KEY`. Set `SOLVER_PASSWORD` to a unique password of at least 12 characters. Save, deploy, and copy the service’s HTTPS address ending in `.onrender.com`.
3. Download and extract this repository. In Chrome open `chrome://extensions`, or in Yandex Browser open `browser://extensions`. Enable developer mode, choose **Load unpacked**, and select the extracted folder containing `manifest.json`. Keep that folder in place.
4. Open **TestPad Pocket** from the browser’s extensions menu. Enter the Render address and password, click **Подключить**, and allow access to your service. The address is remembered. The password expires from extension storage when the browser session ends. Repeat steps 3–4 on another computer.

## On a question

Click **Решить**. The panel shows the answer and a short worked solution. It sits above the page’s ad block when that block is on screen, or at the bottom right otherwise. On pages with several questions, focus a field in the one you want, or scroll it to the top of the viewport.

Press **Ctrl+Shift+8** on Windows or **Control+Shift+8** on Mac (physical Control) to hide or show the entire in-page panel. Hiding discards a pending result. A value already entered in the test remains in its field. Browser shortcuts can be reassigned on an individual PC. Open the extension settings to see the actual binding, or change it in the browser’s extension shortcuts page.

Autofill handles radio buttons, checkboxes, text and numeric fields, and single-select menus. Review the filled answer before advancing. For other controls, use the displayed solution to fill the answer manually. If a question image cannot be read, the panel reports the problem. The extension never presses Next or Finish.

## Request data

Clicking Solve sends the current question text, supported field descriptions, available question images, and the bundled sound formula to Gemini 3.8 Flash through 302.ai. The server requests high reasoning effort. Images are re-encoded on the device. The extension does not send the whole screen or test session tokens. Model answers can be wrong. A free service may need time to wake after inactivity.

## Verify the server

With Node 22 or later, run `node --test tests/server.test.mjs` from the repository root. The test exercises authentication and the upstream request format using a simulated provider. It does not use your API key.

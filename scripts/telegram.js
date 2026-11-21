const { toPlainText } = require("./messages");

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn("Telegram not configured (missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) - skipping alert:");
    console.warn(text);
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const send = (body) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, disable_web_page_preview: true, ...body }),
  });

  const res = await send({ text, parse_mode: "HTML" });
  if (res.ok) return;
  const errText = await res.text();
  console.error(`Telegram send failed: ${res.status} ${errText}`);

  // 400 = Telegram couldn't parse the HTML. Don't lose the alert: resend as plain text.
  if (res.status === 400) {
    const retry = await send({ text: toPlainText(text) });
    if (!retry.ok) console.error(`Telegram plain-text retry failed: ${retry.status} ${await retry.text()}`);
    else console.log("Telegram: sent as plain text after HTML was rejected.");
  }
}

module.exports = { sendTelegramMessage };

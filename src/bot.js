import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";

/* ================== CONFIG ================== */

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const bot = new TelegramBot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_DEPOSIT = 100;
const BOT_USERNAME = process.env.BOT_USERNAME;

/* ================== HELPERS ================== */

async function isOwner(id) {
  const { data } = await supabase
    .from("owners")
    .select("id")
    .eq("id", id)
    .single();
  return !!data;
}

async function isMod(id) {
  const { data } = await supabase
    .from("mods")
    .select("id")
    .eq("id", id)
    .single();
  return !!data;
}

async function ensureUser(id) {
  await supabase.from("users").upsert({ id }, { onConflict: "id" });
}

async function ensureMod(id) {
  await supabase.from("mods").upsert({ id }, { onConflict: "id" });
}

async function getBalance(id) {
  const { data } = await supabase
    .from("users")
    .select("balance")
    .eq("id", id)
    .single();
  return data?.balance ?? 0;
}

async function addBalance(id, amount) {
  const balance = await getBalance(id);
  await supabase
    .from("users")
    .update({ balance: balance + amount })
    .eq("id", id);
}

async function minusBalance(id, amount) {
  const balance = await getBalance(id);
  await supabase
    .from("users")
    .update({ balance: balance - amount })
    .eq("id", id);
}

/* ================== ADMIN CHECK ================== */

async function isUserAdmin(bot, chatId, userId) {
  try {
    const m = await bot.getChatMember(chatId, userId);
    return m.status === "administrator" || m.status === "creator";
  } catch {
    return false;
  }
}
async function createSingleUseInvite(bot, chatId) {
  const expireDate = Math.floor(Date.now() / 1000) + 60 * 5; // 5 minutes

  return await bot.createChatInviteLink(chatId, {
    member_limit: 1,
    expire_date: expireDate,
  });
}

/* ================== DATABASE ================== */

async function getLink(short) {
  const { data } = await supabase
    .from("links")
    .select("*")
    .eq("short", short)
    .single();
  return data;
}

async function addLink(short, entity_id, price, owner_id, short_link) {
  await supabase.from("links").insert({
    short,
    entity_id,
    price,
    owner_id,
    short_link,
  });
}

/* ================== USER COMMANDS ================== */

async function cmdStart(msg) {
  await ensureUser(msg.from.id);
  await bot.sendMessage(msg.chat.id, "🤖 Bot started. Use /access <code>");
}

async function cmdBalance(msg) {
  const bal = await getBalance(msg.from.id);
  await bot.sendMessage(msg.chat.id, `💰 Balance: ${bal} stars`);
}

async function cmdDeposit(msg, args) {
  const amount = parseInt(args[0]);
  if (!amount || amount <= 0 || amount > MAX_DEPOSIT) {
    return bot.sendMessage(
      msg.chat.id,
      `❌ Usage: /deposit <1-${MAX_DEPOSIT}>`
    );
  }

  await bot.sendInvoice(msg.chat.id,
    "Deposit Balance",
    `Deposit ${amount} stars`,
    `DEPOSIT:${amount}`,
    "",
    "XTR",
    [{ label: "Wallet Deposit", amount }],
  );
}
function extractAccessCode(input) {
  if (!input) return null;

  // Case 1: plain code
  if (!input.includes("t.me")) {
    return input;
  }

  try {
    const url = new URL(input);
    return url.searchParams.get("startapp");
  } catch {
    return null;
  }
}

async function cmdAccess(msg, args) {
  const rawCode = args[0];
  const userId = msg.from.id;
  const code = extractAccessCode(rawCode);
  if (!code) {
    return bot.sendMessage(msg.chat.id, "❌ Invalid access code");
  }

  const link = await getLink(code);
  if (!link) return bot.sendMessage(msg.chat.id, "❌ Invalid code");

  // Mods get direct access
  if (await isMod(userId)) {
    return bot.sendMessage(
      msg.chat.id,
      `🔓 Admin access\nEntity ID: ${link.entity_id}`
    );
  }

  const bal = await getBalance(userId);
  if (bal < link.price) {
    return bot.sendMessage(msg.chat.id, "❌ Insufficient balance");
  }

  await minusBalance(userId, link.price);

  if (await isMod(link.owner_id)) {
    await supabase.rpc("increment_mod_earnings", {
      uid: link.owner_id,
      amount: link.price,
    });
  }
  const invite = await createSingleUseInvite(bot, link.entity_id);

  // Send invite link
  await bot.sendMessage(
    msg.chat.id,
    `✅ Access granted!\n\n` +
      `⏳ *Valid for 5 minutes*\n` +
      `👤 *One user only*\n\n` +
      `${invite.invite_link}`,
    { parse_mode: "Markdown" }
  );
}

/* ================== MOD COMMAND ================== */

async function cmdAntiPassLink(msg, args) {
  if (!(await isMod(msg.from.id))) return;

  const entityId = parseInt(args[0]);
  const shortURL = args[1];
  const price = parseInt(args[2] || "1");

  const isAdmin = await isUserAdmin(bot, entityId, msg.from.id);
  if (!isAdmin) {
    return bot.sendMessage(
      msg.chat.id,
      "❌ You must be admin in that channel",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "➕ Add Bot to Channel",
                url: `https://t.me/${BOT_USERNAME}?startchannel=true`,
              },
            ],
          ],
        },
      }
    );
  }

  const short = Math.random().toString(36).slice(2, 8);

  await addLink(short, entityId, price, msg.from.id, shortURL);
  const bot_link = `https://t.me/${BOT_USERNAME}/app?startapp=${short}`;

  await bot.sendMessage(msg.chat.id, `✅ Link created\nLink: ${bot_link}`);
}

/* ================== OWNER ================== */

async function cmdAddMod(msg, args) {
  const checkOwner = await isOwner(msg.from.id);
  if (!checkOwner) return;
  await ensureMod(parseInt(args[0]));
  await bot.sendMessage(msg.chat.id, "✅ Moderator added");
}

/* ================== PAYMENTS ================== */

async function handlePayment(msg) {
  const payload = msg.successful_payment.invoice_payload;
  if (!payload.startsWith("DEPOSIT:")) return;

  const amount = parseInt(payload.split(":")[1]);
  ensureUser(msg.from.id);
  await addBalance(msg.from.id, amount);

  await bot.sendMessage(
    msg.chat.id,
    `✅ Deposit successful\n💰 Balance updated`
  );
}

/* ================== ROUTER ================== */

async function route(msg) {
  const [cmd, ...args] = msg.text.split(" ");

  switch (cmd) {
    case "/start":
      return cmdStart(msg);
    case "/balance":
      return cmdBalance(msg);
    case "/deposit":
      return cmdDeposit(msg, args);
    case "/access":
      return cmdAccess(msg, args);
    case "/ab":
      return cmdAntiPassLink(msg, args);
    case "/addmod":
      return cmdAddMod(msg, args);
  }
}

/* ================== WEBHOOK ================== */

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).end();

  const u = req.body;

  try {
    if (u.message?.text) await route(u.message);
    if (u.pre_checkout_query)
      await bot.answerPreCheckoutQuery(u.pre_checkout_query.id, true);
    if (u.message?.successful_payment) await handlePayment(u.message);
  } catch (e) {
    console.error(e);
  }

  res.status(200).end();
}

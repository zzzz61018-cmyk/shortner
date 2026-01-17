import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import fetch from "node-fetch";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BOT_TOKEN = process.env.BOT_TOKEN;

/* ================= HELPERS ================= */

function hashIP(ip) {
  return crypto.createHash("sha256").update(ip).digest("hex");
}

async function createOneTimeInvite(entityId) {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: entityId,
        expire_date: Math.floor(Date.now() / 1000) + 300, // 5 min
        member_limit: 1
      })
    }
  );

  const json = await res.json();
  if (!json.ok) throw new Error("Invite creation failed");

  return json.result.invite_link;
}

/* ================= HANDLER ================= */

export default async function handler(req, res) {
  const {entity_id } = req.query;
  if (!entity_id) {
    return res.status(403).send("Access denied");
  }

  // Get IP (Vercel-safe)
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress ||
    "";
  console.log(ip);

  const ipHash = hashIP(ip);

  const { data } = await supabase
    .from("temp_access")
    .select("*")
    .eq("ip_hash", ipHash)
    .single();

  if (!data) {
    return res.status(403).send("Invalid entry");
  }

  // Verify IP
  if (data.ip_hash !== ipHash) {
    return res.status(403).send("Invalid entry");
  }
  const {data: my_link}= await supabase
  .from("links")
  .select("*")
  .eq("short", data.startapp)
  .single();
  console.log("data", data,"link", my_link);

  // Verify entity
  if (String(my_link.entity_id) !== String(entity_id)) {
    return res.status(403).send("Invalid entry");
  }

  // Prevent reuse
  if (data.verified) {
    return res.status(403).send("Invalid entry");
  }

  // Create invite
  let inviteLink;
  try {
    inviteLink = await createOneTimeInvite(entity_id);
  } catch {
    return res.status(500).send("Unable to respond");
  }

  // Mark verified (do NOT delete, for audit)
  await supabase
    .from("temp_access")
    .update({ verified: true })
    .eq("id", data.id);

  res.send(`
    <html>
      <body style="font-family:sans-serif">
        <h3>Access Granted ✅</h3>
        <p>This link expires in 5 minutes and works once.</p>
        <a href="${inviteLink}" target="_blank">Join Telegram</a>
      </body>
    </html>
  `);
}

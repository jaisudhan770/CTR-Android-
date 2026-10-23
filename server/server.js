// CTR server: Razorpay orders, signature check, subscription status.
// Run: RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=... node server.js   (Node 18+)
const http = require("http"), crypto = require("crypto"), fs = require("fs");
const KEY = process.env.RAZORPAY_KEY_ID, SECRET = process.env.RAZORPAY_KEY_SECRET;
const AI_KEY = process.env.ANTHROPIC_API_KEY, MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", aiCount = {};
const PORT = process.env.PORT || 3000, FILE = process.env.DB_FILE || "subs.json";
if (!KEY || !SECRET) { console.error("Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET"); process.exit(1); }
const AUTH = "Basic " + Buffer.from(KEY + ":" + SECRET).toString("base64");
const PLANS = { m: { amount: 9900, days: 28 }, y: { amount: 99900, days: 365 } }; // paise
let db = { subs: {}, used: {} };
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {}
const save = () => fs.writeFileSync(FILE, JSON.stringify(db));
const send = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
  res.end(JSON.stringify(obj));
};
const readBody = req => new Promise(r => {
  let d = ""; req.on("data", c => { d += c; if (d.length > 8e6) req.destroy(); });
  req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch (e) { r({}); } });
});
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    if (req.method === "POST" && u.pathname === "/order") {
      const b = await readBody(req), p = PLANS[b.plan];
      if (!p || !b.acct) return send(res, 400, { error: "bad request" });
      const r = await fetch("https://api.razorpay.com/v1/orders", { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: AUTH },
        body: JSON.stringify({ amount: p.amount, currency: "INR", receipt: "o_" + Date.now(), notes: { acct: b.acct, plan: b.plan } }) });
      const o = await r.json();
      if (!o.id) return send(res, 502, { error: "order failed" });
      return send(res, 200, { orderId: o.id, keyId: KEY, amount: p.amount });
    }
    if (req.method === "POST" && u.pathname === "/verify") {
      const b = await readBody(req), p = PLANS[b.plan];
      if (!p || !b.acct || !b.razorpay_order_id || !b.razorpay_payment_id || !b.razorpay_signature) return send(res, 400, { ok: false });
      const sig = crypto.createHmac("sha256", SECRET).update(b.razorpay_order_id + "|" + b.razorpay_payment_id).digest("hex");
      const x = Buffer.from(sig), y = Buffer.from(String(b.razorpay_signature));
      if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return send(res, 400, { ok: false });
      const o = await (await fetch("https://api.razorpay.com/v1/orders/" + encodeURIComponent(b.razorpay_order_id), { headers: { Authorization: AUTH } })).json();
      if (o.amount !== p.amount || !o.notes || o.notes.acct !== b.acct || o.notes.plan !== b.plan) return send(res, 400, { ok: false });
      if (db.used[b.razorpay_payment_id]) return send(res, 409, { ok: false });
      db.used[b.razorpay_payment_id] = 1;
      const cur = db.subs[b.acct], exp = Math.max(Date.now(), cur ? cur.exp : 0) + p.days * 864e5;
      db.subs[b.acct] = { plan: b.plan, exp }; save();
      return send(res, 200, { ok: true, plan: b.plan, exp });
    }
    if (req.method === "POST" && u.pathname === "/ai") {
      if (!AI_KEY) return send(res, 503, { error: "AI not configured" });
      const b = await readBody(req), s = db.subs[b.acct];
      if (!s || s.exp <= Date.now()) return send(res, 402, { error: "no active plan" });
      const k = b.acct + new Date().toISOString().slice(0, 10);
      aiCount[k] = (aiCount[k] || 0) + 1;
      if (aiCount[k] > 150) return send(res, 429, { error: "daily limit reached" });
      const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-12).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 6000) }));
      if (!msgs.length || msgs[msgs.length - 1].role !== "user") return send(res, 400, { error: "bad request" });
      const imgs = Array.isArray(b.images) ? b.images.slice(0, 4) : [];
      if (imgs.length) { const l = msgs[msgs.length - 1]; l.content = imgs.map(d => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: String(d) } })).concat([{ type: "text", text: l.content }]); }
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "x-api-key": AI_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 900, messages: msgs }) });
      const j = await r.json(), text = j.content && j.content.filter(c => c.type === "text").map(c => c.text).join("");
      if (!text) return send(res, 502, { error: "ai failed" });
      return send(res, 200, { text });
    }
    if (req.method === "GET" && u.pathname === "/status") {
      const s = db.subs[u.searchParams.get("acct")];
      return send(res, 200, s && s.exp > Date.now() ? { active: true, plan: s.plan, exp: s.exp } : { active: false });
    }
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 500, { error: "server error" }); }
}).listen(PORT, () => console.log("CTR server listening on " + PORT));

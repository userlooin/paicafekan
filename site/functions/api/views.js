// Pages Function: ตัวนับยอดวิวบทความ (Cloudflare KV)
//
// GET  /api/views                 -> { ok, counts: { slug: n } }
// GET  /api/views?slug=<slug>     -> { ok, slug, views }
// POST /api/views { slug }        -> +1 แล้วคืน { ok, slug, views }
//
// ต้องผูก KV namespace ชื่อ binding = VIEWS (ถ้ายังไม่ผูก จะคืน disabled: true)
// ฟรี: KV 1,000 เขียน/วัน — มีเพดานกันเขียนเกินต่อวันอัตโนมัติ

const KEY = "views:index";
const DAILY_WRITE_CAP = 900;
const SLUG_RE = /^[a-z0-9-]{1,70}$/;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

function emptyIndex() {
  return { counts: {}, day: "", dayWrites: 0 };
}

async function readIndex(env) {
  try {
    const raw = await env.VIEWS.get(KEY);
    if (!raw) return emptyIndex();
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return emptyIndex();
    return {
      counts: data.counts && typeof data.counts === "object" ? data.counts : {},
      day: String(data.day || ""),
      dayWrites: Number(data.dayWrites || 0)
    };
  } catch {
    return emptyIndex();
  }
}

async function writeIndex(env, idx) {
  try {
    await env.VIEWS.put(KEY, JSON.stringify(idx));
    return true;
  } catch {
    return false;
  }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env || !env.VIEWS) return json({ ok: false, disabled: true, counts: {}, views: 0 });

  const url = new URL(request.url);
  const slug = String(url.searchParams.get("slug") || "").trim().toLowerCase();
  const idx = await readIndex(env);

  if (!slug) return json({ ok: true, counts: idx.counts });
  if (!SLUG_RE.test(slug)) return json({ ok: false, error: "bad slug" }, 400);
  return json({ ok: true, slug, views: idx.counts[slug] || 0 });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env || !env.VIEWS) return json({ ok: false, disabled: true, views: 0 });

  let body = {};
  try { body = await request.json(); } catch {}
  const slug = String((body && body.slug) || "").trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return json({ ok: false, error: "bad slug" }, 400);

  // กันบอต/พรีวิวไม่ให้รันยอด
  const ua = request.headers.get("user-agent") || "";
  if (/bot|crawl|spider|preview|monitor|curl|wget|lighthouse/i.test(ua)) {
    return json({ ok: true, skipped: true, views: 0 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const idx = await readIndex(env);
  if (idx.day !== today) { idx.day = today; idx.dayWrites = 0; }

  const prev = idx.counts[slug] || 0;
  if (idx.dayWrites >= DAILY_WRITE_CAP) {
    return json({ ok: true, capped: true, slug, views: prev });
  }

  idx.counts[slug] = prev + 1;
  idx.dayWrites += 1;
  await writeIndex(env, idx);
  return json({ ok: true, slug, views: idx.counts[slug] });
}

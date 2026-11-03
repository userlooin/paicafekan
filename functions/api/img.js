// Pages Function: image proxy
//
// ทำไมต้องมี: LINE (Messaging API) ต้องได้ URL รูปโดยตรงที่ตอบ 200 + content-type image/*
// แต่ลิงก์ที่ผู้ใช้ใส่ในชีตอาจเป็น Google Drive / Google Maps / หน้าเว็บร้าน
// -> ให้ LINE เรียกผ่าน URL นี้แทน แล้วเราค่อย fetch ไปเอาภาพจริงให้
//
// ใช้: /api/img?u=<encodeURIComponent(url)>

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 12000;

function bad(status, msg) {
  return new Response(msg, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export async function onRequestGet(context) {
  const { request } = context;
  const raw = new URL(request.url).searchParams.get('u') || '';
  if (!raw) return bad(400, 'missing u');

  let target;
  try {
    target = new URL(raw);
  } catch {
    return bad(400, 'bad url');
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return bad(400, 'bad protocol');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[::1\])/i.test(target.hostname)) return bad(400, 'blocked host');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; paicafekan/1.0; +https://paicafekan.com)',
        'Accept': 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5'
      }
    });
  } catch {
    clearTimeout(timer);
    return bad(502, 'fetch failed');
  }
  clearTimeout(timer);

  if (!upstream.ok) return bad(502, 'upstream ' + upstream.status);

  const type = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) return bad(415, 'not an image: ' + (type || 'unknown'));

  const len = Number(upstream.headers.get('content-length') || 0);
  if (len && len > MAX_BYTES) return bad(413, 'too large');

  const buf = await upstream.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) return bad(413, 'too large');

  return new Response(buf, {
    status: 200,
    headers: {
      'content-type': type,
      'content-length': String(buf.byteLength),
      'cache-control': 'public, max-age=86400',
      'x-robots-tag': 'noindex'
    }
  });
}

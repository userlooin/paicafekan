// Pages Function: proxy LINE webhook -> Google Apps Script
//
// ทำไมต้องมีตัวกลาง: Apps Script ตอบ 302 (redirect ไป script.googleusercontent.com)
// แต่ LINE ต้องการ 200 ภายใน 1 วินาที ไม่งั้นถือว่า webhook ล้มเหลว
// ตัวนี้จึงรับ event แล้วตอบ 200 ทันที พร้อมส่งต่อไป Apps Script แบบเบื้องหลัง

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbxr2r1JsXgOtUmBsy-fHI7aG2e1uJ0vyRo7aXkMAxwUd7Ve_K2lfS6Gcdo-0G7WNKocwA/exec';

export async function onRequestPost(context) {
  const { request } = context;
  const t = new URL(request.url).searchParams.get('t') || '';
  const body = await request.text();

  const forward = fetch(APPS_SCRIPT_URL + '?t=' + encodeURIComponent(t), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Line-Signature': request.headers.get('x-line-signature') || ''
    },
    body: body
  }).catch(() => null);

  if (context.waitUntil) {
    context.waitUntil(forward);
  } else {
    await forward;
  }

  return new Response('OK', {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  });
}

export async function onRequestGet() {
  return new Response('line hook ok', { status: 200 });
}

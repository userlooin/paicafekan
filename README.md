# ไปคาเฟ่กัน — paicafekan.com

เว็บรีวิวคาเฟ่กรุงเทพฯ (static site) โฮสต์บน Cloudflare Pages

## โครงสร้าง

```
index.html            หน้าแรก (สร้างอัตโนมัติจาก data/posts.json)
about/index.html      เกี่ยวกับเรา
404.html              หน้าไม่พบ
assets/style.css      ธีมพาสเทลฟ้า
assets/img/posts/     รูปหน้าร้าน (ระบบ commit ให้อัตโนมัติ)
data/posts.json       รายการโพสต์ทั้งหมด (manifest)
posts/<slug>/         หน้าบทความแต่ละร้าน
sitemap.xml, feed.xml
```

## การทำงาน

ระบบเขียนบทความด้วย Gemini จากข้อมูลร้านจริง (Google Places)
ส่งให้อนุมัติผ่าน LINE ตอนเช้า 06:50 แล้ว commit ไฟล์เข้า repo นี้
Cloudflare Pages จะ deploy เองภายใน ~1 นาที

> ไฟล์ `index.html`, `posts/`, `data/posts.json`, `sitemap.xml`, `feed.xml`
> ถูกเขียนทับโดยอัตโนมัติ — ไม่ต้องแก้ด้วยมือ (ยกเว้น `about/`, `assets/style.css`)

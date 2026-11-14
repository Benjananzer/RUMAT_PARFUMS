const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const scrypt = require('util').promisify(crypto.scrypt);

const MAX = 4.4 * 1024 * 1024; // límite de Vercel para el cuerpo: 4,5 MB
const TIPOS = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'];
const META = 159000; // $ acumulados (en compras pagadas) para ganar un descuento
const DESC = 10;     // % de descuento que se gana
let sql, ready;

function db() { if (!sql) sql = neon(process.env.DATABASE_URL); return sql; }
function init() {
  if (!ready) ready = (async () => {
    const q = db();
    await q`CREATE TABLE IF NOT EXISTS ajustes (clave text PRIMARY KEY, valor jsonb NOT NULL)`;
    await q`CREATE TABLE IF NOT EXISTS media (id text PRIMARY KEY, tipo text NOT NULL, datos text NOT NULL, creado timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE TABLE IF NOT EXISTS usuarios (id text PRIMARY KEY, email text UNIQUE NOT NULL, nombre text NOT NULL, clave text NOT NULL, gasto bigint NOT NULL DEFAULT 0, usados int NOT NULL DEFAULT 0, creado timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE TABLE IF NOT EXISTS resets (id serial PRIMARY KEY, usuario_id text NOT NULL, token_hash text NOT NULL, expira timestamptz NOT NULL, creado timestamptz NOT NULL DEFAULT now())`;
    await q`CREATE TABLE IF NOT EXISTS pedidos (id serial PRIMARY KEY, usuario_id text, nombre text NOT NULL, telefono text NOT NULL, entrega text NOT NULL, direccion jsonb, items jsonb NOT NULL, subtotal bigint NOT NULL, descuento bigint NOT NULL DEFAULT 0, total bigint NOT NULL, metodo text NOT NULL, cupon boolean NOT NULL DEFAULT false, estado text NOT NULL DEFAULT 'pendiente', creado timestamptz NOT NULL DEFAULT now())`;
  })().catch(e => { ready = null; throw e; });
  return ready;
}

// ---- sesiones y contraseñas
const secret = () => process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || '';
const sign = s => crypto.createHmac('sha256', secret()).update(s).digest('base64url');
function makeToken(u, a, horas) {
  const p = Buffer.from(JSON.stringify({ u, a, exp: Date.now() + horas * 36e5 })).toString('base64url');
  return p + '.' + sign(p);
}
function auth(req) {
  const [p, s] = (req.headers.authorization || '').replace(/^Bearer /, '').split('.');
  if (!p || !s || !secret()) return null;
  const e = sign(p);
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  try { const d = JSON.parse(Buffer.from(p, 'base64url')); return d.exp > Date.now() ? d : null; } catch { return null; }
}
const hash = s => crypto.createHash('sha256').update(s).digest();
const same = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + (await scrypt(pw, salt, 64)).toString('hex');
}
async function checkPw(pw, stored) {
  const [s, h] = String(stored).split(':');
  const x = await scrypt(pw, Buffer.from(s, 'hex'), 64);
  return crypto.timingSafeEqual(x, Buffer.from(h, 'hex'));
}
const adminEmail = () => (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sitio = () => (process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '')).replace(/\/$/, '');
const correoListo = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD && sitio());
async function mandar(to, asunto, texto, html) {
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  await t.sendMail({ from: `"Rumat Parfums" <${process.env.GMAIL_USER}>`, to, subject: asunto, text: texto, html });
}
const wait = () => new Promise(r => setTimeout(r, 600));

// ---- utilidades
async function body(req, max) {
  const ch = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > max) { const e = new Error('big'); e.status = 413; throw e; }
    ch.push(c);
  }
  return Buffer.concat(ch);
}
async function jbody(req, max = 60000) { try { return JSON.parse((await body(req, max)).toString() || '{}'); } catch (e) { if (e.status) throw e; return {}; } }
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
const txt = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const precio = p => (p.dto > 0 ? Math.round(p.precio * (1 - p.dto / 100)) : p.precio);

async function puntos(q, u) {
  const gasto = Number(u.gasto);
  const pend = await q`SELECT count(*)::int AS n FROM pedidos WHERE usuario_id = ${u.id} AND estado = 'pendiente' AND cupon = true`;
  return {
    gasto, meta: META, desc: DESC,
    falta: META - (gasto % META),
    disponibles: Math.max(0, Math.floor(gasto / META) - u.usados - pend[0].n)
  };
}

module.exports = async (req, res) => {
  try {
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
    const m = req.method;
    const me = auth(req);

    // ----- cuentas
    if (path === 'registro' && m === 'POST') {
      const b = await jbody(req);
      const email = txt(b.email, 120).toLowerCase(), nombre = txt(b.nombre, 80), pw = String(b.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return send(res, 400, { error: 'Revisá el correo.' });
      if (!nombre) return send(res, 400, { error: 'Escribí tu nombre.' });
      if (pw.length < 8 || pw.length > 100) return send(res, 400, { error: 'La contraseña debe tener al menos 8 caracteres.' });
      if (b.acepta !== true) return send(res, 400, { error: 'Tenés que aceptar la política de privacidad.' });
      if (email === adminEmail()) return send(res, 400, { error: 'Ese correo no está disponible.' });
      await init(); const q = db();
      if ((await q`SELECT 1 FROM usuarios WHERE email = ${email}`).length) return send(res, 409, { error: 'Ya existe una cuenta con ese correo.' });
      const id = crypto.randomBytes(9).toString('hex');
      await q`INSERT INTO usuarios (id, email, nombre, clave) VALUES (${id}, ${email}, ${nombre}, ${await hashPw(pw)})`;
      return send(res, 200, { token: makeToken(id, false, 24 * 14) });
    }

    if (path === 'login' && m === 'POST') {
      const b = await jbody(req);
      const email = txt(b.email, 120).toLowerCase(), pw = String(b.password || '');
      if (adminEmail() && process.env.ADMIN_PASSWORD && email === adminEmail()) {
        if (same(pw, process.env.ADMIN_PASSWORD)) return send(res, 200, { token: makeToken(null, true, 12) });
      } else if (email) {
        await init(); const q = db();
        const r = await q`SELECT id, clave FROM usuarios WHERE email = ${email}`;
        if (r[0] && await checkPw(pw, r[0].clave)) return send(res, 200, { token: makeToken(r[0].id, false, 24 * 14) });
      }
      await wait();
      return send(res, 401, { error: 'Correo o contraseña incorrectos.' });
    }

    if (path === 'olvide' && m === 'POST') {
      const email = txt((await jbody(req)).email, 120).toLowerCase();
      if (!correoListo()) return send(res, 503, { error: 'El envío de correos todavía no está configurado.' });
      await init(); const q = db();
      const u = email ? (await q`SELECT id, nombre FROM usuarios WHERE email = ${email}`)[0] : null;
      if (u && !(await q`SELECT 1 FROM resets WHERE usuario_id = ${u.id} AND creado > now() - interval '60 seconds'`).length) {
        const token = crypto.randomBytes(32).toString('hex');
        await q`DELETE FROM resets WHERE usuario_id = ${u.id}`;
        await q`INSERT INTO resets (usuario_id, token_hash, expira) VALUES (${u.id}, ${sha256(token)}, now() + interval '1 hour')`;
        const link = sitio() + '/?reset=' + token;
        const texto = `Hola ${u.nombre}:\n\nPediste restablecer la contraseña de tu cuenta en Rumat Parfums. Entrá a este enlace para elegir una nueva (vale por 1 hora y se puede usar una sola vez):\n\n${link}\n\nSi no fuiste vos, ignorá este mensaje: tu contraseña no cambia.`;
        const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#222"><h2 style="color:#8a6a2b">Rumat Parfums</h2><p>Hola ${esc(u.nombre)}:</p><p>Pediste restablecer la contraseña de tu cuenta. El enlace vale por 1 hora y se puede usar una sola vez.</p><p><a href="${link}" style="display:inline-block;background:#c9a24a;color:#1a1208;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Elegir una contraseña nueva</a></p><p style="font-size:13px;color:#666">Si no fuiste vos, ignorá este mensaje: tu contraseña no cambia.</p></div>`;
        try { await mandar(email, 'Restablecer tu contraseña · Rumat Parfums', texto, html); } catch (e) { console.error('mail', e.message); }
      }
      return send(res, 200, { ok: true }); // misma respuesta exista o no la cuenta
    }

    if (path === 'restablecer' && m === 'POST') {
      const b = await jbody(req);
      const pw = String(b.password || ''), tk = String(b.token || '');
      if (pw.length < 8 || pw.length > 100) return send(res, 400, { error: 'La contraseña debe tener al menos 8 caracteres.' });
      await init(); const q = db();
      const r = await q`SELECT usuario_id FROM resets WHERE token_hash = ${sha256(tk)} AND expira > now()`;
      if (!r[0]) { await wait(); return send(res, 400, { error: 'El enlace venció o ya se usó. Pedí uno nuevo.' }); }
      await q`UPDATE usuarios SET clave = ${await hashPw(pw)} WHERE id = ${r[0].usuario_id}`;
      await q`DELETE FROM resets WHERE usuario_id = ${r[0].usuario_id}`;
      return send(res, 200, { token: makeToken(r[0].usuario_id, false, 24 * 14) });
    }

    if (path === 'yo' && m === 'GET') {
      if (!me) return send(res, 401, { error: 'No autorizado' });
      if (me.a) return send(res, 200, { adm: true, nombre: 'Administrador', email: adminEmail() });
      await init(); const q = db();
      const r = await q`SELECT id, email, nombre, gasto, usados FROM usuarios WHERE id = ${me.u}`;
      if (!r[0]) return send(res, 401, { error: 'No autorizado' });
      return send(res, 200, { adm: false, nombre: r[0].nombre, email: r[0].email, ...(await puntos(q, r[0])) });
    }

    await init();
    const q = db();

    // ----- catálogo
    if (path === 'store' && m === 'GET') {
      const r = await q`SELECT valor FROM ajustes WHERE clave = 'tienda'`;
      return send(res, 200, r[0] ? r[0].valor : { items: [], portada: '', videos: [] });
    }
    if (path === 'store' && m === 'PUT') {
      if (!me || !me.a) return send(res, 401, { error: 'No autorizado' });
      const b = await jbody(req, 2e6);
      const val = {
        items: Array.isArray(b.items) ? b.items : [],
        portada: String(b.portada || ''),
        videos: Array.isArray(b.videos) ? b.videos.map(String) : []
      };
      await q`INSERT INTO ajustes (clave, valor) VALUES ('tienda', ${JSON.stringify(val)}::jsonb)
              ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`;
      const usados = new Set((JSON.stringify(val).match(/\/api\/media\/[a-f0-9]+/g) || []).map(s => s.split('/').pop()));
      const viejos = await q`SELECT id FROM media WHERE creado < now() - interval '1 hour'`;
      for (const { id } of viejos) if (!usados.has(id)) await q`DELETE FROM media WHERE id = ${id}`;
      return send(res, 200, { ok: true });
    }

    // ----- pedidos
    if (path === 'pedidos' && m === 'POST') {
      const b = await jbody(req);
      const nombre = txt(b.nombre, 80), telefono = txt(b.telefono, 30);
      const entrega = b.entrega === 'envio' ? 'envio' : b.entrega === 'retiro' ? 'retiro' : '';
      const metodo = ['transferencia', 'efectivo'].includes(b.metodo) ? b.metodo : '';
      if (!nombre) return send(res, 400, { error: 'Escribí tu nombre.' });
      if (telefono.replace(/\D/g, '').length < 8) return send(res, 400, { error: 'Escribí un teléfono válido.' });
      if (!entrega || !metodo) return send(res, 400, { error: 'Elegí la entrega y la forma de pago.' });
      let direccion = null;
      if (entrega === 'envio') {
        const d = b.direccion || {};
        direccion = { calle: txt(d.calle, 120), localidad: txt(d.localidad, 80), cp: txt(d.cp, 12), provincia: txt(d.provincia, 60), nota: txt(d.nota, 200) };
        if (!direccion.calle || !direccion.localidad || !direccion.cp) return send(res, 400, { error: 'Completá la dirección de envío.' });
      }
      const pedidos = Array.isArray(b.items) ? b.items.slice(0, 50) : [];
      if (!pedidos.length) return send(res, 400, { error: 'El carrito está vacío.' });
      const tienda = (await q`SELECT valor FROM ajustes WHERE clave = 'tienda'`)[0];
      const catalogo = (tienda && tienda.valor.items) || [];
      const lineas = [];
      for (const it of pedidos) {
        const p = catalogo.find(x => x.id === it.id), qty = Math.floor(Number(it.qty));
        if (!p || !(qty >= 1 && qty <= 99)) return send(res, 400, { error: 'Algún perfume ya no está disponible. Actualizá la página.' });
        if (p.stock != null && qty > Number(p.stock)) return send(res, 409, { error: 'No hay stock suficiente de ' + p.nombre + '.' });
        lineas.push({ id: p.id, nombre: p.nombre, qty, unit: precio(p), sub: precio(p) * qty });
      }
      const subtotal = lineas.reduce((a, l) => a + l.sub, 0);
      let descuento = 0, cupon = false, uid = null;
      if (me && !me.a && me.u) {
        const u = (await q`SELECT id, gasto, usados FROM usuarios WHERE id = ${me.u}`)[0];
        if (u) {
          uid = u.id;
          if (b.cupon === true && (await puntos(q, u)).disponibles > 0) { cupon = true; descuento = Math.round(subtotal * DESC / 100); }
        }
      }
      const total = subtotal - descuento;
      const r = await q`INSERT INTO pedidos (usuario_id, nombre, telefono, entrega, direccion, items, subtotal, descuento, total, metodo, cupon)
        VALUES (${uid}, ${nombre}, ${telefono}, ${entrega}, ${direccion ? JSON.stringify(direccion) : null}::jsonb, ${JSON.stringify(lineas)}::jsonb, ${subtotal}, ${descuento}, ${total}, ${metodo}, ${cupon})
        RETURNING id`;
      return send(res, 200, { id: r[0].id, subtotal, descuento, total, lineas });
    }
    if (path === 'pedidos' && m === 'GET') {
      if (!me || !me.a) return send(res, 401, { error: 'No autorizado' });
      const r = await q`SELECT p.*, u.nombre AS u_nombre, u.email AS u_email, u.gasto AS u_gasto
        FROM pedidos p LEFT JOIN usuarios u ON u.id = p.usuario_id ORDER BY p.id DESC LIMIT 150`;
      return send(res, 200, { pedidos: r.map(p => ({ ...p, subtotal: Number(p.subtotal), descuento: Number(p.descuento), total: Number(p.total), u_gasto: Number(p.u_gasto || 0) })) });
    }
    const pe = /^pedidos\/(\d+)\/estado$/.exec(path);
    if (pe && m === 'POST') {
      if (!me || !me.a) return send(res, 401, { error: 'No autorizado' });
      const est = (await jbody(req)).estado;
      if (!['pagado', 'cancelado'].includes(est)) return send(res, 400, { error: 'Estado inválido' });
      const r = await q`UPDATE pedidos SET estado = ${est} WHERE id = ${Number(pe[1])} AND estado = 'pendiente' RETURNING usuario_id, total, cupon`;
      if (!r[0]) return send(res, 409, { error: 'Ese pedido ya estaba cerrado.' });
      if (est === 'pagado' && r[0].usuario_id)
        await q`UPDATE usuarios SET gasto = gasto + ${Number(r[0].total)}, usados = usados + ${r[0].cupon ? 1 : 0} WHERE id = ${r[0].usuario_id}`;
      return send(res, 200, { ok: true });
    }

    // ----- fotos y videos
    if (path === 'media' && m === 'POST') {
      if (!me || !me.a) return send(res, 401, { error: 'No autorizado' });
      const tipo = (req.headers['content-type'] || '').split(';')[0].trim();
      if (!TIPOS.includes(tipo)) return send(res, 415, { error: 'Tipo de archivo no permitido' });
      const buf = await body(req, MAX);
      if (!buf.length) return send(res, 400, { error: 'Archivo vacío' });
      const id = crypto.randomBytes(9).toString('hex');
      await q`INSERT INTO media (id, tipo, datos) VALUES (${id}, ${tipo}, ${buf.toString('base64')})`;
      return send(res, 200, { url: '/api/media/' + id });
    }
    const mm = /^media\/([a-f0-9]+)$/.exec(path);
    if (mm && (m === 'GET' || m === 'HEAD')) {
      const r = await q`SELECT tipo, datos FROM media WHERE id = ${mm[1]}`;
      if (!r[0]) return send(res, 404, { error: 'No existe' });
      const buf = Buffer.from(r[0].datos, 'base64');
      res.setHeader('Content-Type', r[0].tipo);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (rg && (rg[1] || rg[2])) {
        const a = rg[1] === '' ? Math.max(0, buf.length - Number(rg[2])) : Number(rg[1]);
        const b = rg[1] === '' || rg[2] === '' ? buf.length - 1 : Math.min(Number(rg[2]), buf.length - 1);
        if (a > b || a >= buf.length) { res.statusCode = 416; res.setHeader('Content-Range', 'bytes */' + buf.length); return res.end(); }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${a}-${b}/${buf.length}`);
        res.setHeader('Content-Length', b - a + 1);
        return res.end(m === 'HEAD' ? undefined : buf.subarray(a, b + 1));
      }
      res.setHeader('Content-Length', buf.length);
      return res.end(m === 'HEAD' ? undefined : buf);
    }

    return send(res, 404, { error: 'No encontrado' });
  } catch (e) {
    console.error(e);
    send(res, e.status || 500, { error: e.status === 413 ? 'Archivo demasiado grande' : 'Error del servidor' });
  }
};

const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

const MAX = 4.4 * 1024 * 1024; // límite de Vercel para el cuerpo: 4,5 MB
const TIPOS = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'];
let sql, ready;

function db() { if (!sql) sql = neon(process.env.DATABASE_URL); return sql; }
function init() {
  if (!ready) ready = (async () => {
    const q = db();
    await q`CREATE TABLE IF NOT EXISTS ajustes (clave text PRIMARY KEY, valor jsonb NOT NULL)`;
    await q`CREATE TABLE IF NOT EXISTS media (id text PRIMARY KEY, tipo text NOT NULL, datos text NOT NULL, creado timestamptz NOT NULL DEFAULT now())`;
  })().catch(e => { ready = null; throw e; });
  return ready;
}

const secret = () => process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || '';
const sign = s => crypto.createHmac('sha256', secret()).update(s).digest('base64url');
function makeToken() {
  const p = Buffer.from(JSON.stringify({ exp: Date.now() + 7 * 864e5 })).toString('base64url');
  return p + '.' + sign(p);
}
function okToken(req) {
  const [p, s] = (req.headers.authorization || '').replace(/^Bearer /, '').split('.');
  if (!p || !s || !secret()) return false;
  const e = sign(p);
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url')).exp > Date.now(); } catch { return false; }
}
const hash = s => crypto.createHash('sha256').update(s).digest();
const same = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));

async function body(req, max) {
  const ch = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > max) { const e = new Error('big'); e.status = 413; throw e; }
    ch.push(c);
  }
  return Buffer.concat(ch);
}
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  try {
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
    const m = req.method;

    if (path === 'login' && m === 'POST') {
      if (!process.env.ADMIN_PASSWORD) return send(res, 500, { error: 'Falta configurar ADMIN_PASSWORD en Vercel.' });
      let pw = '';
      try { pw = String(JSON.parse((await body(req, 10000)).toString() || '{}').password || ''); } catch {}
      if (!same(pw, process.env.ADMIN_PASSWORD)) {
        await new Promise(r => setTimeout(r, 600));
        return send(res, 401, { error: 'Contraseña incorrecta.' });
      }
      return send(res, 200, { token: makeToken() });
    }

    await init();
    const q = db();

    if (path === 'store' && m === 'GET') {
      const r = await q`SELECT valor FROM ajustes WHERE clave = 'tienda'`;
      return send(res, 200, r[0] ? r[0].valor : { items: [], portada: '', videos: [] });
    }

    if (path === 'store' && m === 'PUT') {
      if (!okToken(req)) return send(res, 401, { error: 'No autorizado' });
      const b = JSON.parse((await body(req, 2e6)).toString());
      const val = {
        items: Array.isArray(b.items) ? b.items : [],
        portada: String(b.portada || ''),
        videos: Array.isArray(b.videos) ? b.videos.map(String) : []
      };
      await q`INSERT INTO ajustes (clave, valor) VALUES ('tienda', ${JSON.stringify(val)}::jsonb)
              ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`;
      // borra archivos subidos hace más de 1 hora que ya no se usan
      const usados = new Set((JSON.stringify(val).match(/\/api\/media\/[a-f0-9]+/g) || []).map(s => s.split('/').pop()));
      const viejos = await q`SELECT id FROM media WHERE creado < now() - interval '1 hour'`;
      for (const { id } of viejos) if (!usados.has(id)) await q`DELETE FROM media WHERE id = ${id}`;
      return send(res, 200, { ok: true });
    }

    if (path === 'media' && m === 'POST') {
      if (!okToken(req)) return send(res, 401, { error: 'No autorizado' });
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
      if (rg && (rg[1] || rg[2])) { // el video en iPhone necesita rangos
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

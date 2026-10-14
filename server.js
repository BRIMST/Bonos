'use strict';

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const admin = require('firebase-admin');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TZ = 'America/Bogota';
const PRICE_COP = 5000;
const CLOSE_HOUR = 19;

// ---- Configuración ----
// Si algo falta o está mal, el servidor NO se cae: responde 500 con un mensaje que indica qué corregir
// (solo nombres de variables, nunca valores secretos).
function parseServiceAccount(raw) {
  let t = String(raw || '').trim();
  if (!t) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON está vacía.');
  // Permite comillas externas y también el JSON codificado en base64.
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"{') && t.endsWith('}"'))) t = t.slice(1, -1);
  if (!t.startsWith('{')) {
    try { t = Buffer.from(t, 'base64').toString('utf8').trim(); } catch { /* se informa abajo */ }
  }
  const attempts = [t];
  // Saltos de línea reales dentro de textos (pasa al pegar la clave privada): se escapan.
  let out = '', inStr = false, esc = false;
  for (const ch of t) {
    if (inStr && !esc && (ch === '\n' || ch === '\r')) { if (ch === '\n') out += '\\n'; continue; }
    out += ch;
    if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = !inStr;
  }
  attempts.push(out);
  let parsed = null;
  for (const a of attempts) { try { parsed = JSON.parse(a); break; } catch { /* siguiente intento */ } }
  if (!parsed || typeof parsed !== 'object') throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON no es un JSON válido. Pega el contenido COMPLETO del archivo descargado de Firebase, empezando por { y terminando en }.');
  for (const k of ['project_id', 'client_email', 'private_key']) {
    if (!parsed[k]) throw new Error(`Al JSON de Firebase le falta el campo "${k}". Descarga de nuevo la clave privada.`);
  }
  parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');
  return parsed;
}

let db = null;
let initError = null;
try {
  const missing = ['ADMIN_PASSWORD', 'SESSION_SECRET', 'FIREBASE_SERVICE_ACCOUNT_JSON'].filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Faltan variables de entorno en Vercel: ${missing.join(', ')}. Agrégalas en Settings → Environment Variables y haz Redeploy.`);
  admin.initializeApp({ credential: admin.credential.cert(parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
  db = admin.firestore();
} catch (err) {
  initError = err.message;
  console.error('Error de configuración:', initError);
}
app.locals.initError = initError;
app.use((_req, res, next) => {
  if (!initError) return next();
  res.status(500).json({ error: `Error de configuración del servidor. ${initError}` });
});
// Los comprobantes se guardan en Firestore (colección 'receipts'); un documento admite máx. ~1 MiB.
const MAX_RECEIPT_BYTES = 800 * 1024;

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '30kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(cookieSession({
  name: 'bono_admin_session',
  keys: [process.env.SESSION_SECRET || 'sin-configurar'],
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 2 * 60 * 60 * 1000
}));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.' } });
const registerLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados registros desde esta conexión. Inténtalo más tarde.' } });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Solo se permiten JPG, PNG o PDF.'), allowed.includes(file.mimetype));
  }
});

function dateInBogota(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function timeInBogota(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return `${get('hour')}:${get('minute')}:${get('second')}`;
}
function nextDate(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;
}
function currentStatus(now = new Date()) {
  const date = dateInBogota(now);
  const time = timeInBogota(now);
  const closed = time >= `${String(CLOSE_HOUR).padStart(2,'0')}:00:00`;
  return { date, time, closed, closeTime: '19:00', assignedDate: closed ? nextDate(date) : date };
}
// Configuración editable desde el panel (llave Bre-B y contraseña), guardada en Firestore.
// Si aún no existe, se usan las variables de entorno como valores iniciales.
const settingsRef = {
  get: () => db.collection('settings').doc('app').get(),
  set: (...args) => db.collection('settings').doc('app').set(...args)
};
async function getSettings() {
  const snap = await settingsRef.get();
  return snap.exists ? snap.data() : {};
}
const PRIZE_MODES = ['premio', 'dinero', 'ambos'];
function publicPrize(settings) {
  if (!settings.prizeName) return null;
  return {
    name: settings.prizeName,
    description: settings.prizeDescription || '',
    mode: PRIZE_MODES.includes(settings.prizeMode) ? settings.prizeMode : 'premio',
    cashCop: settings.prizeCashCop || 0,
    imageVersion: settings.prizeImageVersion || null
  };
}
function publicWinner(settings) {
  if (!settings.winnerNumber) return null;
  return { number: settings.winnerNumber, date: settings.winnerDate || '', version: settings.winnerVersion || 0 };
}
function safeUrl(u) {
  try {
    const url = new URL(String(u || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href.slice(0, 300) : '';
  } catch { return ''; }
}
function publicProfile(settings) {
  const p = settings.profile;
  if (!p || !p.name) return null;
  return { name: p.name, bio: p.bio || '', links: Array.isArray(p.links) ? p.links.filter(l => l && l.url) : [] };
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
async function verifyPassword(password, settings) {
  if (settings.passwordHash && settings.passwordSalt) {
    const a = Buffer.from(hashPassword(password, settings.passwordSalt).hash, 'hex');
    return crypto.timingSafeEqual(a, Buffer.from(settings.passwordHash, 'hex'));
  }
  return crypto.timingSafeEqual(sha256(password), sha256(process.env.ADMIN_PASSWORD));
}
async function requireAdmin(req, res, next) {
  try {
    if (req.session && req.session.isAdmin) {
      // Al cambiar la contraseña, las sesiones anteriores dejan de ser válidas.
      const settings = await getSettings();
      if ((req.session.pwv || 0) === (settings.passwordVersion || 0)) return next();
    }
    return res.status(401).json({ error: 'Debes iniciar sesión como administrador.' });
  } catch (err) { return next(err); }
}
function cleanString(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function validPhone(phone) {
  return /^\d{10}$/.test(phone);
}
function validNumber(number) {
  return /^\d{5}$/.test(number);
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}
// Verifica que el contenido real del archivo coincida con el tipo declarado (no solo el mimetype del cliente).
function matchesSignature(buf, mime) {
  if (!buf || buf.length < 8) return false;
  if (mime === 'image/jpeg') return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  if (mime === 'image/png') return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  if (mime === 'application/pdf') return buf.subarray(0, 5).toString('latin1') === '%PDF-';
  return false;
}
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}
// Consulta de un día usando solo el índice de un campo (no requiere índices compuestos en Firestore).
async function recordsForDate(date) {
  const snap = await db.collection('registrations').where('createdDateBogota', '==', date).limit(5000).get();
  return snap.docs.map(d => d.data()).sort((a, b) => String(a.createdAtIso).localeCompare(String(b.createdAtIso)));
}
function publicRecord(d) {
  return {
    id: d.id, createdDateBogota: d.createdDateBogota,
    createdTimeBogota: d.createdTimeBogota, assignedDate: d.assignedDate,
    receivedAfterClose: d.receivedAfterClose, fullName: d.fullName,
    socialUser: d.socialUser, phone: d.phone, number: d.number,
    amountCop: d.amountCop, paymentStatus: d.paymentStatus,
    participationStatus: d.participationStatus || 'pendiente_verificacion',
    duplicateReceipt: Boolean(d.duplicateReceipt)
  };
}

app.get('/api/status', async (_req, res, next) => {
  try {
  const status = currentStatus();
  const settings = await getSettings();
  res.json({
    date: status.date, time: status.time, closed: status.closed,
    closeTime: status.closeTime, price: PRICE_COP,
    brebLabel: settings.brebLabel || process.env.BREB_LABEL || 'Llave Bre-B',
    brebValue: settings.brebValue || process.env.BREB_VALUE || 'Pago no configurado aún',
    prize: publicPrize(settings),
    winner: publicWinner(settings),
    profile: publicProfile(settings)
  });
  } catch (err) { next(err); }
});

app.post('/api/register', registerLimiter, upload.single('receipt'), async (req, res, next) => {
  try {
    const fullName = cleanString(req.body.fullName, 120);
    const socialUser = cleanString(req.body.socialUser, 80);
    const phone = cleanString(req.body.phone, 10);
    const number = cleanString(req.body.number, 5);
    const acceptedTerms = req.body.acceptedTerms === 'on' || req.body.acceptedTerms === 'true';

    if (fullName.length < 3) return res.status(400).json({ error: 'Escribe tu nombre completo.' });
    if (socialUser.length < 2) return res.status(400).json({ error: 'Escribe tu usuario de red social.' });
    if (!validPhone(phone)) return res.status(400).json({ error: 'El celular debe tener exactamente 10 dígitos.' });
    if (!validNumber(number)) return res.status(400).json({ error: 'El número debe tener exactamente 5 cifras, incluidos los ceros iniciales.' });
    if (!acceptedTerms) return res.status(400).json({ error: 'Debes aceptar los términos.' });
    if (!req.file) return res.status(400).json({ error: 'Debes adjuntar el comprobante de pago.' });
    if (!matchesSignature(req.file.buffer, req.file.mimetype)) {
      return res.status(400).json({ error: 'El archivo no es un JPG, PNG o PDF válido.' });
    }

    // La hora se calcula exclusivamente en el servidor, en la zona de Bogotá.
    const status = currentStatus();
    // No se trasladan registros a otra jornada: después del cierre se rechaza el envío.
    if (status.closed) {
      return res.status(409).json({ error: 'La jornada de hoy cerró a las 7:00 p. m. Los registros no se trasladan al día siguiente. Vuelve mañana y realiza un nuevo registro con su comprobante de pago.' });
    }
    if (req.file.buffer.length > MAX_RECEIPT_BYTES) {
      return res.status(413).json({ error: 'El comprobante pesa demasiado (máximo 800 KB). Usa una captura más liviana o un PDF más pequeño.' });
    }
    const id = crypto.randomUUID();
    const receiptHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const sameReceipt = await db.collection('registrations').where('receiptHash', '==', receiptHash).limit(1).get();

    const record = {
      id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtIso: new Date().toISOString(),
      createdDateBogota: status.date,
      createdTimeBogota: status.time,
      assignedDate: status.date,
      receivedAfterClose: false,
      fullName,
      socialUser,
      phone,
      number,
      amountCop: PRICE_COP,
      hasReceipt: true,
      receiptHash,
      duplicateReceipt: !sameReceipt.empty,
      receiptMimeType: req.file.mimetype,
      paymentStatus: 'pendiente_revision',
      participationStatus: 'pendiente_verificacion',
      termsAccepted: true,
      termsVersion: '2026-10-13-v1'
    };
    // Primero el comprobante y luego el registro: nunca queda un registro sin comprobante.
    await db.collection('receipts').doc(id).set({
      id, mimeType: req.file.mimetype, size: req.file.buffer.length,
      data: req.file.buffer, createdDateBogota: status.date
    });
    await db.collection('registrations').doc(id).set(record);
    res.status(201).json({
      message: 'Registro recibido para la jornada de hoy. La participación solo queda aceptada cuando el pago sea verificado antes de las 7:00 p. m. Si no se verifica a tiempo, no participa y no se traslada a otro día.',
      id,
      assignedDate: status.date,
      receivedAfterClose: false
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/login', loginLimiter, async (req, res, next) => {
  try {
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const settings = await getSettings();
    if (!(await verifyPassword(password, settings))) return res.status(401).json({ error: 'Contraseña incorrecta.' });
    req.session.isAdmin = true;
    req.session.pwv = settings.passwordVersion || 0;
    res.json({ ok: true });
  } catch (err) { next(err); }
});
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  req.session = null;
  res.json({ ok: true });
});
app.get('/api/admin/me', async (req, res, next) => {
  try {
    const settings = await getSettings();
    const ok = Boolean(req.session && req.session.isAdmin && (req.session.pwv || 0) === (settings.passwordVersion || 0));
    res.json({ authenticated: ok });
  } catch (err) { next(err); }
});

app.get('/api/admin/settings', requireAdmin, async (_req, res, next) => {
  try {
    const settings = await getSettings();
    res.json({
      brebLabel: settings.brebLabel || process.env.BREB_LABEL || 'Llave Bre-B',
      brebValue: settings.brebValue || process.env.BREB_VALUE || '',
      winner: publicWinner(settings),
      profile: publicProfile(settings) || { name: '', bio: '', links: [] },
      prize: publicPrize(settings) || { name: '', description: '', mode: 'premio', cashCop: 0, imageVersion: null }
    });
  } catch (err) { next(err); }
});

app.put('/api/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    const brebLabel = cleanString(req.body.brebLabel, 60);
    const brebValue = cleanString(req.body.brebValue, 120);
    if (brebLabel.length < 2) return res.status(400).json({ error: 'Escribe un nombre para el método de pago (ej. Llave Bre-B).' });
    if (brebValue.length < 3) return res.status(400).json({ error: 'Escribe la llave o dato de pago.' });
    await settingsRef.set({ brebLabel, brebValue, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.json({ ok: true, brebLabel, brebValue });
  } catch (err) { next(err); }
});

app.put('/api/admin/prize', requireAdmin, async (req, res, next) => {
  try {
    const name = cleanString(req.body.name, 80);
    const description = cleanString(req.body.description, 300);
    const mode = req.body.mode;
    const cashCop = Math.round(Number(req.body.cashCop) || 0);
    if (!PRIZE_MODES.includes(mode)) return res.status(400).json({ error: 'Elige si el premio es el artículo, dinero o que el ganador elija.' });
    if (name.length < 2) return res.status(400).json({ error: 'Escribe el nombre del premio.' });
    if ((mode === 'dinero' || mode === 'ambos') && (cashCop < 1000 || cashCop > 1000000000)) {
      return res.status(400).json({ error: 'Escribe el valor en dinero (mínimo $1.000).' });
    }
    await settingsRef.set({
      prizeName: name, prizeDescription: description, prizeMode: mode,
      prizeCashCop: mode === 'premio' ? 0 : cashCop
    }, { merge: true });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/admin/prize/image', requireAdmin, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Selecciona una imagen.' });
    if (!['image/jpeg', 'image/png'].includes(req.file.mimetype) || !matchesSignature(req.file.buffer, req.file.mimetype)) {
      return res.status(400).json({ error: 'La imagen del premio debe ser JPG o PNG.' });
    }
    if (req.file.buffer.length > MAX_RECEIPT_BYTES) {
      return res.status(413).json({ error: 'La imagen pesa demasiado (máximo 800 KB).' });
    }
    const version = Date.now();
    await db.collection('prizeImage').doc('current').set({ mimeType: req.file.mimetype, data: req.file.buffer, version });
    await settingsRef.set({ prizeImageVersion: version }, { merge: true });
    res.json({ ok: true, version });
  } catch (err) { next(err); }
});

app.delete('/api/admin/prize/image', requireAdmin, async (_req, res, next) => {
  try {
    await db.collection('prizeImage').doc('current').delete();
    await settingsRef.set({ prizeImageVersion: null }, { merge: true });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/api/prize-image', async (_req, res, next) => {
  try {
    const snap = await db.collection('prizeImage').doc('current').get();
    if (!snap.exists) return res.status(404).end();
    const d = snap.data();
    res.setHeader('Content-Type', d.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(d.data));
  } catch (err) { next(err); }
});

app.get('/api/winners', async (_req, res, next) => {
  try {
    const settings = await getSettings();
    const snap = await db.collection('winners').orderBy('date', 'desc').limit(15).get();
    const list = snap.docs.map(d => d.data()).filter(w => w.date !== settings.winnerDate).slice(0, 10)
      .map(w => ({ date: w.date, number: w.number }));
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ winners: list });
  } catch (err) { next(err); }
});

app.put('/api/admin/winner', requireAdmin, async (req, res, next) => {
  try {
    const number = cleanString(req.body.number, 5);
    const date = validDate(req.body.date) ? req.body.date : currentStatus().date;
    if (!validNumber(number)) return res.status(400).json({ error: 'El número ganador debe tener exactamente 5 cifras (por ejemplo 00523).' });
    await settingsRef.set({ winnerNumber: number, winnerDate: date, winnerVersion: Date.now() }, { merge: true });
    await db.collection('winners').doc(date).set({ date, number, publishedAtIso: new Date().toISOString() });
    res.json({ ok: true, number, date });
  } catch (err) { next(err); }
});

app.delete('/api/admin/winner', requireAdmin, async (_req, res, next) => {
  try {
    const current = await getSettings();
    if (validDate(current.winnerDate)) await db.collection('winners').doc(current.winnerDate).delete();
    await settingsRef.set({ winnerNumber: null, winnerDate: null, winnerVersion: null }, { merge: true });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.put('/api/admin/profile', requireAdmin, async (req, res, next) => {
  try {
    const name = cleanString(req.body.name, 80);
    const bio = cleanString(req.body.bio, 500);
    const rawLinks = Array.isArray(req.body.links) ? req.body.links.slice(0, 5) : [];
    const links = [];
    for (const l of rawLinks) {
      const label = cleanString(l && l.label, 40), url = safeUrl(l && l.url);
      if (!label && !(l && l.url)) continue;
      if (!label || !url) return res.status(400).json({ error: 'Cada enlace necesita un nombre y una dirección completa que empiece por https://' });
      links.push({ label, url });
    }
    if (!name && (bio || links.length)) return res.status(400).json({ error: 'Escribe tu nombre para mostrar la sección "Quiénes somos".' });
    await settingsRef.set({ profile: { name, bio, links } }, { merge: true });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/api/admin/qr.:fmt(png|svg)', requireAdmin, async (req, res, next) => {
  try {
    const QRCode = require('qrcode');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const target = safeUrl(req.query.url) || `https://${host}/`;
    const opts = { errorCorrectionLevel: 'H', margin: 2, color: { dark: '#1a1446', light: '#ffffff' } };
    if (req.params.fmt === 'svg') {
      res.setHeader('Content-Type', 'image/svg+xml');
      if (req.query.download) res.setHeader('Content-Disposition', 'attachment; filename="qr-juntos-sumamos.svg"');
      return res.send(await QRCode.toString(target, { ...opts, type: 'svg' }));
    }
    res.setHeader('Content-Type', 'image/png');
    if (req.query.download) res.setHeader('Content-Disposition', 'attachment; filename="qr-juntos-sumamos.png"');
    res.send(await QRCode.toBuffer(target, { ...opts, width: 1024 }));
  } catch (err) { next(err); }
});

app.post('/api/admin/password', requireAdmin, async (req, res, next) => {
  try {
    const current = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const next1 = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    const settings = await getSettings();
    if (!(await verifyPassword(current, settings))) return res.status(403).json({ error: 'La contraseña actual no es correcta.' });
    if (next1.length < 10 || next1.length > 200) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 10 caracteres.' });
    const { salt, hash } = hashPassword(next1);
    const passwordVersion = (settings.passwordVersion || 0) + 1;
    await settingsRef.set({ passwordSalt: salt, passwordHash: hash, passwordVersion }, { merge: true });
    // Esta sesión sigue activa; las demás quedan invalidadas.
    req.session.pwv = passwordVersion;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/api/admin/registrations', requireAdmin, async (req, res, next) => {
  try {
    const status = currentStatus();
    const dayMode = req.query.today === '1' || validDate(req.query.date);
    const date = validDate(req.query.date) ? req.query.date : status.date;
    let docs;
    if (dayMode) {
      docs = (await recordsForDate(date)).reverse();
    } else {
      const snap = await db.collection('registrations').orderBy('createdAt', 'desc').limit(1000).get();
      docs = snap.docs.map(d => d.data());
    }
    const accepted = docs.filter(d => d.participationStatus === 'aceptada' && !d.receivedAfterClose);
    const summary = {
      total: docs.length,
      accepted: accepted.length,
      acceptedAmountCop: accepted.reduce((sum, d) => sum + (d.amountCop || 0), 0),
      pending: docs.filter(d => (d.participationStatus || 'pendiente_verificacion') === 'pendiente_verificacion').length,
      rejected: docs.filter(d => d.participationStatus === 'rechazada').length
    };
    res.json({ records: docs.slice(0, 1000).map(publicRecord), status, summary, date: dayMode ? date : null, limit: 1000 });
  } catch (err) { next(err); }
});

app.get('/api/admin/receipt/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'Comprobante no encontrado.' });
    const snap = await db.collection('receipts').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'Comprobante no encontrado.' });
    const data = snap.data();
    res.setHeader('Content-Type', data.mimeType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(data.data));
  } catch (err) { next(err); }
});

app.patch('/api/admin/registrations/:id/payment', requireAdmin, async (req, res, next) => {
  try {
    const paymentStatus = req.body.paymentStatus;
    if (!['pendiente_revision', 'verificado', 'rechazado'].includes(paymentStatus)) {
      return res.status(400).json({ error: 'Estado de pago inválido.' });
    }
    const ref = db.collection('registrations').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Registro no encontrado.' });
    const record = snap.data();
    if (paymentStatus === 'verificado') {
      const nowStatus = currentStatus();
      if (nowStatus.closed || record.assignedDate !== nowStatus.date || record.receivedAfterClose) {
        return res.status(409).json({ error: 'Solo se puede verificar un pago antes de las 7:00 p. m. del mismo día de la inscripción. Esta participación no se traslada a otra jornada.' });
      }
    }
    // Una participación ya aceptada queda congelada una vez cierra la jornada.
    if (record.participationStatus === 'aceptada' && paymentStatus !== 'verificado') {
      const nowStatus = currentStatus();
      if (nowStatus.closed || record.assignedDate !== nowStatus.date) {
        return res.status(409).json({ error: 'La jornada ya cerró: una participación aceptada no se puede modificar.' });
      }
    }
    const participationStatus = paymentStatus === 'verificado' ? 'aceptada' : paymentStatus === 'rechazado' ? 'rechazada' : 'pendiente_verificacion';
    await ref.update({
      paymentStatus, participationStatus,
      paymentReviewedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});


app.get('/api/admin/export.xlsx', requireAdmin, async (req, res, next) => {
  try {
    const status = currentStatus();
    const date = validDate(req.query.date) ? req.query.date : status.date;
    status.date = date;
    const accepted = (await recordsForDate(date)).filter(d => d.participationStatus === 'aceptada' && !d.receivedAfterClose);

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Bono de Contribución Diaria';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Participantes del día', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });
    sheet.columns = [
      { header: 'ID', key: 'id', width: 38 },
      { header: 'Fecha Bogotá', key: 'date', width: 16 },
      { header: 'Hora Bogotá', key: 'time', width: 14 },
      { header: 'Nombre completo', key: 'name', width: 30 },
      { header: 'Red social', key: 'social', width: 22 },
      { header: 'Celular', key: 'phone', width: 16 },
      { header: 'Número de 5 cifras', key: 'number', width: 20 },
      { header: 'Valor (COP)', key: 'amount', width: 15 },
      { header: 'Estado del pago', key: 'payment', width: 22 },
      { header: 'Jornada asignada', key: 'assignedDate', width: 18 }
    ];
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: 'FF123B72' }
    };
    sheet.autoFilter = { from: 'A1', to: 'J1' };

    accepted.forEach(d => {
      sheet.addRow({
        id: d.id,
        date: d.createdDateBogota,
        time: d.createdTimeBogota,
        name: d.fullName,
        social: d.socialUser,
        phone: String(d.phone),
        // Texto para conservar los ceros a la izquierda en Excel.
        number: String(d.number).padStart(5, '0'),
        amount: d.amountCop,
        payment: d.paymentStatus === 'verificado' ? 'Verificado'
          : d.paymentStatus === 'rechazado' ? 'Rechazado' : 'Pendiente de revisión',
        assignedDate: d.assignedDate
      });
    });

    sheet.getColumn('number').numFmt = '@';
    sheet.getColumn('phone').numFmt = '@';
    sheet.getColumn('amount').numFmt = '#,##0';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="participantes-${status.date}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

app.get('/api/admin/export.csv', requireAdmin, async (req, res, next) => {
  try {
    const status = currentStatus();
    const date = validDate(req.query.date) ? req.query.date : status.date;
    status.date = date;
    const accepted = (await recordsForDate(date)).filter(d => d.participationStatus === 'aceptada' && !d.receivedAfterClose);
    const rows = [['ID','Fecha Bogotá','Hora Bogotá','Nombre','Red social','Celular','Número','Estado pago']];
    accepted.forEach(d => {
      rows.push([d.id,d.createdDateBogota,d.createdTimeBogota,d.fullName,d.socialUser,d.phone,d.number,d.paymentStatus]);
    });
    const csv = rows.map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="participantes-${status.date}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) { next(err); }
});

app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Ruta no encontrada.' });
  next();
});
app.use((err, _req, res, _next) => {
  console.error(err);
  const message = err instanceof multer.MulterError
    ? (err.code === 'LIMIT_FILE_SIZE' ? 'El comprobante pesa demasiado (máximo 800 KB).' : 'No se pudo procesar el archivo.')
    : (err.message === 'Solo se permiten JPG, PNG o PDF.' ? err.message : 'Error interno. Inténtalo de nuevo.');
  res.status(err instanceof multer.MulterError || err.message === 'Solo se permiten JPG, PNG o PDF.' ? 400 : 500).json({ error: message });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Servidor disponible en http://localhost:${PORT}`));
}

module.exports = app;

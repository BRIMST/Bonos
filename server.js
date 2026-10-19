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
      imgSrc: ["'self'", 'data:', 'https://i.ytimg.com'],
      connectSrc: ["'self'"],
      frameSrc: ['https://www.youtube-nocookie.com', 'https://www.tiktok.com', 'https://www.instagram.com'],
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
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false,
  skip: req => req.method === 'GET' && (req.path === '/roulette' || req.path === '/community') })); // la pantalla del live consulta seguido; tiene su propio límite
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
// ---- Evento ----
// El administrador inicia el evento; termina a las 7:00 p. m. (Bogotá) del día siguiente al inicio.
// Bogotá es UTC-5 todo el año, así que las 19:00 locales son las 00:00 UTC del día siguiente.
function eventEndFor(start) {
  const [y, m, d] = dateInBogota(start).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 2, 0, 0, 0));
}
function eventState(settings, now = new Date()) {
  const ev = settings.event;
  if (!ev || !ev.id) return { exists: false, active: false };
  const endMs = Date.parse(ev.endIso);
  const active = ev.status === 'abierto' && now.getTime() < endMs;
  return {
    exists: true, active, id: ev.id, startIso: ev.startIso,
    endIso: ev.endIso, quintaDate: ev.quintaDate, endedEarly: Boolean(ev.endedEarly),
    serverNowIso: now.toISOString()
  };
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
// Rol de la sesión: 'admin' (todo) o 'verifier' (solo revisar pagos). Al cambiar una contraseña, sus sesiones anteriores dejan de ser válidas.
async function staffRole(req) {
  if (!req.session) return null;
  const settings = await getSettings();
  if (req.session.isAdmin && (req.session.pwv || 0) === (settings.passwordVersion || 0)) return 'admin';
  if (req.session.isVerifier && settings.verifierHash && (req.session.vpv || 0) === (settings.verifierVersion || 0)) return 'verifier';
  return null;
}
async function requireStaff(req, res, next) {
  try {
    const role = await staffRole(req);
    if (role) { req.role = role; return next(); }
    return res.status(401).json({ error: 'Debes iniciar sesión.' });
  } catch (err) { return next(err); }
}
async function requireAdmin(req, res, next) {
  try {
    const role = await staffRole(req);
    if (role === 'admin') { req.role = role; return next(); }
    if (role === 'verifier') return res.status(403).json({ error: 'Esta acción es solo para el administrador.' });
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
async function recordsForEvent(eventId) {
  const snap = await db.collection('registrations').where('eventId', '==', eventId).limit(5000).get();
  return snap.docs.map(d => d.data()).sort((a, b) => String(a.createdAtIso).localeCompare(String(b.createdAtIso)));
}
function publicRecord(d) {
  return {
    id: d.id, eventId: d.eventId || null, createdDateBogota: d.createdDateBogota,
    createdTimeBogota: d.createdTimeBogota, assignedDate: d.assignedDate,
    receivedAfterClose: d.receivedAfterClose, fullName: d.fullName,
    socialUser: d.socialUser, phone: d.phone, number: d.number,
    amountCop: d.amountCop, paymentStatus: d.paymentStatus,
    participationStatus: d.participationStatus || 'pendiente_verificacion',
    duplicateReceipt: Boolean(d.duplicateReceipt), receiptPurged: Boolean(d.receiptPurgedAt), reference: d.reference || ''
  };
}

app.get('/api/status', async (_req, res, next) => {
  try {
  const status = currentStatus();
  const settings = await getSettings();
  const ev = eventState(settings);
  res.json({
    date: status.date, time: status.time, closed: !ev.active,
    closeTime: status.closeTime, price: PRICE_COP, event: ev,
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
    const reference = cleanRef(req.body.reference);

    if (fullName.length < 3) return res.status(400).json({ error: 'Escribe tu nombre completo.' });
    if (socialUser.length < 2) return res.status(400).json({ error: 'Escribe tu usuario de red social.' });
    if (!validPhone(phone)) return res.status(400).json({ error: 'El celular debe tener exactamente 10 dígitos.' });
    if (reference && reference.length < 4) return res.status(400).json({ error: REF_ERR });
    if (!validNumber(number)) return res.status(400).json({ error: 'El número debe tener exactamente 5 cifras, incluidos los ceros iniciales.' });
    if (!acceptedTerms) return res.status(400).json({ error: 'Debes aceptar los términos.' });
    if (!req.file) return res.status(400).json({ error: 'Debes adjuntar el comprobante de pago.' });
    if (!matchesSignature(req.file.buffer, req.file.mimetype)) {
      return res.status(400).json({ error: 'El archivo no es un JPG, PNG o PDF válido.' });
    }

    // La hora se calcula exclusivamente en el servidor, en la zona de Bogotá.
    const status = currentStatus();
    // Solo se puede registrar mientras hay un evento abierto; no se trasladan registros a otro evento.
    const ev = eventState(await getSettings());
    if (!ev.active) {
      return res.status(409).json({ error: ev.exists
        ? 'El evento ya cerró. Los registros no se trasladan al siguiente evento. Cuando se abra uno nuevo podrás participar con un nuevo registro y su comprobante.'
        : 'Por ahora no hay un evento abierto. Vuelve cuando se anuncie el próximo.' });
    }
    if (req.file.buffer.length > MAX_RECEIPT_BYTES) {
      return res.status(413).json({ error: 'El comprobante pesa demasiado (máximo 800 KB). Usa una captura más liviana o un PDF más pequeño.' });
    }
    const id = crypto.randomUUID();
    const receiptHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const seenBefore = await receiptSeenBefore(receiptHash, reference);

    const record = {
      id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtIso: new Date().toISOString(),
      createdDateBogota: status.date,
      createdTimeBogota: status.time,
      eventId: ev.id,
      assignedDate: ev.quintaDate,
      receivedAfterClose: false,
      fullName,
      socialUser,
      phone,
      number,
      amountCop: PRICE_COP,
      hasReceipt: true,
      receiptHash,
      reference,
      duplicateReceipt: seenBefore,
      receiptMimeType: req.file.mimetype,
      paymentStatus: 'pendiente_revision',
      participationStatus: 'pendiente_verificacion',
      termsAccepted: true,
      termsVersion: '2026-10-13-v1'
    };
    // Primero el comprobante y luego el registro: nunca queda un registro sin comprobante.
    await db.collection('receipts').doc(id).set({
      id, mimeType: req.file.mimetype, size: req.file.buffer.length,
      data: req.file.buffer, createdDateBogota: status.date, eventId: ev.id, kind: 'quinta'
    });
    await db.collection('registrations').doc(id).set(record);
    res.status(201).json({
      message: 'Registro recibido para este evento. La participación solo queda aceptada cuando el pago sea verificado antes del cierre del evento. Si no se verifica a tiempo, no participa y no se traslada a otro evento.',
      id,
      assignedDate: ev.quintaDate,
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
    if (await verifyPassword(password, settings)) {
      req.session = { isAdmin: true, pwv: settings.passwordVersion || 0 };
      return res.json({ ok: true, role: 'admin' });
    }
    if (settings.verifierHash && settings.verifierSalt) {
      const a = Buffer.from(hashPassword(password, settings.verifierSalt).hash, 'hex');
      if (crypto.timingSafeEqual(a, Buffer.from(settings.verifierHash, 'hex'))) {
        req.session = { isVerifier: true, vpv: settings.verifierVersion || 0 };
        return res.json({ ok: true, role: 'verifier' });
      }
    }
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  } catch (err) { next(err); }
});
app.post('/api/admin/logout', requireStaff, (req, res) => {
  req.session = null;
  res.json({ ok: true });
});
app.get('/api/admin/me', async (req, res, next) => {
  try {
    const settings = await getSettings();
    const role = await staffRole(req);
    res.json({ authenticated: Boolean(role), role });
  } catch (err) { next(err); }
});

app.get('/api/admin/settings', requireStaff, async (req, res, next) => {
  try {
    const settings = await getSettings();
    res.json({
      brebLabel: settings.brebLabel || process.env.BREB_LABEL || 'Llave Bre-B',
      brebValue: settings.brebValue || process.env.BREB_VALUE || '',
      event: eventState(settings),
      role: req.role,
      hasVerifier: Boolean(settings.verifierHash),
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
    const evSettings = await getSettings();
    const date = validDate(req.body.date) ? req.body.date
      : (evSettings.event && evSettings.event.quintaDate) || currentStatus().date;
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

app.post('/api/admin/verifier-password', requireAdmin, async (req, res, next) => {
  try {
    const pw = typeof req.body.password === 'string' ? req.body.password : '';
    const settings = await getSettings();
    if (pw.length < 8 || pw.length > 200) return res.status(400).json({ error: 'La contraseña del verificador debe tener al menos 8 caracteres.' });
    if (await verifyPassword(pw, settings)) return res.status(400).json({ error: 'Debe ser distinta a tu contraseña de administrador.' });
    const { salt, hash } = hashPassword(pw);
    await settingsRef.set({ verifierSalt: salt, verifierHash: hash, verifierVersion: (settings.verifierVersion || 0) + 1 }, { merge: true });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
app.delete('/api/admin/verifier-password', requireAdmin, async (_req, res, next) => {
  try {
    const settings = await getSettings();
    await settingsRef.set({ verifierSalt: null, verifierHash: null, verifierVersion: (settings.verifierVersion || 0) + 1 }, { merge: true });
    res.json({ ok: true });
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

// Eventos: iniciar, terminar antes de tiempo y listar.
app.post('/api/admin/event/start', requireAdmin, async (_req, res, next) => {
  try {
    const settings = await getSettings();
    const cur = eventState(settings);
    if (cur.active) return res.status(409).json({ error: 'Ya hay un evento abierto. Termínalo antes de iniciar otro.' });
    const now = new Date();
    const end = eventEndFor(now);
    const id = `ev-${dateInBogota(now)}-${timeInBogota(now).replace(/:/g, '')}`;
    const event = {
      id, status: 'abierto', startIso: now.toISOString(), endIso: end.toISOString(),
      quintaDate: dateInBogota(end), endedEarly: false
    };
    await db.collection('events').doc(id).set(event);
    await settingsRef.set({ event }, { merge: true });
    res.status(201).json({ ok: true, event: eventState({ event }, now) });
  } catch (err) { next(err); }
});

app.post('/api/admin/event/end', requireAdmin, async (_req, res, next) => {
  try {
    const settings = await getSettings();
    const cur = eventState(settings);
    if (!cur.active) return res.status(409).json({ error: 'No hay un evento abierto.' });
    const event = { ...settings.event, status: 'cerrado', endedEarly: true, closedAtIso: new Date().toISOString() };
    await db.collection('events').doc(event.id).set(event);
    await settingsRef.set({ event }, { merge: true });
    res.json({ ok: true, event: eventState({ event }) });
  } catch (err) { next(err); }
});

app.get('/api/admin/events', requireStaff, async (_req, res, next) => {
  try {
    const snap = await db.collection('events').limit(200).get();
    const events = snap.docs.map(d => d.data())
      .sort((a, b) => String(b.startIso).localeCompare(String(a.startIso))).slice(0, 40)
      .map(e => ({ id: e.id, startIso: e.startIso, endIso: e.endIso, quintaDate: e.quintaDate, endedEarly: Boolean(e.endedEarly) }));
    res.json({ events, current: eventState(await getSettings()) });
  } catch (err) { next(err); }
});

app.get('/api/admin/registrations', requireStaff, async (req, res, next) => {
  try {
    const status = currentStatus();
    const settings = await getSettings();
    const event = eventState(settings);
    const eventId = typeof req.query.event === 'string' && /^ev-[\d-]+$/.test(req.query.event) ? req.query.event : '';
    let docs;
    if (eventId) {
      docs = (await recordsForEvent(eventId)).reverse();
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
    res.json({ records: docs.slice(0, 1000).map(publicRecord), status, event, summary, eventId: eventId || null, limit: 1000 });
  } catch (err) { next(err); }
});

app.get('/api/admin/receipt/:id', requireStaff, async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'Comprobante no encontrado.' });
    const snap = await db.collection('receipts').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'El comprobante ya no está disponible (se elimina pasado un tiempo para proteger los datos).' });
    const data = snap.data();
    res.setHeader('Content-Type', data.mimeType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(data.data));
  } catch (err) { next(err); }
});

app.patch('/api/admin/registrations/:id/payment', requireStaff, async (req, res, next) => {
  try {
    const paymentStatus = req.body.paymentStatus;
    if (!['pendiente_revision', 'verificado', 'rechazado'].includes(paymentStatus)) {
      return res.status(400).json({ error: 'Estado de pago inválido.' });
    }
    const ref = db.collection('registrations').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Registro no encontrado.' });
    const record = snap.data();
    const ev = eventState(await getSettings());
    const inOpenEvent = ev.active && record.eventId === ev.id && !record.receivedAfterClose;
    if (paymentStatus === 'verificado' && !inOpenEvent) {
      return res.status(409).json({ error: 'Solo se puede verificar un pago mientras el evento de esa inscripción siga abierto. Esta participación no se traslada a otro evento.' });
    }
    // Una participación ya aceptada queda congelada una vez cierra el evento.
    if (record.participationStatus === 'aceptada' && paymentStatus !== 'verificado' && !inOpenEvent) {
      return res.status(409).json({ error: 'El evento ya cerró: una participación aceptada no se puede modificar.' });
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
    const eventId = typeof req.query.event === 'string' && /^ev-[\d-]+$/.test(req.query.event) ? req.query.event : '';
    if (!eventId) return res.status(400).json({ error: 'Elige un evento para descargar la lista.' });
    const status = { date: eventId.replace(/^ev-/, '') };
    const accepted = (await recordsForEvent(eventId)).filter(d => d.participationStatus === 'aceptada' && !d.receivedAfterClose);

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Bono de Contribución Diaria';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Participantes del evento', {
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
      { header: 'Juega en la Quinta del', key: 'assignedDate', width: 18 }
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
    const eventId = typeof req.query.event === 'string' && /^ev-[\d-]+$/.test(req.query.event) ? req.query.event : '';
    if (!eventId) return res.status(400).json({ error: 'Elige un evento para descargar la lista.' });
    const status = { date: eventId.replace(/^ev-/, '') };
    const accepted = (await recordsForEvent(eventId)).filter(d => d.participationStatus === 'aceptada' && !d.receivedAfterClose);
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

// ---- Ruleta de Seguidores ----
// Una ruleta a la vez. Los puestos se numeran y la página pública NUNCA recibe nombres ni teléfonos:
// solo los números de puesto ocupados. El ganador se elige en el servidor con un sorteo aleatorio seguro.
const ROULETTE_MARGIN_COP = 2000;   // margen para la barra naranja ("justo")
const SPIN_LEAD_MS = 7000;          // tiempo entre pulsar "Girar" y que arranque la animación (todos alcanzan a verla)
const SPIN_MS = 10000;              // duración de la animación
const rouletteRef = () => db.collection('roulette').doc('current');
// Cierre automático: si pasó la hora de cierre, la ruleta se comporta como "cerrada" sin tener que guardar nada.
function applyAutoClose(r) {
  if (r && r.status === 'abierta' && r.closesAtIso && Date.now() >= Date.parse(r.closesAtIso)) return { ...r, status: 'cerrada', autoClosed: true };
  return r;
}
async function getRoulette() { const s = await rouletteRef().get(); return s.exists ? applyAutoClose(s.data()) : null; }
const fail = (http, msg) => Object.assign(new Error(msg), { http, msg });
// Lectura + escritura atómica de la ruleta (evita que dos personas tomen el mismo puesto a la vez).
async function rouletteTx(fn) {
  if (typeof db.runTransaction === 'function') {
    return db.runTransaction(async tx => {
      const snap = await tx.get(rouletteRef());
      const io = { get: ref => tx.get(ref), set: (ref, d, o) => { tx.set(ref, d, o || {}); } };
      return fn(snap.exists ? applyAutoClose(snap.data()) : null, io);
    });
  }
  const pending = [];
  const io = { get: ref => ref.get(), set: (ref, d, o) => { pending.push(ref.set(d, o || {})); } };
  const out = await fn(await getRoulette(), io);
  await Promise.all(pending);
  return out;
}
async function reservationsOf(rouletteId) {
  const snap = await db.collection('rouletteReservations').where('rouletteId', '==', rouletteId).limit(3000).get();
  return snap.docs.map(d => d.data()).sort((a, b) => String(a.createdAtIso).localeCompare(String(b.createdAtIso)));
}
async function pendingReservations(rouletteId) { return (await reservationsOf(rouletteId)).filter(x => x.status === 'pendiente'); }
// ¿Ya se usó antes este comprobante (en la Quinta o en la Ruleta)? Solo se compara la huella, no la imagen.
// Un comprobante (o una referencia de transferencia) ya usado antes en cualquier modalidad se marca como repetido.
async function receiptSeenBefore(hash, reference) {
  for (const col of ['registrations', 'rouletteReservations', 'donations']) {
    let q = await db.collection(col).where('receiptHash', '==', hash).limit(1).get();
    if (!q.empty) return true;
    if (reference) { q = await db.collection(col).where('reference', '==', reference).limit(1).get(); if (!q.empty) return true; }
  }
  return false;
}
// Referencia de la transferencia (opcional): letras, números y guiones; mínimo 4 caracteres.
function cleanRef(v) { return cleanString(v, 40).replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }
const REF_ERR = 'La referencia de la transferencia debe tener al menos 4 caracteres (o déjala vacía).';
async function rouletteSeats(rouletteId) {
  const snap = await db.collection('rouletteSeats').where('rouletteId', '==', rouletteId).limit(5000).get();
  return snap.docs.map(d => d.data()).sort((a, b) => a.seat - b.seat);
}
function rouletteBar(r) {
  const collectedCop = (r.occupied || []).length * r.priceCop;
  const targetCop = r.prizeValueCop || 0;
  const diffCop = collectedCop - targetCop;
  const state = diffCop < -ROULETTE_MARGIN_COP ? 'rojo' : diffCop > ROULETTE_MARGIN_COP ? 'verde' : 'naranja';
  return { collectedCop, targetCop, diffCop, state, marginCop: ROULETTE_MARGIN_COP };
}
function publicRoulette(r) {
  if (!r) return { exists: false, serverNowIso: new Date().toISOString() };
  return {
    exists: true, id: r.id, name: r.name, status: r.status,
    seatsTotal: r.seats, occupied: r.occupied || [], held: r.held || [], closesAtIso: r.closesAtIso || null, priceCop: r.priceCop,
    prize: { name: r.prizeName, description: r.prizeDescription || '', imageVersion: r.prizeImageVersion || null },
    winnerSeat: r.status === 'sorteada' ? r.winnerSeat : null,
    spinVersion: r.spinVersion || 0, spinStartsAtIso: r.spinStartsAtIso || null, spinMs: SPIN_MS,
    serverNowIso: new Date().toISOString()
  };
}
function parseRouletteConfig(body, existingClosesAtIso) {
  const name = cleanString(body.name, 80) || 'Ruleta de Seguidores';
  const seats = Math.round(Number(body.seats));
  const priceCop = Math.round(Number(body.priceCop));
  const prizeName = cleanString(body.prizeName, 80);
  const prizeDescription = cleanString(body.prizeDescription, 300);
  const prizeValueCop = Math.round(Number(body.prizeValueCop));
  const requireMin = body.requireMin === true || body.requireMin === 'true';
  if (!(seats >= 2 && seats <= 1000)) return { error: 'La cantidad de puestos debe estar entre 2 y 1.000.' };
  if (!(priceCop >= 1000 && priceCop <= 10000000)) return { error: 'El precio por puesto debe ser de al menos $1.000.' };
  if (prizeName.length < 2) return { error: 'Escribe el nombre del premio.' };
  if (!(prizeValueCop >= 1000 && prizeValueCop <= 1000000000)) return { error: 'Escribe el valor del premio (mínimo $1.000). Se usa para la barra de recaudo.' };
  // Hora de cierre opcional, escrita en hora de Colombia: "2026-10-20T19:00".
  let closesAtIso = null;
  const rawClose = typeof body.closesAt === 'string' ? body.closesAt.trim() : '';
  if (rawClose) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(rawClose)) return { error: 'La hora de cierre no es válida.' };
    const t = Date.parse(rawClose + ':00-05:00');
    if (Number.isNaN(t)) return { error: 'La hora de cierre no es válida.' };
    closesAtIso = new Date(t).toISOString();
    if (closesAtIso !== existingClosesAtIso && t < Date.now() + 60000) return { error: 'La hora de cierre debe ser futura.' };
  }
  return { value: { name, seats, priceCop, prizeName, prizeDescription, prizeValueCop, requireMin, closesAtIso } };
}
function groupBuyers(seats) {
  const map = new Map();
  for (const s of seats) {
    if (!map.has(s.buyerId)) map.set(s.buyerId, { buyerId: s.buyerId, fullName: s.fullName, socialUser: s.socialUser, phone: s.phone, seats: [], amountCop: 0, refundStatus: s.refundStatus || null });
    const b = map.get(s.buyerId);
    b.seats.push(s.seat); b.amountCop += s.amountCop || 0;
    if (s.refundStatus === 'por_devolver') b.refundStatus = 'por_devolver';
  }
  return [...map.values()];
}
async function adminRouletteView(r) {
  if (!r) return { exists: false };
  const seats = await rouletteSeats(r.id);
  const buyers = groupBuyers(seats);
  const winnerSeat = r.status === 'sorteada' ? seats.find(s => s.seat === r.winnerSeat) : null;
  const pendingRes = (await pendingReservations(r.id)).map(x => ({ id: x.id, fullName: x.fullName, socialUser: x.socialUser, phone: x.phone,
    seats: x.seats, amountCop: x.amountCop, createdAtIso: x.createdAtIso, duplicateReceipt: Boolean(x.duplicateReceipt), receiptPurged: Boolean(x.receiptPurgedAt), reference: x.reference || '' }));
  const pending = seats.filter(s => s.refundStatus === 'por_devolver');
  const done = seats.filter(s => s.refundStatus === 'devuelto');
  return {
    exists: true,
    roulette: { ...publicRoulette(r), requireMin: Boolean(r.requireMin), prizeValueCop: r.prizeValueCop, cancelReason: r.cancelReason || '' },
    bar: rouletteBar(r), buyers, reservations: pendingRes,
    winner: winnerSeat ? { seat: winnerSeat.seat, fullName: winnerSeat.fullName, socialUser: winnerSeat.socialUser, phone: winnerSeat.phone } : null,
    refunds: { pendingCop: pending.reduce((n, s) => n + (s.amountCop || 0), 0), doneCop: done.reduce((n, s) => n + (s.amountCop || 0), 0) }
  };
}
const rouletteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 400, standardHeaders: true, legacyHeaders: false });
const openStatuses = ['abierta', 'cerrada'];

app.get('/api/roulette', rouletteLimiter, async (_req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=2, stale-while-revalidate=2');
    res.json(publicRoulette(await getRoulette()));
  } catch (err) { next(err); }
});
// Estado de cada evento, para que la gente distinga la Quinta de la Ruleta.
app.get('/api/modes', async (_req, res, next) => {
  try {
    const ev = eventState(await getSettings());
    const r = await getRoulette();
    const rs = !r ? 'sin_evento' : r.status === 'sorteada' ? 'finalizado' : r.status === 'cancelada' ? 'cancelado' : 'en_curso';
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5, stale-while-revalidate=5');
    res.json({ quinta: ev.active ? 'en_curso' : ev.exists ? 'finalizado' : 'sin_evento', ruleta: rs });
  } catch (err) { next(err); }
});
async function allRouletteWinners() {
  const snap = await db.collection('rouletteWinners').limit(300).get();
  return snap.docs.map(d => d.data()).sort((a, b) => String(b.winnerAtIso).localeCompare(String(a.winnerAtIso)));
}
app.get('/api/roulette/winners', async (_req, res, next) => {
  try {
    const cur = await getRoulette();
    // El ganador de la ruleta en curso se muestra en la pantalla principal; aquí solo los anteriores.
    const list = (await allRouletteWinners()).filter(w => !(cur && cur.status === 'sorteada' && w.id === cur.id)).slice(0, 15)
      .map(w => ({ date: w.dateBogota, time: timeInBogota(new Date(w.winnerAtIso)).slice(0, 5), eventName: w.eventName, prizeName: w.prizeName, seat: w.seat, delivered: Boolean(w.delivered) }));
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=30');
    res.json({ winners: list });
  } catch (err) { next(err); }
});
app.get('/api/admin/roulette/winners', requireAdmin, async (_req, res, next) => {
  try { res.json({ winners: (await allRouletteWinners()).slice(0, 100) }); } catch (err) { next(err); }
});
app.patch('/api/admin/roulette/winners/:id/delivered', requireAdmin, async (req, res, next) => {
  try {
    if (!/^rl-\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Ganador no encontrado.' });
    const ref = db.collection('rouletteWinners').doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'Ganador no encontrado.' });
    await ref.set({ delivered: req.body.done === true, deliveredAtIso: req.body.done === true ? new Date().toISOString() : null }, { merge: true });
    res.json({ winners: (await allRouletteWinners()).slice(0, 100) });
  } catch (err) { next(err); }
});
// Acta descargable: quién participó, cuánto se recaudó y quién ganó, con fecha y hora del sorteo.
app.get('/api/admin/roulette/acta.csv', requireAdmin, async (req, res, next) => {
  try {
    const cur = await getRoulette();
    const wanted = typeof req.query.id === 'string' && /^rl-\d+$/.test(req.query.id) ? req.query.id : (cur && cur.id);
    let r = cur && cur.id === wanted ? cur : null;
    if (!r && wanted) { const h = await db.collection('rouletteHistory').doc(wanted).get(); r = h.exists ? h.data() : null; }
    if (!r) return res.status(404).json({ error: 'No hay ruleta para generar el acta.' });
    const seats = await rouletteSeats(r.id);
    const when = iso => iso ? `${dateInBogota(new Date(iso))} ${timeInBogota(new Date(iso))} (hora de Colombia)` : '';
    const win = r.status === 'sorteada' ? seats.find(s => s.seat === r.winnerSeat) : null;
    const rows = [
      ['Acta de la Ruleta de Seguidores'], ['Evento', r.name], ['Estado', r.status],
      ['Premio', r.prizeName], ['Valor del premio (COP)', r.prizeValueCop], ['Precio por puesto (COP)', r.priceCop],
      ['Puestos ocupados', `${seats.length} de ${r.seats}`], ['Recaudado (COP)', seats.length * r.priceCop],
      ['Fecha y hora del sorteo', when(r.winnerAtIso)], ['Puesto ganador', win ? win.seat : ''],
      ['Ganador', win ? `${win.fullName} ${win.socialUser || ''} ${win.phone || ''}`.trim() : ''],
      ['Cancelada', r.status === 'cancelada' ? `${when(r.cancelledAtIso)} ${r.cancelReason || ''}`.trim() : ''],
      [], ['Puesto', 'Nombre', 'Usuario', 'Celular', 'Aporte (COP)', 'Agregado', 'Devolución']
    ];
    seats.forEach(s => rows.push([s.seat, s.fullName, s.socialUser, s.phone, s.amountCop, when(s.addedAtIso), s.refundStatus === 'devuelto' ? 'Devuelto' : s.refundStatus === 'por_devolver' ? 'Por devolver' : '']));
    const csv = rows.map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="acta-${r.id}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) { next(err); }
});
app.get('/api/roulette-image', async (_req, res, next) => {
  try {
    const snap = await db.collection('rouletteImage').doc('current').get();
    if (!snap.exists) return res.status(404).end();
    const d = snap.data();
    res.setHeader('Content-Type', d.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(d.data));
  } catch (err) { next(err); }
});

app.get('/api/admin/roulette', requireStaff, async (_req, res, next) => {
  try { res.json(await adminRouletteView(await getRoulette())); } catch (err) { next(err); }
});

app.post('/api/admin/roulette', requireAdmin, async (req, res, next) => {
  try {
    const cur = await getRoulette();
    if (cur && openStatuses.includes(cur.status)) return res.status(409).json({ error: 'Ya hay una ruleta en curso. Sortéala o cancélala antes de crear otra.' });
    const cfg = parseRouletteConfig(req.body, null);
    if (cfg.error) return res.status(400).json({ error: cfg.error });
    if (cur) await db.collection('rouletteHistory').doc(cur.id).set(cur);
    const r = { id: `rl-${Date.now()}`, status: 'abierta', occupied: [], held: [], createdAtIso: new Date().toISOString(), ...cfg.value, prizeImageVersion: null, spinVersion: 0 };
    await rouletteRef().set(r);
    await db.collection('rouletteImage').doc('current').delete();
    res.status(201).json(await adminRouletteView(r));
  } catch (err) { next(err); }
});

app.put('/api/admin/roulette', requireAdmin, async (req, res, next) => {
  try {
    const r = await getRoulette();
    if (!r || !openStatuses.includes(r.status)) return res.status(409).json({ error: 'No hay una ruleta abierta para editar.' });
    const cfg = parseRouletteConfig(req.body, r.closesAtIso || null);
    if (cfg.error) return res.status(400).json({ error: cfg.error });
    const sold = r.occupied.length + (r.held || []).length;
    if (cfg.value.seats < sold) return res.status(409).json({ error: `Ya hay ${sold} puestos ocupados o apartados: no puedes dejar menos.` });
    if (sold > 0 && cfg.value.priceCop !== r.priceCop) return res.status(409).json({ error: 'No se puede cambiar el precio cuando ya hay puestos vendidos.' });
    await rouletteRef().set(cfg.value, { merge: true });
    res.json(await adminRouletteView({ ...r, ...cfg.value }));
  } catch (err) { next(err); }
});

app.post('/api/admin/roulette/image', requireAdmin, upload.single('image'), async (req, res, next) => {
  try {
    const r = await getRoulette();
    if (!r) return res.status(409).json({ error: 'Primero crea la ruleta.' });
    if (!req.file) return res.status(400).json({ error: 'Selecciona una imagen.' });
    if (!['image/jpeg', 'image/png'].includes(req.file.mimetype) || !matchesSignature(req.file.buffer, req.file.mimetype)) {
      return res.status(400).json({ error: 'La imagen del premio debe ser JPG o PNG.' });
    }
    if (req.file.buffer.length > MAX_RECEIPT_BYTES) return res.status(413).json({ error: 'La imagen pesa demasiado (máximo 800 KB).' });
    const version = Date.now();
    await db.collection('rouletteImage').doc('current').set({ mimeType: req.file.mimetype, data: req.file.buffer, version });
    await rouletteRef().set({ prizeImageVersion: version }, { merge: true });
    res.json({ ok: true, version });
  } catch (err) { next(err); }
});
app.delete('/api/admin/roulette/image', requireAdmin, async (_req, res, next) => {
  try {
    if (!(await getRoulette())) return res.status(409).json({ error: 'No hay ruleta.' });
    await db.collection('rouletteImage').doc('current').delete();
    await rouletteRef().set({ prizeImageVersion: null }, { merge: true });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Agrega a un seguidor (después de confirmar su pago). Cada puesto es un número; puede comprar varios.
app.post('/api/admin/roulette/seats', requireAdmin, async (req, res, next) => {
  try {
    const fullName = cleanString(req.body.fullName, 120);
    const socialUser = cleanString(req.body.socialUser, 80);
    const phone = cleanString(req.body.phone, 10);
    const quantity = Math.round(Number(req.body.quantity) || 1);
    if (fullName.length < 3) return res.status(400).json({ error: 'Escribe el nombre completo del seguidor.' });
    if (phone && !validPhone(phone)) return res.status(400).json({ error: 'El celular debe tener 10 dígitos (o déjalo vacío).' });
    if (!(quantity >= 1 && quantity <= 100)) return res.status(400).json({ error: 'La cantidad de puestos debe estar entre 1 y 100.' });
    const free = await rouletteTx(async (r, io) => {
      if (!r || r.status !== 'abierta') throw fail(409, 'Las inscripciones no están abiertas.');
      const taken = new Set([...r.occupied, ...(r.held || [])]);
      const seats = [];
      for (let n = 1; n <= r.seats && seats.length < quantity; n++) if (!taken.has(n)) seats.push(n);
      if (seats.length < quantity) throw fail(409, `Solo quedan ${r.seats - taken.size} puestos libres.`);
      const buyerId = crypto.randomUUID(), addedAtIso = new Date().toISOString();
      for (const seat of seats) {
        io.set(db.collection('rouletteSeats').doc(`${r.id}-${seat}`), {
          id: `${r.id}-${seat}`, rouletteId: r.id, seat, buyerId, fullName, socialUser, phone,
          amountCop: r.priceCop, addedAtIso, refundStatus: null
        });
      }
      io.set(rouletteRef(), { occupied: [...r.occupied, ...seats].sort((x, y) => x - y) }, { merge: true });
      return seats;
    });
    res.status(201).json({ ok: true, seats: free, view: await adminRouletteView(await getRoulette()) });
  } catch (err) { if (err.http) return res.status(err.http).json({ error: err.msg }); next(err); }
});

app.delete('/api/admin/roulette/seats/:seat', requireAdmin, async (req, res, next) => {
  try {
    const r = await getRoulette();
    const seat = Number(req.params.seat);
    if (!r || !openStatuses.includes(r.status)) return res.status(409).json({ error: 'Ya no se pueden quitar puestos.' });
    if (!r.occupied.includes(seat)) return res.status(404).json({ error: 'Ese puesto no está ocupado.' });
    await db.collection('rouletteSeats').doc(`${r.id}-${seat}`).delete();
    const occupied = r.occupied.filter(n => n !== seat);
    await rouletteRef().set({ occupied }, { merge: true });
    res.json(await adminRouletteView({ ...r, occupied }));
  } catch (err) { next(err); }
});

async function setRouletteStatus(res, from, to, errMsg, extra = {}) {
  const r = await getRoulette();
  if (!r || r.status !== from) return res.status(409).json({ error: errMsg });
  await rouletteRef().set({ status: to, ...extra }, { merge: true });
  return res.json(await adminRouletteView({ ...r, status: to, ...extra }));
}
app.post('/api/admin/roulette/close', requireAdmin, async (_req, res, next) => {
  try { await setRouletteStatus(res, 'abierta', 'cerrada', 'Las inscripciones ya están cerradas o no hay ruleta.'); } catch (err) { next(err); }
});
app.post('/api/admin/roulette/reopen', requireAdmin, async (_req, res, next) => {
  try { await setRouletteStatus(res, 'cerrada', 'abierta', 'Solo se pueden reabrir inscripciones cerradas.', { closesAtIso: null }); } catch (err) { next(err); }
});

app.post('/api/admin/roulette/spin', requireAdmin, async (_req, res, next) => {
  try {
    const r = await getRoulette();
    if (!r || r.status !== 'cerrada') return res.status(409).json({ error: 'Cierra las inscripciones antes de girar la ruleta.' });
    const pendSpin = (await pendingReservations(r.id)).length;
    if (pendSpin) return res.status(409).json({ error: `Hay ${pendSpin} reserva(s) con comprobante por revisar. Apruébalas o recházalas antes de girar.` });
    if (r.occupied.length < 2) return res.status(409).json({ error: 'Se necesitan al menos 2 puestos ocupados.' });
    if (r.requireMin && rouletteBar(r).state === 'rojo') {
      return res.status(409).json({ error: 'Lo recaudado no llega al valor del premio. Cancela el evento y devuelve el dinero, o desactiva la opción "solo se juega si se alcanza el mínimo".' });
    }
    const winnerSeat = r.occupied[crypto.randomInt(r.occupied.length)];
    const now = Date.now();
    const patch = { status: 'sorteada', winnerSeat, spinVersion: now, spinStartsAtIso: new Date(now + SPIN_LEAD_MS).toISOString(), winnerAtIso: new Date(now).toISOString() };
    await rouletteRef().set(patch, { merge: true });
    const w = (await rouletteSeats(r.id)).find(x => x.seat === winnerSeat) || {};
    // Historial: los datos personales solo los ve el administrador; la página pública recibe puesto, premio y fecha.
    await db.collection('rouletteWinners').doc(r.id).set({
      id: r.id, eventName: r.name, prizeName: r.prizeName, seat: winnerSeat, seatsSold: r.occupied.length,
      winnerAtIso: patch.winnerAtIso, dateBogota: dateInBogota(new Date(now)),
      fullName: w.fullName || '', socialUser: w.socialUser || '', phone: w.phone || '', delivered: false
    });
    res.json(await adminRouletteView({ ...r, ...patch }));
  } catch (err) { next(err); }
});

// Cancelar: todos los puestos pagados pasan a "por devolver".
app.post('/api/admin/roulette/cancel', requireAdmin, async (req, res, next) => {
  try {
    const r = await getRoulette();
    if (!r || !openStatuses.includes(r.status)) return res.status(409).json({ error: 'Solo se puede cancelar una ruleta que aún no se ha sorteado.' });
    const pendCancel = (await pendingReservations(r.id)).length;
    if (pendCancel) return res.status(409).json({ error: `Hay ${pendCancel} reserva(s) con pago por revisar. Apruébalas (para devolverles su dinero) o recházalas antes de cancelar.` });
    const seats = await rouletteSeats(r.id);
    for (const s of seats) await db.collection('rouletteSeats').doc(s.id).set({ refundStatus: 'por_devolver' }, { merge: true });
    const patch = { status: 'cancelada', cancelReason: cleanString(req.body && req.body.reason, 200), cancelledAtIso: new Date().toISOString() };
    await rouletteRef().set(patch, { merge: true });
    res.json(await adminRouletteView({ ...r, ...patch }));
  } catch (err) { next(err); }
});

app.patch('/api/admin/roulette/buyers/:buyerId/refund', requireAdmin, async (req, res, next) => {
  try {
    const r = await getRoulette();
    if (!r || r.status !== 'cancelada') return res.status(409).json({ error: 'Las devoluciones solo aplican a una ruleta cancelada.' });
    if (!/^[0-9a-f-]{36}$/.test(req.params.buyerId)) return res.status(404).json({ error: 'Participante no encontrado.' });
    const mine = (await rouletteSeats(r.id)).filter(s => s.buyerId === req.params.buyerId);
    if (!mine.length) return res.status(404).json({ error: 'Participante no encontrado.' });
    const done = req.body.done === true;
    for (const s of mine) {
      await db.collection('rouletteSeats').doc(s.id).set({ refundStatus: done ? 'devuelto' : 'por_devolver', refundedAtIso: done ? new Date().toISOString() : null }, { merge: true });
    }
    res.json(await adminRouletteView(r));
  } catch (err) { next(err); }
});


// ---- Reservas de puestos hechas por los propios seguidores ----
// El seguidor elige sus puestos (o se le asignan), sube su comprobante y los puestos quedan "apartados"
// hasta que el administrador verifica el pago.
app.post('/api/roulette/reserve', registerLimiter, upload.single('receipt'), async (req, res, next) => {
  try {
    const fullName = cleanString(req.body.fullName, 120);
    const socialUser = cleanString(req.body.socialUser, 80);
    const phone = cleanString(req.body.phone, 10);
    const acceptedTerms = req.body.acceptedTerms === 'on' || req.body.acceptedTerms === 'true';
    const reference = cleanRef(req.body.reference);
    if (reference && reference.length < 4) return res.status(400).json({ error: REF_ERR });
    const wanted = [...new Set(String(req.body.seats || '').split(',').map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n >= 1))];
    const quantity = wanted.length || Math.round(Number(req.body.quantity) || 1);
    if (fullName.length < 3) return res.status(400).json({ error: 'Escribe tu nombre completo.' });
    if (socialUser.length < 2) return res.status(400).json({ error: 'Escribe tu usuario de red social.' });
    if (!validPhone(phone)) return res.status(400).json({ error: 'El celular debe tener exactamente 10 dígitos.' });
    if (!(quantity >= 1 && quantity <= 20)) return res.status(400).json({ error: 'Puedes reservar entre 1 y 20 puestos a la vez.' });
    if (!acceptedTerms) return res.status(400).json({ error: 'Debes aceptar los términos.' });
    if (!req.file) return res.status(400).json({ error: 'Debes adjuntar el comprobante de pago.' });
    if (!matchesSignature(req.file.buffer, req.file.mimetype)) return res.status(400).json({ error: 'El archivo no es un JPG, PNG o PDF válido.' });
    if (req.file.buffer.length > MAX_RECEIPT_BYTES) return res.status(413).json({ error: 'El comprobante pesa demasiado (máximo 800 KB).' });
    const pre = await getRoulette();
    if (!pre || pre.status !== 'abierta') return res.status(409).json({ error: 'Las inscripciones de la ruleta no están abiertas.' });

    const id = crypto.randomUUID();
    const receiptHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const duplicateReceipt = await receiptSeenBefore(receiptHash, reference);
    await db.collection('receipts').doc(id).set({
      id, mimeType: req.file.mimetype, size: req.file.buffer.length, data: req.file.buffer,
      createdDateBogota: dateInBogota(), rouletteId: pre.id, kind: 'ruleta'
    });
    let doc;
    try {
      doc = await rouletteTx(async (r, io) => {
        if (!r || r.status !== 'abierta') throw fail(409, 'Las inscripciones de la ruleta no están abiertas.');
        const taken = new Set([...r.occupied, ...(r.held || [])]);
        const seats = [];
        for (const n of wanted) {
          if (n > r.seats) throw fail(400, `El puesto ${n} no existe.`);
          if (taken.has(n)) throw fail(409, `El puesto ${n} ya fue tomado. Elige otro.`);
          seats.push(n);
        }
        for (let n = 1; n <= r.seats && seats.length < quantity; n++) if (!taken.has(n) && !seats.includes(n)) seats.push(n);
        if (seats.length < quantity) throw fail(409, `Solo quedan ${r.seats - taken.size} puestos disponibles.`);
        seats.sort((x, y) => x - y);
        const d = {
          id, rouletteId: r.id, fullName, socialUser, phone, seats, quantity: seats.length, amountCop: seats.length * r.priceCop,
          receiptHash, reference, duplicateReceipt, receiptMimeType: req.file.mimetype, status: 'pendiente',
          createdAtIso: new Date().toISOString(), termsAccepted: true
        };
        io.set(db.collection('rouletteReservations').doc(id), d);
        io.set(rouletteRef(), { held: [...(r.held || []), ...seats].sort((x, y) => x - y) }, { merge: true });
        return d;
      });
    } catch (e) {
      await db.collection('receipts').doc(id).delete().catch(() => {});
      throw e;
    }
    res.status(201).json({ ok: true, id, seats: doc.seats, amountCop: doc.amountCop,
      message: 'Reserva recibida. Tus puestos quedan apartados mientras verificamos tu pago.' });
  } catch (err) { if (err.http) return res.status(err.http).json({ error: err.msg }); next(err); }
});

async function reviewReservation(req, res, next, approve) {
  try {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'Reserva no encontrada.' });
    await rouletteTx(async (r, io) => {
      const ref = db.collection('rouletteReservations').doc(req.params.id);
      const snap = await io.get(ref);
      if (!snap.exists) throw fail(404, 'Reserva no encontrada.');
      const rv = snap.data();
      if (!r || r.id !== rv.rouletteId) throw fail(409, 'Esta reserva es de una ruleta anterior.');
      if (!openStatuses.includes(r.status)) throw fail(409, 'Esa ruleta ya no está en inscripciones.');
      if (rv.status !== 'pendiente') throw fail(409, 'Esta reserva ya fue revisada.');
      const nowIso = new Date().toISOString();
      const held = (r.held || []).filter(n => !rv.seats.includes(n));
      if (approve) {
        const buyerId = crypto.randomUUID();
        for (const seat of rv.seats) {
          io.set(db.collection('rouletteSeats').doc(`${r.id}-${seat}`), {
            id: `${r.id}-${seat}`, rouletteId: r.id, seat, buyerId, reservationId: rv.id, fullName: rv.fullName, socialUser: rv.socialUser,
            phone: rv.phone, amountCop: r.priceCop, addedAtIso: nowIso, refundStatus: null
          });
        }
        io.set(ref, { status: 'aprobada', buyerId, reviewedAtIso: nowIso }, { merge: true });
        io.set(rouletteRef(), { occupied: [...r.occupied, ...rv.seats].sort((x, y) => x - y), held }, { merge: true });
      } else {
        io.set(ref, { status: 'rechazada', reviewedAtIso: nowIso }, { merge: true });
        io.set(rouletteRef(), { held }, { merge: true });
      }
    });
    res.json(await adminRouletteView(await getRoulette()));
  } catch (err) { if (err.http) return res.status(err.http).json({ error: err.msg }); next(err); }
}
app.post('/api/admin/roulette/reservations/:id/approve', requireStaff, (req, res, next) => reviewReservation(req, res, next, true));
app.post('/api/admin/roulette/reservations/:id/reject', requireStaff, (req, res, next) => reviewReservation(req, res, next, false));

// ---- "Consulta tu participación" (celular + tu número de 5 cifras o tu puesto) ----
const lookupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas consultas. Inténtalo más tarde.' } });
app.post('/api/lookup', lookupLimiter, async (req, res, next) => {
  try {
    const phone = cleanString(req.body.phone, 10), code = cleanString(req.body.code, 5);
    if (!validPhone(phone) || !/^\d{1,5}$/.test(code)) {
      return res.status(400).json({ error: 'Escribe tu celular (10 dígitos) y tu número de 5 cifras o tu número de puesto.' });
    }
    const results = [];
    if (code.length === 5) {
      const snap = await db.collection('registrations').where('phone', '==', phone).limit(100).get();
      snap.docs.map(d => d.data()).filter(d => d.number === code).forEach(d => results.push({
        type: 'quinta', number: d.number, status: d.participationStatus || 'pendiente_verificacion', date: d.createdDateBogota, quintaDate: d.assignedDate, at: d.createdAtIso }));
    } else {
      const n = Number(code), cur = await getRoulette();
      const rs = await db.collection('rouletteReservations').where('phone', '==', phone).limit(100).get();
      rs.docs.map(d => d.data()).filter(d => d.seats.includes(n)).forEach(d => results.push({
        type: 'ruleta', seats: d.seats, status: d.status, current: Boolean(cur && cur.id === d.rouletteId), rouletteStatus: cur && cur.id === d.rouletteId ? cur.status : 'finalizada', at: d.createdAtIso }));
      const ss = await db.collection('rouletteSeats').where('phone', '==', phone).limit(100).get();
      ss.docs.map(d => d.data()).filter(d => d.seat === n && !d.reservationId).forEach(d => results.push({
        type: 'ruleta', seats: [d.seat], status: 'aprobada', current: Boolean(cur && cur.id === d.rouletteId), rouletteStatus: cur && cur.id === d.rouletteId ? cur.status : 'finalizada', refund: d.refundStatus || null, at: d.addedAtIso }));
    }
    results.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    res.json({ results: results.slice(0, 10) });
  } catch (err) { next(err); }
});

// ---- Protección de datos: comprobantes, borrado y respaldo ----
// Al borrar un comprobante se elimina solo la imagen; la huella (hash) queda en el registro y por eso
// sigue detectándose si alguien intenta reutilizar el mismo archivo.
app.post('/api/admin/purge-receipts', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.round(Number(req.body.days));
    if (!(days >= 7 && days <= 365)) return res.status(400).json({ error: 'Elige entre 7 y 365 días.' });
    const cutoff = dateInBogota(new Date(Date.now() - days * 86400000));
    const ev = eventState(await getSettings());
    const rl = await getRoulette();
    let deleted = 0;
    const regs = (await db.collection('registrations').limit(5000).get()).docs.map(d => d.data());
    for (const d of regs) {
      if (d.createdDateBogota < cutoff && !d.receiptPurgedAt && !(ev.active && d.eventId === ev.id)) {
        await db.collection('receipts').doc(d.id).delete();
        await db.collection('registrations').doc(d.id).set({ receiptPurgedAt: new Date().toISOString() }, { merge: true });
        deleted++;
      }
    }
    const rvs = (await db.collection('rouletteReservations').limit(5000).get()).docs.map(d => d.data());
    for (const d of rvs) {
      const day = String(d.createdAtIso || '').slice(0, 10);
      const live = rl && openStatuses.includes(rl.status) && d.rouletteId === rl.id;
      if (day && day < cutoff && !d.receiptPurgedAt && !live) {
        await db.collection('receipts').doc(d.id).delete();
        await db.collection('rouletteReservations').doc(d.id).set({ receiptPurgedAt: new Date().toISOString() }, { merge: true });
        deleted++;
      }
    }
    const dns = (await db.collection('donations').limit(5000).get()).docs.map(d => d.data());
    for (const d of dns) {
      const day = String(d.createdAtIso || '').slice(0, 10);
      if (day && day < cutoff && d.hasReceipt && !d.receiptPurgedAt) {
        await db.collection('receipts').doc(d.id).delete();
        await db.collection('donations').doc(d.id).set({ receiptPurgedAt: new Date().toISOString() }, { merge: true });
        deleted++;
      }
    }
    res.json({ ok: true, deleted, cutoff });
  } catch (err) { next(err); }
});

// Derecho de supresión (Ley 1581): anonimiza todo lo asociado a un celular y borra sus comprobantes.
app.post('/api/admin/person/erase', requireAdmin, async (req, res, next) => {
  try {
    const phone = cleanString(req.body.phone, 10);
    if (!validPhone(phone)) return res.status(400).json({ error: 'Escribe el celular de 10 dígitos.' });
    const cleared = { fullName: '(eliminado)', socialUser: '', phone: '', erasedAt: new Date().toISOString() };
    let records = 0, receipts = 0;
    for (const name of ['registrations', 'rouletteReservations', 'rouletteSeats', 'rouletteWinners', 'donations']) {
      const snap = await db.collection(name).where('phone', '==', phone).limit(1000).get();
      for (const d of snap.docs.map(x => x.data())) {
        await db.collection(name).doc(d.id).set(name === 'donations' ? { alias: '(eliminado)', phone: '', erasedAt: cleared.erasedAt } : cleared, { merge: true });
        records++;
        if (name === 'registrations' || name === 'rouletteReservations' || name === 'donations') {
          await db.collection('receipts').doc(d.id).delete(); receipts++;
          await db.collection(name).doc(d.id).set({ receiptPurgedAt: cleared.erasedAt }, { merge: true });
        }
      }
    }
    await recomputeGoal();
    res.json({ ok: true, records, receipts });
  } catch (err) { next(err); }
});

app.get('/api/admin/backup.json', requireAdmin, async (_req, res, next) => {
  try {
    const out = { generatedAtIso: new Date().toISOString(), note: 'Copia sin imágenes de comprobantes ni contraseñas.' };
    for (const name of ['registrations', 'rouletteSeats', 'rouletteReservations', 'rouletteWinners', 'rouletteHistory', 'events', 'winners', 'donations']) {
      out[name] = (await db.collection(name).limit(5000).get()).docs.map(d => d.data());
    }
    const cur = await db.collection('roulette').doc('current').get();
    out.rouletteCurrent = cur.exists ? cur.data() : null;
    out.community = await getCommunity();
    const { passwordSalt, passwordHash, ...safe } = await getSettings();
    out.settings = safe;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="respaldo-${dateInBogota()}.json"`);
    res.send(JSON.stringify(out, null, 1));
  } catch (err) { next(err); }
});

// ---- Reportes: recaudo por evento y por mes ----
app.get('/api/admin/report', requireAdmin, async (_req, res, next) => {
  try {
    const regs = (await db.collection('registrations').limit(5000).get()).docs.map(d => d.data());
    const evs = (await db.collection('events').limit(300).get()).docs.map(d => d.data());
    const byEvent = new Map();
    for (const r of regs) {
      const k = r.eventId || 'sin-evento';
      if (!byEvent.has(k)) byEvent.set(k, { registrations: 0, accepted: 0, acceptedCop: 0 });
      const e = byEvent.get(k); e.registrations++;
      if (r.participationStatus === 'aceptada') { e.accepted++; e.acceptedCop += r.amountCop || 0; }
    }
    const quinta = evs.sort((a, b) => String(b.startIso).localeCompare(String(a.startIso))).map(e => ({
      id: e.id, startIso: e.startIso, quintaDate: e.quintaDate, ...(byEvent.get(e.id) || { registrations: 0, accepted: 0, acceptedCop: 0 }) }));
    const cur = await db.collection('roulette').doc('current').get();
    const hist = (await db.collection('rouletteHistory').limit(300).get()).docs.map(d => d.data());
    const ruleta = [...(cur.exists ? [cur.data()] : []), ...hist].sort((a, b) => String(b.createdAtIso).localeCompare(String(a.createdAtIso))).map(r => {
      const collectedCop = (r.occupied || []).length * r.priceCop;
      const played = r.status === 'sorteada';
      return { id: r.id, name: r.name, status: r.status, createdAtIso: r.createdAtIso, seatsSold: (r.occupied || []).length, seatsTotal: r.seats,
        collectedCop, prizeValueCop: r.prizeValueCop, resultCop: played ? collectedCop - r.prizeValueCop : null };
    });
    const months = {};
    for (const e of quinta) { const m = String(e.quintaDate || '').slice(0, 7); if (m) { months[m] = months[m] || { month: m, quintaCop: 0, ruletaCop: 0 }; months[m].quintaCop += e.acceptedCop; } }
    for (const r of ruleta) { const m = String(r.createdAtIso || '').slice(0, 7); if (m && r.status === 'sorteada') { months[m] = months[m] || { month: m, quintaCop: 0, ruletaCop: 0 }; months[m].ruletaCop += r.resultCop; } }
    res.json({ quinta, ruleta, months: Object.values(months).sort((a, b) => b.month.localeCompare(a.month)) });
  } catch (err) { next(err); }
});


// ---- Comunidad: creadores, meta de donaciones y clips (portada) ----
const communityRef = db.collection('community').doc('current');
async function getCommunity() { const s = await communityRef.get(); return s.exists ? s.data() : {}; }
async function saveCommunity(mut) { const c = await getCommunity(); const out = mut(c) || c; await communityRef.set(out); return out; }
const MAX_CREATORS = 6, MAX_CLIPS = 12, MAX_DONATION = 1000000000, MIN_DONATION = 1; // la donación es libre: solo debe ser un valor positivo
const communityLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });
const donateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados envíos desde esta conexión. Inténtalo más tarde.' } });

// Convierte un enlace de YouTube, TikTok o Instagram en su dirección de inserción (lista cerrada de sitios).
function parseClip(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^(www|m)\./, '');
  const path = u.pathname;
  let m;
  if (host === 'youtu.be') { m = path.match(/^\/([\w-]{11})$/); if (m) return yt(m[1], false); }
  if (host === 'youtube.com') {
    if (path === '/watch') { const v = u.searchParams.get('v') || ''; if (/^[\w-]{11}$/.test(v)) return yt(v, false); }
    m = path.match(/^\/(shorts|live|embed)\/([\w-]{11})$/); if (m) return yt(m[2], m[1] === 'shorts');
  }
  if (host === 'tiktok.com') {
    m = path.match(/^\/@[\w.-]+\/video\/(\d{8,25})$/);
    if (m) return { platform: 'TikTok', embed: `https://www.tiktok.com/embed/v2/${m[1]}`, thumb: '', vertical: true };
  }
  if (host === 'instagram.com') {
    m = path.match(/^\/(?:[\w.]+\/)?(reel|p)\/([\w-]{5,20})\/?$/);
    if (m) return { platform: 'Instagram', embed: `https://www.instagram.com/${m[1]}/${m[2]}/embed`, thumb: '', vertical: true };
  }
  return null;
  function yt(id, vertical) {
    return { platform: 'YouTube', embed: `https://www.youtube-nocookie.com/embed/${id}`, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, vertical };
  }
}
// Aviso "en vivo" y agenda de próximos directos.
function publicLive(l) { return l && l.on && l.url ? { title: l.title || '', url: l.url } : null; }
function upcomingAgenda(list) {
  const min = Date.now() - 2 * 3600e3; // un directo sigue visible 2 horas después de empezar
  return (list || []).filter(a => Date.parse(a.whenIso) >= min).sort((a, b) => a.whenIso.localeCompare(b.whenIso))
    .map(a => ({ id: a.id, title: a.title, note: a.note || '', whenIso: a.whenIso }));
}
function publicCreator(c) { return { id: c.id, name: c.name, role: c.role || '', bio: c.bio || '', links: c.links || [], imageVersion: c.imageVersion || null }; }
function publicGoal(g) {
  if (!g || !g.id) return null;
  return { id: g.id, title: g.title, description: g.description || '', targetCop: g.targetCop, raisedCop: g.raisedCop || 0,
    donationsCount: g.donationsCount || 0, imageVersion: g.imageVersion || null, reached: (g.raisedCop || 0) >= g.targetCop };
}
// Recalcula lo recaudado de la meta actual y el ranking del mes a partir de las donaciones verificadas.
async function recomputeGoal() {
  const c = await getCommunity();
  const all = (await db.collection('donations').limit(5000).get()).docs.map(d => d.data()).filter(d => d.status === 'verificada');
  if (c.goal && c.goal.id) {
    const ok = all.filter(d => d.goalId === c.goal.id).sort((a, b) => String(b.verifiedAtIso).localeCompare(String(a.verifiedAtIso)));
    const raised = ok.reduce((t, d) => t + d.amountCop, 0);
    c.goal.raisedCop = raised; c.goal.donationsCount = ok.length;
    if (raised >= c.goal.targetCop && !c.goal.reachedAtIso) c.goal.reachedAtIso = new Date().toISOString();
    if (raised < c.goal.targetCop) c.goal.reachedAtIso = null;
    c.recent = ok.slice(0, 8).map(d => ({ id: d.id, name: d.alias, amountCop: d.amountCop, atIso: d.verifiedAtIso }));
  } else c.recent = [];
  // Quienes más aportaron este mes (se agrupa por el nombre que cada donante eligió mostrar).
  const month = dateInBogota().slice(0, 7), tot = new Map();
  for (const d of all) {
    if (dateInBogota(new Date(d.verifiedAtIso || d.createdAtIso)).slice(0, 7) !== month) continue;
    const n = d.alias; if (!n || n === 'Un seguidor' || n === '(eliminado)') continue;
    const k = n.toLowerCase(), e = tot.get(k) || { name: n, amountCop: 0 }; e.amountCop += d.amountCop; tot.set(k, e);
  }
  c.topMonth = { month, list: [...tot.values()].sort((a, b) => b.amountCop - a.amountCop).slice(0, 5) };
  await communityRef.set(c);
}
// Si la meta se logró, pasa a "Metas logradas" (con su foto) antes de reemplazarla o quitarla.
async function archiveGoalIfReached(c) {
  const g = c.goal;
  if (!g || !g.id || (g.raisedCop || 0) < g.targetCop) return;
  let imageVersion = null;
  const im = await db.collection('communityImages').doc('goal').get();
  if (im.exists) { await db.collection('communityImages').doc(g.id).set(im.data()); imageVersion = im.data().version || Date.now(); }
  c.pastGoals = [{ id: g.id, title: g.title, targetCop: g.targetCop, raisedCop: g.raisedCop, donationsCount: g.donationsCount || 0,
    reachedAtIso: g.reachedAtIso || new Date().toISOString(), imageVersion }, ...(c.pastGoals || [])].slice(0, 24);
}
function publicPast(p) { return { id: p.id, title: p.title, targetCop: p.targetCop, raisedCop: p.raisedCop, donationsCount: p.donationsCount || 0, reachedAtIso: p.reachedAtIso, imageVersion: p.imageVersion || null }; }

app.get('/api/community', communityLimiter, async (_req, res, next) => {
  try {
    const c = await getCommunity();
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5');
    res.json({
      creators: (c.creators || []).map(publicCreator),
      goal: publicGoal(c.goal),
      recent: c.recent || [],
      live: publicLive(c.live),
      agenda: upcomingAgenda(c.agenda),
      top: c.topMonth && c.topMonth.month === dateInBogota().slice(0, 7) ? c.topMonth.list : [],
      pastGoals: (c.pastGoals || []).slice(0, 12).map(publicPast),
      serverNowIso: new Date().toISOString(),
      clips: (c.clips || []).map(k => ({ id: k.id, creatorId: k.creatorId || null, title: k.title, platform: k.platform, url: k.url || '', embed: k.embed, thumb: k.thumb || '', vertical: Boolean(k.vertical) }))
    });
  } catch (err) { next(err); }
});

app.get('/api/community-image/:key', async (req, res, next) => {
  try {
    if (!/^(goal|[0-9a-f-]{36})$/.test(req.params.key)) return res.status(404).end();
    const snap = await db.collection('communityImages').doc(req.params.key).get();
    if (!snap.exists) return res.status(404).end();
    const d = snap.data();
    res.setHeader('Content-Type', d.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(d.data));
  } catch (err) { next(err); }
});

// Donación libre a la meta: no participa en ningún sorteo y no lleva número.
app.post('/api/donate', donateLimiter, upload.single('receipt'), async (req, res, next) => {
  try {
    const c = await getCommunity();
    if (!c.goal || !c.goal.id) return res.status(409).json({ error: 'Por ahora no hay una meta de donaciones activa.' });
    const alias = cleanString(req.body.alias, 30) || 'Un seguidor';
    const amountCop = Math.round(Number(req.body.amountCop));
    const accepted = req.body.acceptedTerms === 'on' || req.body.acceptedTerms === 'true';
    const reference = cleanRef(req.body.reference);
    const phone = cleanString(req.body.phone, 10);
    if (reference && reference.length < 4) return res.status(400).json({ error: REF_ERR });
    if (phone && !validPhone(phone)) return res.status(400).json({ error: 'El celular debe tener 10 dígitos (o déjalo vacío).' });
    if (!(amountCop >= MIN_DONATION && amountCop <= MAX_DONATION)) return res.status(400).json({ error: 'Escribe cuánto quieres donar (un número mayor que cero).' });
    if (!accepted) return res.status(400).json({ error: 'Debes confirmar que tu donación es voluntaria.' });
    if (!req.file) return res.status(400).json({ error: 'Adjunta el comprobante de pago.' });
    if (!matchesSignature(req.file.buffer, req.file.mimetype)) return res.status(400).json({ error: 'El archivo no es un JPG, PNG o PDF válido.' });
    if (req.file.buffer.length > MAX_RECEIPT_BYTES) return res.status(413).json({ error: 'El comprobante pesa demasiado (máximo 800 KB).' });
    const id = crypto.randomUUID();
    const receiptHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const seenBefore = await receiptSeenBefore(receiptHash, reference);
    await db.collection('receipts').doc(id).set({
      id, mimeType: req.file.mimetype, size: req.file.buffer.length, data: req.file.buffer,
      createdDateBogota: dateInBogota(), kind: 'donacion'
    });
    await db.collection('donations').doc(id).set({
      id, goalId: c.goal.id, alias, amountCop, phone, reference, status: 'pendiente', manual: false,
      createdAtIso: new Date().toISOString(), hasReceipt: true, receiptHash, duplicateReceipt: seenBefore,
      receiptMimeType: req.file.mimetype
    });
    res.status(201).json({ id, message: 'Recibimos tu donación. Se suma a la barra cuando verifiquemos el pago.' });
  } catch (err) { next(err); }
});

// ---- Administración de la portada ----
function donationView(d) {
  return { id: d.id, alias: d.alias, amountCop: d.amountCop, status: d.status, manual: Boolean(d.manual), createdAtIso: d.createdAtIso,
    hasReceipt: Boolean(d.hasReceipt), receiptPurged: Boolean(d.receiptPurgedAt), duplicateReceipt: Boolean(d.duplicateReceipt), goalId: d.goalId,
    phone: d.phone || '', reference: d.reference || '' };
}
app.get('/api/admin/community', requireStaff, async (_req, res, next) => {
  try {
    const c = await getCommunity();
    const snap = await db.collection('donations').limit(5000).get();
    const donations = snap.docs.map(d => d.data()).sort((a, b) => String(b.createdAtIso).localeCompare(String(a.createdAtIso))).slice(0, 300).map(donationView);
    res.json({ creators: (c.creators || []).map(publicCreator), goal: publicGoal(c.goal), clips: c.clips || [], donations, pastGoals: (c.pastGoals || []).map(publicPast),
      live: c.live || { on: false, url: '', title: '' }, agenda: (c.agenda || []).slice().sort((a, b) => a.whenIso.localeCompare(b.whenIso)) });
  } catch (err) { next(err); }
});

app.put('/api/admin/community/creators', requireAdmin, async (req, res, next) => {
  try {
    const list = Array.isArray(req.body.creators) ? req.body.creators.slice(0, MAX_CREATORS) : [];
    const out = [];
    for (const raw of list) {
      const name = cleanString(raw && raw.name, 60);
      if (!name) return res.status(400).json({ error: 'Cada creador necesita un nombre.' });
      const id = /^[0-9a-f-]{36}$/.test(raw.id || '') ? raw.id : crypto.randomUUID();
      const links = [];
      for (const l of (Array.isArray(raw.links) ? raw.links.slice(0, 6) : [])) {
        const label = cleanString(l && l.label, 30), url = safeUrl(l && l.url);
        if (!label && !(l && l.url)) continue;
        if (!label || !url) return res.status(400).json({ error: `En "${name}", cada enlace necesita un nombre y una dirección que empiece por https://` });
        links.push({ label, url });
      }
      out.push({ id, name, role: cleanString(raw.role, 60), bio: cleanString(raw.bio, 400), links });
    }
    const c = await getCommunity();
    const prev = new Map((c.creators || []).map(x => [x.id, x]));
    for (const x of out) x.imageVersion = (prev.get(x.id) || {}).imageVersion || null;
    for (const x of c.creators || []) if (!out.some(o => o.id === x.id)) await db.collection('communityImages').doc(x.id).delete();
    c.creators = out;
    const removed = new Set((c.clips || []).map(k => k.creatorId).filter(id => id && !out.some(o => o.id === id)));
    if (removed.size) c.clips = c.clips.map(k => removed.has(k.creatorId) ? { ...k, creatorId: null } : k);
    await communityRef.set(c);
    res.json({ ok: true, creators: out.map(publicCreator) });
  } catch (err) { next(err); }
});

function parseGoalBody(b) {
  const title = cleanString(b.title, 80), description = cleanString(b.description, 300);
  const targetCop = Math.round(Number(b.targetCop));
  if (title.length < 2) return { error: 'Escribe el nombre de la meta (ej. Silla gamer).' };
  if (!(targetCop >= 10000 && targetCop <= 1000000000)) return { error: 'Escribe el valor de la meta (mínimo $10.000).' };
  return { title, description, targetCop };
}
app.put('/api/admin/community/goal', requireAdmin, async (req, res, next) => {
  try {
    const g = parseGoalBody(req.body); if (g.error) return res.status(400).json({ error: g.error });
    await saveCommunity(c => {
      c.goal = c.goal && c.goal.id ? { ...c.goal, ...g } : { id: crypto.randomUUID(), ...g, raisedCop: 0, donationsCount: 0, imageVersion: null, createdAtIso: new Date().toISOString() };
    });
    await recomputeGoal();
    res.json({ ok: true, goal: publicGoal((await getCommunity()).goal) });
  } catch (err) { next(err); }
});
// Nueva meta: el contador vuelve a cero (las donaciones anteriores se conservan en su meta).
app.post('/api/admin/community/goal/new', requireAdmin, async (req, res, next) => {
  try {
    const g = parseGoalBody(req.body); if (g.error) return res.status(400).json({ error: g.error });
    const cur = await getCommunity();
    await archiveGoalIfReached(cur); await communityRef.set(cur);
    await db.collection('communityImages').doc('goal').delete();
    await saveCommunity(c => { c.goal = { id: crypto.randomUUID(), ...g, raisedCop: 0, donationsCount: 0, imageVersion: null, createdAtIso: new Date().toISOString() }; });
    await recomputeGoal();
    res.json({ ok: true, goal: publicGoal((await getCommunity()).goal) });
  } catch (err) { next(err); }
});
app.delete('/api/admin/community/goal', requireAdmin, async (_req, res, next) => {
  try {
    const cur = await getCommunity();
    await archiveGoalIfReached(cur); await communityRef.set(cur);
    await db.collection('communityImages').doc('goal').delete();
    await saveCommunity(c => { c.goal = null; c.recent = []; });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/admin/community/image/:key', requireAdmin, upload.single('image'), async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!/^(goal|[0-9a-f-]{36})$/.test(key)) return res.status(404).json({ error: 'Imagen no válida.' });
    if (!req.file) return res.status(400).json({ error: 'Selecciona una imagen.' });
    if (!['image/jpeg', 'image/png'].includes(req.file.mimetype) || !matchesSignature(req.file.buffer, req.file.mimetype)) return res.status(400).json({ error: 'La imagen debe ser JPG o PNG.' });
    if (req.file.buffer.length > MAX_RECEIPT_BYTES) return res.status(413).json({ error: 'La imagen pesa demasiado (máximo 800 KB).' });
    const version = Date.now();
    let found = true;
    await saveCommunity(c => {
      if (key === 'goal') { if (c.goal && c.goal.id) c.goal.imageVersion = version; else found = false; }
      else { const cr = (c.creators || []).find(x => x.id === key), pg = (c.pastGoals || []).find(x => x.id === key); if (cr) cr.imageVersion = version; else if (pg) pg.imageVersion = version; else found = false; }
    });
    if (!found) return res.status(404).json({ error: key === 'goal' ? 'Primero guarda la meta.' : 'Primero guarda al creador.' });
    await db.collection('communityImages').doc(key).set({ mimeType: req.file.mimetype, data: req.file.buffer, version });
    res.json({ ok: true, version });
  } catch (err) { next(err); }
});
app.delete('/api/admin/community/image/:key', requireAdmin, async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!/^(goal|[0-9a-f-]{36})$/.test(key)) return res.status(404).json({ error: 'Imagen no válida.' });
    await db.collection('communityImages').doc(key).delete();
    await saveCommunity(c => {
      if (key === 'goal') { if (c.goal) c.goal.imageVersion = null; }
      else { const cr = (c.creators || []).find(x => x.id === key), pg = (c.pastGoals || []).find(x => x.id === key); if (cr) cr.imageVersion = null; else if (pg) pg.imageVersion = null; }
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.delete('/api/admin/community/past/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'Meta no encontrada.' });
    await db.collection('communityImages').doc(req.params.id).delete();
    await saveCommunity(c => { c.pastGoals = (c.pastGoals || []).filter(p => p.id !== req.params.id); });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
app.post('/api/admin/community/clips', requireAdmin, async (req, res, next) => {
  try {
    const title = cleanString(req.body.title, 80);
    const info = parseClip(req.body.url);
    if (title.length < 2) return res.status(400).json({ error: 'Escribe un título para el clip.' });
    if (!info) return res.status(400).json({ error: 'Pega un enlace de YouTube (video o short), TikTok (de un video) o Instagram (reel o publicación).' });
    const c = await getCommunity();
    if ((c.clips || []).length >= MAX_CLIPS) return res.status(409).json({ error: `Máximo ${MAX_CLIPS} clips. Elimina alguno para agregar otro.` });
    const creatorId = (c.creators || []).some(x => x.id === req.body.creatorId) ? req.body.creatorId : null;
    const clip = { id: crypto.randomUUID(), creatorId, title, url: safeUrl(req.body.url), ...info, createdAtIso: new Date().toISOString() };
    c.clips = [clip, ...(c.clips || [])];
    await communityRef.set(c);
    res.status(201).json({ ok: true, clip });
  } catch (err) { next(err); }
});
app.delete('/api/admin/community/clips/:id', requireAdmin, async (req, res, next) => {
  try {
    await saveCommunity(c => { c.clips = (c.clips || []).filter(k => k.id !== req.params.id); });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.put('/api/admin/community/live', requireAdmin, async (req, res, next) => {
  try {
    const on = Boolean(req.body.on), title = cleanString(req.body.title, 80), url = safeUrl(req.body.url);
    if (on && !url) return res.status(400).json({ error: 'Pega el enlace de tu transmisión (que empiece por https://) para activar el aviso.' });
    await saveCommunity(c => { c.live = { on, title, url }; });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
app.put('/api/admin/community/agenda', requireAdmin, async (req, res, next) => {
  try {
    const list = Array.isArray(req.body.agenda) ? req.body.agenda.slice(0, 8) : [];
    const out = [];
    for (const a of list) {
      const title = cleanString(a && a.title, 80), t = Date.parse(a && a.whenIso), whenIso = Number.isNaN(t) ? '' : new Date(t).toISOString();
      if (!title && !(a && a.whenIso)) continue;
      if (title.length < 2 || !whenIso) return res.status(400).json({ error: 'Cada directo necesita un título y una fecha y hora.' });
      out.push({ id: /^[0-9a-f-]{36}$/.test(a.id || '') ? a.id : crypto.randomUUID(), title, note: cleanString(a.note, 120), whenIso });
    }
    await saveCommunity(c => { c.agenda = out; });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.patch('/api/admin/donations/:id', requireStaff, async (req, res, next) => {
  try {
    const status = req.body.status;
    if (!['pendiente', 'verificada', 'rechazada'].includes(status)) return res.status(400).json({ error: 'Estado inválido.' });
    const ref = db.collection('donations').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Donación no encontrada.' });
    const d = snap.data();
    await ref.set({ status, verifiedAtIso: status === 'verificada' ? new Date().toISOString() : null }, { merge: true });
    await recomputeGoal();
    res.json({ ok: true });
  } catch (err) { next(err); }
});
// Donación recibida por otra vía (efectivo, otro banco): se registra ya verificada.
app.post('/api/admin/donations', requireAdmin, async (req, res, next) => {
  try {
    const c = await getCommunity();
    if (!c.goal || !c.goal.id) return res.status(409).json({ error: 'Primero crea una meta.' });
    const alias = cleanString(req.body.alias, 30) || 'Un seguidor';
    const amountCop = Math.round(Number(req.body.amountCop));
    if (!(amountCop >= MIN_DONATION && amountCop <= MAX_DONATION)) return res.status(400).json({ error: 'Escribe cuánto quieres donar (un número mayor que cero).' });
    const id = crypto.randomUUID(), now = new Date().toISOString();
    await db.collection('donations').doc(id).set({ id, goalId: c.goal.id, alias, amountCop, status: 'verificada', manual: true, createdAtIso: now, verifiedAtIso: now, hasReceipt: false });
    await recomputeGoal();
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// ---- Enlaces cortos para decir en voz alta en los lives, y QR público (solo de las páginas del sitio) ----
const SHORT = { q: '/quinta.html', r: '/ruleta.html', d: '/#donar', c: '/consulta.html' };
app.get('/:k(q|r|d|c)', (req, res) => res.redirect(302, SHORT[req.params.k]));
const QR_TARGETS = { home: '/', quinta: '/quinta.html', ruleta: '/ruleta.html', donar: '/#donar' };
app.get('/api/qr.png', async (req, res, next) => {
  try {
    const path_ = QR_TARGETS[req.query.to] || '/';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const QRCode = require('qrcode');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(await QRCode.toBuffer(`https://${host}${path_}`, { errorCorrectionLevel: 'H', margin: 2, width: 700, color: { dark: '#1a1446', light: '#ffffff' } }));
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

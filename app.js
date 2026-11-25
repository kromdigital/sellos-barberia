import { db, auth } from './firebase.js';
import { doc, getDoc, setDoc, onSnapshot, collection, runTransaction }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const digits = s => s.replace(/\D/g, '');
const today = () => new Date().toLocaleDateString('es-MX');
const say = (sel, text, ok) => { const el = $(sel); el.textContent = text; el.classList.toggle('ok', !!ok); };
const errText = e => e.code === 'permission-denied' ? 'No tienes permiso para hacer esto.'
  : e.code === 'unavailable' ? 'Sin conexión. Inténtalo de nuevo.' : (e.message || 'Ocurrió un error.');

const SERVICES = 'Corte clásico | 150 | Tijera o máquina, con acabado a navaja\nCorte y barba | 220 | El paquete completo, perfilado incluido\nAfeitado con toalla caliente | 130 | Navaja, vapor y bálsamo\nDiseño y perfilado | 100 | Líneas, cejas y detalles';
const DEFAULTS = { shop: 'Tu Barbería', goal: 8, reward: 'Corte gratis', promo: 'Martes de barba 2x1.',
  whatsapp: '', address: '', instagram: '', open: 10, close: 20, sunday: false, services: SERVICES };

/* Barbería activa: viene del enlace (?b=nombre-de-la-barberia) y se recuerda en el dispositivo */
let shopId = (new URLSearchParams(location.search).get('b') || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
try { if (shopId) localStorage.setItem('shop', shopId); else shopId = localStorage.getItem('shop') || ''; } catch {}
const K = k => `${k}_${shopId}`;   // llaves de localStorage separadas por barbería
const LEVELS = [[10, 'VIP'], [4, 'Frecuente'], [0, 'Nuevo']];
const cref = p => doc(db, 'shops', shopId, 'clients', p);

let cfg = { ...DEFAULTS };
let me = ''; try { me = localStorage.getItem(K('me_phone')) || ''; } catch {}
let card = null;       // tarjeta del cliente (en vivo)
let clients = [];      // lista de clientes (solo barbero, en vivo)
let user = null;
let unsubCard = null, unsubList = null, scanner = null;

/* ---------- Navegación ---------- */
// El ícono de la pestaña, el color del navegador y el título cambian en el panel del barbero
const ICON_SETS = {
  cliente: ['favicon.svg', 'img/favicon-32.png', 'img/apple-touch-icon.png', '#0b1626'],
  panel: ['favicon-panel.svg', 'img/favicon-panel-32.png', 'img/apple-touch-icon-panel.png', '#070d17']
};
function setIcons(kind) {
  const [svg, png, apple, color] = ICON_SETS[kind];
  $('#icoSvg').href = svg; $('#icoPng').href = png; $('#icoApple').href = apple;
  document.querySelector('meta[name=theme-color]').content = color;
}
function setTitle() {
  document.title = (location.hash === '#panel' ? 'Panel del barbero | ' : 'Tarjeta de sellos | ') + cfg.shop;
}

function route() {
  const v = (location.hash || '#inicio').slice(1);
  const id = ['inicio', 'tarjeta', 'panel'].includes(v) ? v : 'inicio';
  document.querySelectorAll('.view').forEach(s => s.hidden = s.id !== id);
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.hash === '#' + id));
  if (id !== 'panel') stopScan();
  setIcons(id === 'panel' ? 'panel' : 'cliente'); setTitle();
  window.scrollTo(0, 0);
}
const sv = p => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  tijeras: { label: 'Tijeras', svg: sv('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.5 7.5 20 19M8.5 16.5 20 5"/>') },
  peine:   { label: 'Peine', svg: sv('<rect x="3" y="5" width="18" height="6" rx="2"/><path d="M6 11v7M10 11v7M14 11v7M18 11v7"/>') },
  bigote:  { label: 'Bigote', svg: sv('<path d="M12 12c-1.5-2.5-3.5-3.5-6-3-2.5.5-4 2.5-4 5 2.5-1.5 5-1 7 .5 1.2.9 2 1.5 3 2.5 1-1 1.8-1.6 3-2.5 2-1.5 4.5-2 7-.5 0-2.5-1.5-4.5-4-5-2.5-.5-4.5.5-6 3z"/>') },
  poste:   { label: 'Poste de barbero', svg: sv('<rect x="8" y="4" width="8" height="16" rx="3"/><path d="M8 9l8 3M8 14l8 3M10 2h4M10 22h4"/>') }
};
// El ícono elegido se guarda en este dispositivo
const iconOf = p => { let k = ''; try { k = localStorage.getItem(K('icon_' + p)) || ''; } catch {} return ICONS[k] ? k : 'tijeras'; };

/* Horario de la barbería (se edita desde el panel) */
const schedule = () => cfg.sunday
  ? [{ label: 'Todos los días', days: [0, 1, 2, 3, 4, 5, 6], open: cfg.open, close: cfg.close }]
  : [{ label: 'Lunes a sábado', days: [1, 2, 3, 4, 5, 6], open: cfg.open, close: cfg.close }, { label: 'Domingo', days: [0] }];
const DIAS = ['el domingo', 'el lunes', 'el martes', 'el miércoles', 'el jueves', 'el viernes', 'el sábado'];
const fmt = h => String(h).padStart(2, '0') + ':00';
const slot = d => schedule().find(s => s.days.includes(d) && s.open != null);

function openState() {
  const now = new Date(), t = now.getHours() + now.getMinutes() / 60, s = slot(now.getDay());
  if (s && t >= s.open && t < s.close) return [true, `Abierto ahora · cierra a las ${fmt(s.close)}`];
  for (let i = 0; i < 7; i++) {
    const d = (now.getDay() + i) % 7, n = slot(d);
    if (n && (i > 0 || t < n.open)) return [false, `Cerrado · abre ${i === 0 ? 'hoy' : i === 1 ? 'mañana' : DIAS[d]} a las ${fmt(n.open)}`];
  }
  return [false, 'Cerrado'];
}
function paintHome() {
  const [open, text] = openState(), chip = $('#openNow');
  chip.textContent = text; chip.classList.toggle('open', open);
  $('#hours').innerHTML = schedule().map(s =>
    `<li><span>${s.label}</span><b>${s.open != null ? fmt(s.open) + ' – ' + fmt(s.close) : 'Cerrado'}</b></li>`).join('');
  $('#heroLead').textContent = `Junta ${cfg.goal} sellos y gana: ${cfg.reward}.`;
  const wa = cfg.whatsapp ? 'https://wa.me/' + digits(cfg.whatsapp) : '';
  document.querySelectorAll('.wa').forEach(a => { a.hidden = !wa; if (wa) a.href = wa; });
  const link = (u, t) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`;
  $('#contact').innerHTML = [
    ['Dirección', cfg.address && esc(cfg.address)],
    ['WhatsApp', wa && link(wa, cfg.whatsapp)],
    ['Instagram', cfg.instagram && link('https://instagram.com/' + cfg.instagram.replace('@', ''), cfg.instagram)]
  ].filter(r => r[1]).map(r => `<li><span>${r[0]}</span><b>${r[1]}</b></li>`).join('') || '<li><span>Pronto más datos de contacto.</span></li>';
  $('#svc').innerHTML = cfg.services.split('\n').map(l => l.split('|').map(x => x.trim())).filter(p => p[0]).map(p =>
    `<li><div><b>${esc(p[0])}</b>${p[2] ? `<small>${esc(p[2])}</small>` : ''}</div>` +
    (p[1] ? `<span class="price">${esc(p[1].startsWith('$') ? p[1] : '$' + p[1])}</span>` : '') + '</li>').join('');
}
setInterval(paintHome, 60000);

function brand() {
  $('#brandName').textContent = cfg.shop;
  setTitle();
  paintHome();
}

/* La tarjeta se inclina un poco con el cursor (solo en pantallas con mouse) */
const mem = $('#member');
if (matchMedia('(hover:hover) and (prefers-reduced-motion:no-preference)').matches) {
  mem.addEventListener('pointermove', e => {
    const r = mem.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    mem.style.setProperty('--rx', ((.5 - y) * 8) + 'deg');
    mem.style.setProperty('--ry', ((x - .5) * 10) + 'deg');
    mem.style.setProperty('--mx', (x * 100) + '%');
    mem.style.setProperty('--my', (y * 100) + '%');
  });
  mem.addEventListener('pointerleave', () => { mem.style.setProperty('--rx', '0deg'); mem.style.setProperty('--ry', '0deg'); });
}

$('#iconPicker').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]');
  if (!b || !card) return;
  try { localStorage.setItem(K('icon_' + card.phone), b.dataset.i); } catch {}
  renderCard();
});

/* ---------- Configuración (en vivo) ---------- */
let unsubShop = null;
function watchShop() {
  if (unsubShop) unsubShop();
  unsubShop = null; cfg = { ...DEFAULTS };
  if (shopId) unsubShop = onSnapshot(doc(db, 'shops', shopId), s => {
    cfg = { ...DEFAULTS, ...(s.exists() ? s.data() : {}) };
    brand(); renderCard(); renderPanel();
  }, () => {});
  brand(); renderCard(); renderPanel();
}

/* ---------- Cliente: mi tarjeta ---------- */
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const p = digits($('#phone').value), n = $('#name').value.trim();
  if (p.length < 10) return say('#cardMsg', 'Escribe tu número a 10 dígitos.');
  if (!shopId) return say('#cardMsg', 'Abre el enlace de tu barbería para ver tu tarjeta.');
  try {
    const s = await getDoc(cref(p));
    if (!s.exists()) {
      if (!n) { $('#nameWrap').hidden = false; $('#name').focus(); return say('#cardMsg', 'Eres nuevo: escribe tu nombre para crear tu tarjeta.'); }
      await setDoc(cref(p), { name: n, phone: p, stamps: 0, redeemed: 0, since: today(),
        history: [{ date: today(), type: 'Tarjeta creada', t: Date.now() }] });
    }
    me = p; try { localStorage.setItem(K('me_phone'), p); } catch {}
    say('#cardMsg', ''); watchCard();
  } catch (err) { say('#cardMsg', errText(err)); }
});
$('#logoutClient').addEventListener('click', () => {
  me = ''; try { localStorage.removeItem(K('me_phone')); } catch {}
  $('#loginForm').reset(); $('#nameWrap').hidden = true; watchCard();
});

function watchCard() {
  if (unsubCard) unsubCard();
  unsubCard = null; card = null;
  if (me) unsubCard = onSnapshot(cref(me), s => { card = s.exists() ? s.data() : null; renderCard(); },
    err => say('#cardMsg', errText(err)));
  renderCard();
}

function renderCard() {
  const c = card;
  $('#cardLogin').hidden = !!c;
  $('#cardView').hidden = !c;
  if (!c) return;
  const g = cfg.goal, ready = c.stamps >= g;
  const visits = c.history.filter(h => h.type === 'Sello').length;

  // Los sellos nuevos (que llegaron en vivo o desde la última visita) se animan
  const seenKey = K('seen_' + c.phone);
  let seen = 0; try { seen = +localStorage.getItem(seenKey) || 0; } catch {}
  seen = Math.min(seen, c.stamps);

  $('#member').classList.toggle('ready', ready);
  $('#mShop').textContent = cfg.shop;
  $('#hello').textContent = c.name;
  $('#mMeta').textContent = `Socio ${c.phone.slice(-4)} · Desde ${c.since || today()}`;
  $('#mLevel').textContent = LEVELS.find(l => visits >= l[0])[1];

  const ico = iconOf(c.phone);
  $('#stampGrid').innerHTML = Array.from({ length: g }, (_, i) => {
    const on = i < c.stamps, isNew = on && i >= seen;
    return `<div class="stamp ${on ? 'on' : ''} ${isNew ? 'new' : ''} ${i === g - 1 ? 'last' : ''}">${on ? ICONS[ico].svg : (i === g - 1 ? '★' : i + 1)}</div>`;
  }).join('');

  $('#iconPicker').innerHTML = Object.entries(ICONS).map(([k, v]) =>
    `<button type="button" role="radio" aria-checked="${k === ico}" aria-label="${v.label}" title="${v.label}" data-i="${k}" class="${k === ico ? 'on' : ''}">${v.svg}</button>`).join('');

  const bar = $('#bar');
  bar.style.width = '0';
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = Math.min(100, c.stamps / g * 100) + '%'; }));
  try { localStorage.setItem(seenKey, c.stamps); } catch {}

  $('#cardInfo').textContent = ready
    ? `Tu premio está listo: ${cfg.reward}. Muestra esta tarjeta en la barbería.`
    : `Llevas ${c.stamps} de ${g}. Te faltan ${g - c.stamps} para: ${cfg.reward}.`;

  const qr = $('#qr');
  if (qr.dataset.p !== c.phone) {
    qr.innerHTML = ''; qr.dataset.p = c.phone;
    if (window.QRCode) new QRCode(qr, { text: 'SELLO:' + c.phone, width: 96, height: 96, colorDark: '#10243e', colorLight: '#f4f1ec' });
  }
  $('#promo').textContent = cfg.promo || 'Pronto habrá promociones para ti.';
  $('#prizes').innerHTML = (ready ? `<li><span>Disponible</span><b>${esc(cfg.reward)}</b></li>` : '') +
    `<li><span>Premios canjeados</span><b>${c.redeemed}</b></li>`;
  $('#history').innerHTML = c.history.slice(-8).reverse()
    .map(h => `<li><span>${esc(h.date)}</span><b>${esc(h.type)}</b></li>`).join('') || '<li>Aún no hay visitas.</li>';
}

/* ---------- Panel: sesión del barbero ---------- */
$('#pinForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { await signInWithEmailAndPassword(auth, $('#email').value.trim(), $('#pass').value); $('#pass').value = ''; say('#pinMsg', ''); }
  catch { say('#pinMsg', 'Correo o contraseña incorrectos.'); }
});
$('#logoutAdmin').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async u => {
  user = u;
  $('#navPanel').hidden = !u;   // el enlace al panel solo aparece con sesión iniciada
  if (unsubList) unsubList();
  unsubList = null; clients = [];
  if (u) {
    try {
      const o = await getDoc(doc(db, 'owners', u.uid));
      if (!o.exists()) say('#panelMsg', 'Tu cuenta aún no tiene una barbería asignada. Pídele a Krom Digital que la active.');
      else {
        if (o.data().shop !== shopId) {
          shopId = o.data().shop; me = '';
          try { localStorage.setItem('shop', shopId); } catch {}
          watchShop(); watchCard();
        }
        unsubList = onSnapshot(collection(db, 'shops', shopId, 'clients'),
          s => { clients = s.docs.map(d => d.data()).sort((a, b) => a.name.localeCompare(b.name)); renderPanel(); },
          err => say('#panelMsg', errText(err)));
      }
    } catch (err) { say('#panelMsg', errText(err)); }
  }
  renderPanel();
});

/* ---------- Panel: clientes y sellos ---------- */
$('#search').addEventListener('input', renderPanel);

function renderPanel() {
  $('#pinBox').hidden = !!user;
  $('#adminBox').hidden = !user;
  if (!user) return;
  $('#shareLink').value = shopId ? new URL('index.html?b=' + shopId + '#tarjeta', location.href).href : '';
  $('#panelLink').value = shopId ? new URL('panel.html?b=' + shopId, location.href).href : '';
  const g = cfg.goal, q = $('#search').value.trim().toLowerCase();
  const given = clients.reduce((n, c) => n + c.history.filter(h => h.type === 'Sello').length, 0);
  const prizes = clients.reduce((n, c) => n + c.redeemed, 0);
  $('#stats').innerHTML =
    `<div><b>${clients.length}</b><span>Clientes</span></div>` +
    `<div><b>${given}</b><span>Sellos dados</span></div>` +
    `<div><b>${prizes}</b><span>Premios canjeados</span></div>`;

  const list = clients.filter(c => !q || c.name.toLowerCase().includes(q) || c.phone.includes(digits(q) || q));
  $('#clientList').innerHTML = list.map(c => {
    const ready = c.stamps >= g;
    return `<li><div><b>${esc(c.name)}</b><small>${esc(c.phone)} · ${c.stamps}/${g} sellos</small></div>
      <div class="acts">
        <button class="btn" data-a="add" data-p="${esc(c.phone)}" ${ready ? 'disabled' : ''}>Dar sello</button>
        <button class="btn gold" data-a="redeem" data-p="${esc(c.phone)}" ${ready ? '' : 'disabled'}>Canjear</button>
      </div></li>`;
  }).join('') || '<li>No hay clientes con esa búsqueda.</li>';

  // No pisar lo que el barbero está escribiendo en Configuración
  if (!$('#cfgForm').contains(document.activeElement)) {
    $('#shop').value = cfg.shop; $('#goal').value = g; $('#reward').value = cfg.reward; $('#promoIn').value = cfg.promo || '';
    $('#waIn').value = cfg.whatsapp; $('#addrIn').value = cfg.address; $('#igIn').value = cfg.instagram;
    $('#openH').value = cfg.open; $('#closeH').value = cfg.close; $('#sundayIn').checked = !!cfg.sunday; $('#svcIn').value = cfg.services;
  }
}

async function change(phone, kind) {
  const ref = cref(phone);
  let name = '';
  try {
    await runTransaction(db, async tx => {
      const c = (await tx.get(ref)).data();
      if (!c) throw new Error('No existe una tarjeta con ese celular.');
      name = c.name;
      if (kind === 'add') {
        if (c.stamps >= cfg.goal) throw new Error(`${c.name} ya tiene la tarjeta completa. Canjea su premio primero.`);
        tx.update(ref, { stamps: c.stamps + 1, history: [...c.history, { date: today(), type: 'Sello', t: Date.now() }] });
      } else {
        if (c.stamps < cfg.goal) throw new Error(`A ${c.name} aún le faltan sellos.`);
        tx.update(ref, { stamps: c.stamps - cfg.goal, redeemed: c.redeemed + 1, history: [...c.history, { date: today(), type: 'Premio canjeado', t: Date.now() }] });
      }
    });
    say('#panelMsg', kind === 'add' ? `Sello dado a ${name}.` : `Premio canjeado por ${name}.`, true);
  } catch (err) { say('#panelMsg', errText(err)); }
}
$('#clientList').addEventListener('click', e => {
  const b = e.target.closest('button[data-a]');
  if (b) change(b.dataset.p, b.dataset.a);
});

/* ---------- Panel: escáner de QR ---------- */
async function stopScan() {
  if (!scanner) return;
  const s = scanner; scanner = null;
  try { await s.stop(); s.clear(); } catch {}
  $('#reader').hidden = true; $('#scanBtn').textContent = 'Escanear QR';
}
$('#scanBtn').addEventListener('click', async () => {
  if (scanner) return stopScan();
  if (!window.Html5Qrcode) return say('#panelMsg', 'No se cargó el lector de QR. Revisa tu conexión.');
  $('#reader').hidden = false;
  scanner = new Html5Qrcode('reader');
  try {
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 220 }, async text => {
      await stopScan();
      const m = /^SELLO:(\d{10,13})$/.exec(text);
      if (!m) return say('#panelMsg', 'Ese QR no es de esta barbería.');
      change(m[1], 'add');
    });
    $('#scanBtn').textContent = 'Cancelar escaneo';
  } catch { await stopScan(); say('#panelMsg', 'No se pudo abrir la cámara. Revisa los permisos y que la página use https.'); }
});

/* ---------- Panel: agregar cliente y configuración ---------- */
$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const n = $('#newName').value.trim(), p = digits($('#newPhone').value);
  if (p.length < 10) return say('#addMsg', 'El celular debe tener 10 dígitos.');
  try {
    if ((await getDoc(cref(p))).exists()) return say('#addMsg', 'Ese celular ya tiene una tarjeta.');
    await setDoc(cref(p), { name: n, phone: p, stamps: 0, redeemed: 0, since: today(),
      history: [{ date: today(), type: 'Tarjeta creada', t: Date.now() }] });
    e.target.reset(); say('#addMsg', 'Cliente agregado.', true);
  } catch (err) { say('#addMsg', errText(err)); }
});

$('#cfgForm').addEventListener('submit', async e => {
  e.preventDefault();
  const g = parseInt($('#goal').value, 10);
  if (!(g >= 3 && g <= 20)) return say('#cfgMsg', 'Los sellos deben ser entre 3 y 20.');
  const oh = parseInt($('#openH').value, 10), ch = parseInt($('#closeH').value, 10);
  if (!(oh >= 0 && ch <= 24 && oh < ch)) return say('#cfgMsg', 'Revisa el horario: la apertura debe ser antes del cierre.');
  if (!shopId) return say('#cfgMsg', 'Tu cuenta aún no tiene una barbería asignada.');
  try {
    await setDoc(doc(db, 'shops', shopId), {
      shop: $('#shop').value.trim() || cfg.shop, goal: g,
      reward: $('#reward').value.trim() || cfg.reward, promo: $('#promoIn').value.trim(),
      whatsapp: $('#waIn').value.trim(), address: $('#addrIn').value.trim(), instagram: $('#igIn').value.trim(),
      open: oh, close: ch, sunday: $('#sundayIn').checked, services: $('#svcIn').value.trim() || SERVICES
    }, { merge: true });
    say('#cfgMsg', 'Cambios guardados.', true);
  } catch (err) { say('#cfgMsg', errText(err)); }
});

document.querySelectorAll('#shareLink, #panelLink').forEach(i => i.addEventListener('click', e => { e.target.select(); try { navigator.clipboard.writeText(e.target.value); } catch {} }));

/* ---------- Inicio ---------- */
window.addEventListener('hashchange', route);
watchShop(); route(); watchCard();
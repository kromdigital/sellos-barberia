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

const DEFAULTS = { shop: 'Tu Barbería', goal: 8, reward: 'Corte gratis', promo: 'Martes de barba 2x1.' };
const LEVELS = [[10, 'VIP'], [4, 'Frecuente'], [0, 'Nuevo']];
const cref = p => doc(db, 'clients', p);

let cfg = { ...DEFAULTS };
let me = ''; try { me = localStorage.getItem('me_phone') || ''; } catch {}
let card = null;       // tarjeta del cliente (en vivo)
let clients = [];      // lista de clientes (solo barbero, en vivo)
let user = null;
let unsubCard = null, unsubList = null, scanner = null;

/* ---------- Navegación ---------- */
function route() {
  const v = (location.hash || '#inicio').slice(1);
  const id = ['inicio', 'tarjeta', 'panel'].includes(v) ? v : 'inicio';
  document.querySelectorAll('.view').forEach(s => s.hidden = s.id !== id);
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.hash === '#' + id));
  if (id !== 'panel') stopScan();
  window.scrollTo(0, 0);
}
function brand() {
  $('#brandName').textContent = cfg.shop;
  document.title = 'Tarjeta de sellos | ' + cfg.shop;
}

/* ---------- Configuración (en vivo) ---------- */
onSnapshot(doc(db, 'config', 'main'), s => {
  cfg = { ...DEFAULTS, ...(s.exists() ? s.data() : {}) };
  brand(); renderCard(); renderPanel();
}, () => {});

/* ---------- Cliente: mi tarjeta ---------- */
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const p = digits($('#phone').value), n = $('#name').value.trim();
  if (p.length < 10) return say('#cardMsg', 'Escribe tu número a 10 dígitos.');
  try {
    const s = await getDoc(cref(p));
    if (!s.exists()) {
      if (!n) { $('#nameWrap').hidden = false; $('#name').focus(); return say('#cardMsg', 'Eres nuevo: escribe tu nombre para crear tu tarjeta.'); }
      await setDoc(cref(p), { name: n, phone: p, stamps: 0, redeemed: 0, since: today(),
        history: [{ date: today(), type: 'Tarjeta creada', t: Date.now() }] });
    }
    me = p; try { localStorage.setItem('me_phone', p); } catch {}
    say('#cardMsg', ''); watchCard();
  } catch (err) { say('#cardMsg', errText(err)); }
});
$('#logoutClient').addEventListener('click', () => {
  me = ''; try { localStorage.removeItem('me_phone'); } catch {}
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
  const seenKey = 'seen_' + c.phone;
  let seen = 0; try { seen = +localStorage.getItem(seenKey) || 0; } catch {}
  seen = Math.min(seen, c.stamps);

  $('#member').classList.toggle('ready', ready);
  $('#mShop').textContent = cfg.shop;
  $('#hello').textContent = c.name;
  $('#mMeta').textContent = `Socio ${c.phone.slice(-4)} · Desde ${c.since || today()}`;
  $('#mLevel').textContent = LEVELS.find(l => visits >= l[0])[1];

  $('#stampGrid').innerHTML = Array.from({ length: g }, (_, i) => {
    const on = i < c.stamps, isNew = on && i >= seen;
    return `<div class="stamp ${on ? 'on' : ''} ${isNew ? 'new' : ''}">${on ? '✂' : i + 1}</div>`;
  }).join('');

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

onAuthStateChanged(auth, u => {
  user = u;
  $('#navPanel').hidden = !u;   // el enlace al panel solo aparece con sesión iniciada
  if (unsubList) unsubList();
  unsubList = null; clients = [];
  if (u) unsubList = onSnapshot(collection(db, 'clients'),
    s => { clients = s.docs.map(d => d.data()).sort((a, b) => a.name.localeCompare(b.name)); renderPanel(); },
    err => say('#panelMsg', errText(err)));
  renderPanel();
});

/* ---------- Panel: clientes y sellos ---------- */
$('#search').addEventListener('input', renderPanel);

function renderPanel() {
  $('#pinBox').hidden = !!user;
  $('#adminBox').hidden = !user;
  if (!user) return;
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
  try {
    await setDoc(doc(db, 'config', 'main'), {
      shop: $('#shop').value.trim() || cfg.shop, goal: g,
      reward: $('#reward').value.trim() || cfg.reward, promo: $('#promoIn').value.trim() });
    say('#cfgMsg', 'Cambios guardados.', true);
  } catch (err) { say('#cfgMsg', errText(err)); }
});

/* ---------- Inicio ---------- */
window.addEventListener('hashchange', route);
brand(); route(); watchCard(); renderPanel();
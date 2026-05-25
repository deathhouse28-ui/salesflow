'use strict';

// ════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════
const CATS = {
  prospect: { label: 'Prospect', color: '#007AFF' },
  hot:      { label: 'Hot Lead', color: '#FF3B30' },
  warm:     { label: 'Warm Lead', color: '#FF9500' },
  cold:     { label: 'Cold Lead', color: '#8E8E93' },
  client:   { label: 'Client',   color: '#34C759' },
};

// ════════════════════════════════════════════════
// DATABASE — IndexedDB wrapper
// ════════════════════════════════════════════════
const DB = (() => {
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const req = indexedDB.open('salesflow', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('contacts')) {
          const s = db.createObjectStore('contacts', { keyPath: 'id' });
          s.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  function idb(mode, fn) {
    return open().then(db => new Promise((res, rej) => {
      const tx = db.transaction('contacts', mode);
      const s  = tx.objectStore('contacts');
      const req = fn(s);
      if (req && typeof req.onsuccess !== 'undefined') {
        req.onsuccess = e => res(e.target.result);
        req.onerror   = e => rej(e.target.error);
      } else {
        tx.oncomplete = () => res();
        tx.onerror    = e => rej(e.target.error);
      }
    }));
  }

  return {
    getAll:   ()      => idb('readonly',  s => s.getAll()),
    get:      id      => idb('readonly',  s => s.get(id)),
    put:      contact => idb('readwrite', s => s.put(contact)),
    remove:   id      => idb('readwrite', s => s.delete(id)),
  };
})();

// ════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════
let state = {
  contacts: [],
  view: 'contacts',
  stack: [],          // navigation stack of { view, params }
  params: {},
  searchQ: '',
  catFilter: 'all',
};

// ════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarColor(name) {
  const colors = ['#FF3B30','#FF9500','#34C759','#007AFF','#AF52DE','#FF2D55','#5AC8FA','#4CD964'];
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return colors[Math.abs(h) % colors.length];
}

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

function relDate(ts) {
  const now = Date.now();
  const d   = ts - now;
  const abs = Math.abs(d);
  const mins  = abs / 60000;
  const hours = abs / 3600000;
  const days  = abs / 86400000;

  if (abs < 60000) return d < 0 ? 'Just now' : 'In a moment';

  const past = d < 0;
  if (days >= 2)  return (past ? '' : 'In ') + Math.round(days)  + ' days'  + (past ? ' ago' : '');
  if (hours >= 1) return (past ? '' : 'In ') + Math.round(hours) + ' hours' + (past ? ' ago' : '');
  return (past ? '' : 'In ') + Math.round(mins) + ' min' + (past ? ' ago' : '');
}

function isSameDay(ts, now) {
  const a = new Date(ts), b = new Date(now);
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

function fuStatus(ts) {
  const now = Date.now();
  if (ts < now - 86400000) return 'overdue';
  if (ts < now)            return 'today';
  if (isSameDay(ts, now))  return 'today';
  return 'upcoming';
}

let _toastTimer;
function toast(msg, type = 'default') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.className = '', 2500);
}

let _confirmCb;
function showConfirm(msg, onOk) {
  _confirmCb = onOk;
  document.getElementById('confirm-msg').textContent = msg;
  document.getElementById('confirm-backdrop').classList.remove('hidden');
  document.getElementById('confirm-dialog').classList.remove('hidden');
  document.getElementById('confirm-ok').onclick = () => { hideConfirm(); onOk(); };
}
function hideConfirm() {
  document.getElementById('confirm-backdrop').classList.add('hidden');
  document.getElementById('confirm-dialog').classList.add('hidden');
}

// ════════════════════════════════════════════════
// DATA OPERATIONS
// ════════════════════════════════════════════════
async function loadContacts() {
  state.contacts = await DB.getAll();
  state.contacts.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getContact(id) {
  return state.contacts.find(c => c.id === id);
}

async function saveContact(contact) {
  contact.updatedAt = Date.now();
  await DB.put(contact);
  const idx = state.contacts.findIndex(c => c.id === contact.id);
  if (idx >= 0) state.contacts[idx] = contact;
  else state.contacts.unshift(contact);
}

async function deleteContact(id) {
  await DB.remove(id);
  state.contacts = state.contacts.filter(c => c.id !== id);
}

// ════════════════════════════════════════════════
// NAVIGATION
// ════════════════════════════════════════════════
function navigate(view, params = {}, push = true) {
  if (push && state.view !== view) {
    state.stack.push({ view: state.view, params: state.params });
  }
  state.view   = view;
  state.params = params;
  render();
}

function goBack() {
  if (state.stack.length === 0) return;
  const prev = state.stack.pop();
  state.view   = prev.view;
  state.params = prev.params;
  render();
}

function tabClick(tab) {
  state.stack = [];
  if (tab === 'contacts') {
    state.catFilter = 'all';
    state.searchQ   = '';
  }
  navigate(tab, {}, false);
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab)
  );
}

// ════════════════════════════════════════════════
// RENDER ENGINE
// ════════════════════════════════════════════════
function render() {
  const views = {
    contacts:       renderContacts,
    followups:      renderFollowups,
    'contact-detail': () => renderContactDetail(state.params.id),
    'add-contact':  () => renderAddContact(null),
    'edit-contact': () => renderAddContact(state.params.id),
  };

  updateHeader();
  updateTabBar();
  updateBadge();

  const fn = views[state.view];
  if (fn) fn();
}

function updateHeader() {
  const title = document.getElementById('header-title');
  const back  = document.getElementById('btn-back');
  const right = document.getElementById('btn-header-right');
  const backL = document.getElementById('btn-back-label');

  const hasBack = state.stack.length > 0;
  back.classList.toggle('hidden', !hasBack);

  if (hasBack) {
    const prev = state.stack[state.stack.length - 1];
    const labels = {
      contacts: 'Contacts', followups: 'Follow-ups',
      'contact-detail': 'Back', 'add-contact': 'Back'
    };
    backL.textContent = labels[prev.view] || 'Back';
  }

  // Configure per view
  right.className   = 'header-btn header-btn-right';
  right.innerHTML   = '';
  right.onclick     = null;
  right.classList.remove('hidden', 'text-btn', 'destructive');

  switch (state.view) {
    case 'contacts':
      title.textContent = 'Contacts';
      right.innerHTML   = plusIcon();
      right.onclick     = () => navigate('add-contact');
      break;
    case 'followups':
      title.textContent = 'Follow-ups';
      right.classList.add('hidden');
      break;
    case 'contact-detail': {
      const c = getContact(state.params.id);
      title.textContent = c ? c.name : 'Contact';
      right.classList.add('text-btn');
      right.textContent = 'Edit';
      right.onclick     = () => navigate('edit-contact', { id: state.params.id });
      break;
    }
    case 'add-contact':
      title.textContent = 'New Contact';
      right.classList.add('hidden');
      break;
    case 'edit-contact':
      title.textContent = 'Edit Contact';
      right.classList.add('hidden');
      break;
  }
}

function updateTabBar() {
  const tabViews = { contacts: 'contacts', followups: 'followups' };
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === state.view ||
      (state.view === 'contact-detail' && t.dataset.tab === 'contacts'));
  });
}

function updateBadge() {
  const now = Date.now();
  const overdue = state.contacts.reduce((n, c) =>
    n + (c.followUps || []).filter(f => !f.done && f.datetime < now).length, 0);
  const badge = document.getElementById('badge-followups');
  if (overdue > 0) {
    badge.textContent = overdue > 9 ? '9+' : overdue;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function plusIcon() {
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
    <path d="M10 2V18M2 10H18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`;
}

function chevronIcon() {
  return `<svg class="chevron" width="8" height="14" viewBox="0 0 8 14" fill="none">
    <path d="M1 1l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

// ════════════════════════════════════════════════
// VIEW — CONTACTS LIST
// ════════════════════════════════════════════════
function renderContacts() {
  const q   = state.searchQ.toLowerCase();
  const cat = state.catFilter;

  let list = state.contacts;
  if (q)         list = list.filter(c => (c.name + c.company + c.email + c.phone).toLowerCase().includes(q));
  if (cat !== 'all') list = list.filter(c => c.category === cat);

  const notifBanner = Notification.permission === 'default'
    ? `<div class="notif-banner">
        <span>Enable reminders for follow-ups</span>
        <button onclick="requestNotifPermission()">Enable</button>
      </div>` : '';

  document.getElementById('content').innerHTML = `
    <div class="content-pad">
      <div class="search-wrap">
        <div class="search-bar">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5"/>
            <path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <input type="search" placeholder="Search contacts…" value="${esc(state.searchQ)}"
            oninput="onSearch(this.value)" id="search-input">
        </div>
      </div>

      <div class="filter-row">
        ${['all', ...Object.keys(CATS)].map(k => `
          <button class="filter-pill${cat === k ? ' active' : ''}"
            onclick="setCatFilter('${k}')">
            ${k === 'all' ? 'All' : CATS[k].label}
          </button>`).join('')}
      </div>

      ${notifBanner}

      ${list.length === 0 ? emptyContacts(q, cat) : `
        <div class="card">
          ${list.map((c, i) => contactCell(c, i < list.length - 1)).join('')}
        </div>
      `}
    </div>
  `;

  // Restore keyboard focus if we were searching
  if (state.searchQ) {
    const inp = document.getElementById('search-input');
    if (inp) { inp.focus(); inp.setSelectionRange(9999, 9999); }
  }
}

function contactCell(c) {
  const color = avatarColor(c.name);
  const cat   = CATS[c.category] || CATS.prospect;
  const fuDue = (c.followUps || []).filter(f => !f.done).length;
  return `
    <button class="list-item" onclick="navigate('contact-detail',{id:'${c.id}'})">
      <div class="avatar" style="background:${color}">${esc(initials(c.name))}</div>
      <div class="contact-info">
        <div class="contact-name">${esc(c.name)}</div>
        <div class="contact-sub">${esc(c.company || c.phone || c.email || '—')}</div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:4px;">
          <span class="cat-pill" style="background:${cat.color}">${cat.label}</span>
          ${fuDue > 0 ? `<span style="font-size:12px;color:var(--orange)">📅 ${fuDue} follow-up${fuDue>1?'s':''}</span>` : ''}
        </div>
      </div>
      ${chevronIcon()}
    </button>
  `;
}

function emptyContacts(q, cat) {
  if (q || cat !== 'all') return `
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
        <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.5"/>
        <path d="M16.5 16.5L21 21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <h3>No results</h3>
      <p>Try a different search or filter.</p>
    </div>`;
  return `
    <div class="empty-state">
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none">
        <circle cx="9" cy="7" r="4" stroke="currentColor" stroke-width="1.5"/>
        <path d="M1 21v-1a8 8 0 0116 0v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <h3>No contacts yet</h3>
      <p>Add your first contact to start tracking leads and follow-ups.</p>
      <button onclick="navigate('add-contact')">Add First Contact</button>
    </div>`;
}

// ════════════════════════════════════════════════
// VIEW — FOLLOW-UPS
// ════════════════════════════════════════════════
function renderFollowups() {
  const now = Date.now();
  const all = [];

  state.contacts.forEach(c => {
    (c.followUps || []).forEach(f => {
      all.push({ ...f, contactId: c.id, contactName: c.name });
    });
  });

  const overdue  = all.filter(f => !f.done && f.datetime < now - 86400000).sort((a,b) => a.datetime - b.datetime);
  const today    = all.filter(f => !f.done && f.datetime >= now - 86400000 && isSameDay(f.datetime, now)).sort((a,b) => a.datetime - b.datetime);
  const upcoming = all.filter(f => !f.done && !isSameDay(f.datetime, now) && f.datetime > now).sort((a,b) => a.datetime - b.datetime);
  const done     = all.filter(f => f.done).sort((a,b) => b.datetime - a.datetime).slice(0, 20);

  function fuCard(f, statusClass, label) {
    return `
      <div class="fu-item">
        <button class="fu-check${f.done?' done':''}" onclick="toggleFu('${f.contactId}','${f.id}')"
          aria-label="${f.done ? 'Mark incomplete' : 'Mark done'}">
          ${f.done ? `<svg width="12" height="10" viewBox="0 0 12 10" fill="none">
            <path d="M1 5l3.5 3.5L11 1" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>` : ''}
        </button>
        <div class="fu-body">
          <div class="fu-date ${statusClass}">${label}: ${fmtDateTime(f.datetime)}</div>
          ${f.note ? `<div class="fu-note${f.done?' done-text':''}">${esc(f.note)}</div>` : ''}
          <div class="fu-contact" onclick="navigate('contact-detail',{id:'${f.contactId}'})">${esc(f.contactName)}</div>
        </div>
        <button class="fu-del" onclick="deleteFuGlobal('${f.contactId}','${f.id}')">Delete</button>
      </div>`;
  }

  let html = '<div class="content-pad">';

  if (overdue.length === 0 && today.length === 0 && upcoming.length === 0 && done.length === 0) {
    html += `
      <div class="empty-state">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="4" width="18" height="17" rx="3" stroke="currentColor" stroke-width="1.5"/>
          <path d="M3 9h18" stroke="currentColor" stroke-width="1.5"/>
          <path d="M8 2v4M16 2v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M8 14l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <h3>No follow-ups</h3>
        <p>Schedule follow-ups from any contact's detail page.</p>
      </div>`;
  } else {
    if (overdue.length > 0) {
      html += `<div class="fu-section-label" style="color:var(--red)">Overdue</div>
        <div class="card">${overdue.map(f => fuCard(f, 'overdue', 'Was')).join('')}</div>`;
    }
    if (today.length > 0) {
      html += `<div class="fu-section-label" style="color:var(--orange)">Today</div>
        <div class="card">${today.map(f => fuCard(f, 'today', 'Today')).join('')}</div>`;
    }
    if (upcoming.length > 0) {
      html += `<div class="fu-section-label">Upcoming</div>
        <div class="card">${upcoming.map(f => fuCard(f, 'upcoming', 'Due')).join('')}</div>`;
    }
    if (done.length > 0) {
      html += `<div class="fu-section-label">Completed</div>
        <div class="card">${done.map(f => fuCard(f, 'done-date', 'Was')).join('')}</div>`;
    }
  }

  html += '</div>';
  document.getElementById('content').innerHTML = html;
}

// ════════════════════════════════════════════════
// VIEW — CONTACT DETAIL
// ════════════════════════════════════════════════
function renderContactDetail(id) {
  const c = getContact(id);
  if (!c) { goBack(); return; }

  const color   = avatarColor(c.name);
  const cat     = CATS[c.category] || CATS.prospect;
  const notes   = (c.notes    || []).slice().reverse();
  const fus     = (c.followUps || []).slice().sort((a,b) => a.datetime - b.datetime);
  const now     = Date.now();

  document.getElementById('content').innerHTML = `
    <div class="content-pad">
      <!-- Hero -->
      <div class="detail-hero">
        <div class="avatar detail-avatar" style="background:${color}">${esc(initials(c.name))}</div>
        <div class="detail-name">${esc(c.name)}</div>
        ${c.company ? `<div class="detail-company">${esc(c.company)}</div>` : ''}
        <span class="cat-pill" style="background:${cat.color}">${cat.label}</span>
        <div class="detail-actions">
          ${c.phone ? `<a href="tel:${esc(c.phone)}" class="action-btn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M6.6 10.8a15.2 15.2 0 006.6 6.6l2.2-2.2a1 1 0 011.05-.24 11.5 11.5 0 003.6.58 1 1 0 011 1V21a1 1 0 01-1 1A18 18 0 012 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.58 3.57a1 1 0 01-.23 1.06L6.6 10.8z" stroke="currentColor" stroke-width="1.8" fill="none"/>
            </svg>
            Call</a>` : ''}
          ${c.email ? `<a href="mailto:${esc(c.email)}" class="action-btn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" stroke-width="1.8"/>
              <path d="M2 7l10 7 10-7" stroke="currentColor" stroke-width="1.8"/>
            </svg>
            Email</a>` : ''}
          <button class="action-btn" onclick="showAddNoteModal('${c.id}')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
            Note</button>
          <button class="action-btn" onclick="showAddFuModal('${c.id}',null)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="4" width="18" height="17" rx="3" stroke="currentColor" stroke-width="1.8"/>
              <path d="M3 9h18M8 2v4M16 2v4M12 13v4M10 15h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
            Remind</button>
        </div>
      </div>

      <!-- Contact Info -->
      <div class="section-header">Contact Info</div>
      <div class="card">
        ${c.phone  ? `<div class="info-row"><div class="info-label">Phone</div><div class="info-value"><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></div></div>` : ''}
        ${c.email  ? `<div class="info-row"><div class="info-label">Email</div><div class="info-value"><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div></div>` : ''}
        ${c.company? `<div class="info-row"><div class="info-label">Company</div><div class="info-value">${esc(c.company)}</div></div>` : ''}
        <div class="info-row"><div class="info-label">Added</div><div class="info-value">${fmtDate(c.createdAt)}</div></div>
      </div>

      <!-- Follow-ups -->
      <div class="section-title-row">
        <h2>Follow-ups</h2>
        <button onclick="showAddFuModal('${c.id}',null)">+ Add</button>
      </div>
      <div class="card">
        ${fus.length === 0
          ? `<div style="padding:16px;color:var(--text3);font-size:15px;text-align:center">No follow-ups scheduled</div>`
          : fus.map(f => {
              const st = f.done ? 'done-date' : fuStatus(f.datetime);
              const overdueMark = st === 'overdue' ? '🔴 ' : st === 'today' ? '🟡 ' : '';
              return `
                <div class="fu-item">
                  <button class="fu-check${f.done?' done':''}"
                    onclick="toggleFu('${c.id}','${f.id}')" aria-label="Toggle done">
                    ${f.done ? `<svg width="12" height="10" viewBox="0 0 12 10" fill="none">
                      <path d="M1 5l3.5 3.5L11 1" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>` : ''}
                  </button>
                  <div class="fu-body" onclick="showAddFuModal('${c.id}','${f.id}')">
                    <div class="fu-date ${f.done?'done-date':st}">${overdueMark}${fmtDateTime(f.datetime)}</div>
                    ${f.note ? `<div class="fu-note${f.done?' done-text':''}">${esc(f.note)}</div>` : ''}
                  </div>
                  <button class="fu-del" onclick="deleteFuOnDetail('${c.id}','${f.id}')">✕</button>
                </div>`;
            }).join('')
        }
      </div>

      <!-- Notes -->
      <div class="section-title-row">
        <h2>Notes</h2>
        <button onclick="showAddNoteModal('${c.id}')">+ Add</button>
      </div>
      <div class="card">
        ${notes.length === 0
          ? `<div style="padding:16px;color:var(--text3);font-size:15px;text-align:center">No notes yet</div>`
          : notes.map(n => `
            <div class="note-item">
              <button class="note-del" onclick="deleteNote('${c.id}','${n.id}')">Delete</button>
              <div class="note-text">${esc(n.text)}</div>
              <div class="note-date">${fmtDateTime(n.createdAt)}</div>
            </div>`).join('')
        }
      </div>

      <!-- Delete contact -->
      <button class="btn-destructive" onclick="confirmDeleteContact('${c.id}')">Delete Contact</button>
    </div>
  `;
}

// ════════════════════════════════════════════════
// VIEW — ADD / EDIT CONTACT
// ════════════════════════════════════════════════
function renderAddContact(id) {
  const c = id ? getContact(id) : null;
  const v = s => esc(c ? c[s] || '' : '');

  document.getElementById('content').innerHTML = `
    <div class="content-pad">
      <div class="form-section">
        <div class="section-header">Name</div>
        <div class="card">
          <div class="form-field">
            <label>Full Name</label>
            <input type="text" id="f-name" placeholder="Required" value="${v('name')}"
              autocomplete="name" autocapitalize="words">
          </div>
        </div>
      </div>

      <div class="form-section">
        <div class="section-header">Contact Info</div>
        <div class="card">
          <div class="form-field">
            <label>Phone</label>
            <input type="tel" id="f-phone" placeholder="Optional" value="${v('phone')}" autocomplete="tel">
          </div>
          <div class="form-field">
            <label>Email</label>
            <input type="email" id="f-email" placeholder="Optional" value="${v('email')}" autocomplete="email">
          </div>
          <div class="form-field">
            <label>Company</label>
            <input type="text" id="f-company" placeholder="Optional" value="${v('company')}"
              autocomplete="organization" autocapitalize="words">
          </div>
        </div>
      </div>

      <div class="form-section">
        <div class="section-header">Category</div>
        <div class="card">
          <div class="form-field">
            <label>Stage</label>
            <div class="cat-select-wrap">
              <div class="cat-dot" id="cat-dot"></div>
              <select id="f-cat" onchange="updateCatDot()">
                ${Object.entries(CATS).map(([k,v2]) =>
                  `<option value="${k}"${(c?.category||'prospect')===k?' selected':''}>${v2.label}</option>`
                ).join('')}
              </select>
            </div>
          </div>
        </div>
      </div>

      <button class="btn-primary" onclick="submitContact(${id ? `'${id}'` : 'null'})">
        ${id ? 'Save Changes' : 'Add Contact'}
      </button>
    </div>
  `;

  updateCatDot();

  // Focus name field on add
  if (!id) setTimeout(() => document.getElementById('f-name')?.focus(), 100);
}

function updateCatDot() {
  const sel = document.getElementById('f-cat');
  const dot = document.getElementById('cat-dot');
  if (sel && dot) dot.style.background = CATS[sel.value]?.color || '#007AFF';
}

// ════════════════════════════════════════════════
// MODALS
// ════════════════════════════════════════════════
function showModal(html) {
  const backdrop = document.getElementById('modal-backdrop');
  const sheet    = document.getElementById('modal-sheet');
  document.getElementById('modal-content').innerHTML = html;
  backdrop.classList.remove('hidden');
  sheet.classList.remove('hidden');
  // Double rAF guarantees the browser has painted the initial state
  // before starting the CSS transition (single rAF batches with display change)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    backdrop.classList.add('visible');
    sheet.classList.add('visible');
  }));
}

function hideModal() {
  const backdrop = document.getElementById('modal-backdrop');
  const sheet    = document.getElementById('modal-sheet');
  backdrop.classList.remove('visible');
  sheet.classList.remove('visible');
  setTimeout(() => {
    backdrop.classList.add('hidden');
    sheet.classList.add('hidden');
  }, 300);
}

// ── Add Note Modal ──
function showAddNoteModal(contactId) {
  showModal(`
    <div class="modal-title">Add Note</div>
    <div class="card" style="margin:0 16px 16px">
      <div class="form-field" style="border-radius:var(--radius-lg)">
        <textarea id="m-note" placeholder="Enter your note…" rows="6"
          style="width:100%" autofocus></textarea>
      </div>
    </div>
    <button class="btn-primary" onclick="submitNote('${contactId}')">Save Note</button>
    <button onclick="hideModal()" style="display:block;width:100%;padding:14px;border:none;
      background:none;color:var(--text3);font-size:17px;font-family:inherit;cursor:pointer;margin-bottom:4px">
      Cancel
    </button>
  `);
  setTimeout(() => document.getElementById('m-note')?.focus(), 350);
}

// ── Add Follow-up Modal ──
function showAddFuModal(contactId, fuId) {
  const c   = getContact(contactId);
  const fu  = fuId ? (c?.followUps || []).find(f => f.id === fuId) : null;

  // Default to tomorrow 9am
  const def = new Date();
  def.setDate(def.getDate() + 1);
  def.setHours(9, 0, 0, 0);
  const defStr = toLocalISOString(fu ? fu.datetime : def.getTime());

  showModal(`
    <div class="modal-title">${fu ? 'Edit Follow-up' : 'Schedule Follow-up'}</div>
    <div class="card" style="margin:0 16px 16px">
      <div class="form-field">
        <label>Date & Time</label>
        <input type="datetime-local" id="m-dt" value="${defStr}"
          min="${toLocalISOString(Date.now())}"
          style="color:var(--blue);text-align:right">
      </div>
      <div class="form-field">
        <label>Note</label>
        <input type="text" id="m-fu-note" placeholder="What to discuss…"
          value="${esc(fu?.note || '')}" autocapitalize="sentences">
      </div>
    </div>
    <button class="btn-primary" onclick="submitFollowup('${contactId}','${fuId||''}')">
      ${fu ? 'Save Changes' : 'Schedule Reminder'}
    </button>
    <button onclick="hideModal()" style="display:block;width:100%;padding:14px;border:none;
      background:none;color:var(--text3);font-size:17px;font-family:inherit;cursor:pointer;margin-bottom:4px">
      Cancel
    </button>
  `);
}

function toLocalISOString(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ════════════════════════════════════════════════
// ACTIONS
// ════════════════════════════════════════════════

// ── Submit contact form ──
async function submitContact(id) {
  const name = document.getElementById('f-name')?.value.trim();
  if (!name) { toast('Name is required', 'error'); return; }

  const contact = id ? { ...getContact(id) } : { id: uid(), createdAt: Date.now(), notes: [], followUps: [] };
  contact.name    = name;
  contact.phone   = document.getElementById('f-phone')?.value.trim() || '';
  contact.email   = document.getElementById('f-email')?.value.trim() || '';
  contact.company = document.getElementById('f-company')?.value.trim() || '';
  contact.category= document.getElementById('f-cat')?.value || 'prospect';

  await saveContact(contact);
  toast(id ? 'Contact saved' : 'Contact added');

  if (id) {
    goBack();
  } else {
    state.stack = [];
    navigate('contact-detail', { id: contact.id }, false);
    state.stack = [{ view: 'contacts', params: {} }];
  }
}

// ── Submit note ──
async function submitNote(contactId) {
  const text = document.getElementById('m-note')?.value.trim();
  if (!text) { toast('Note cannot be empty'); return; }

  const c = getContact(contactId);
  if (!c) return;
  c.notes = c.notes || [];
  c.notes.push({ id: uid(), text, createdAt: Date.now() });
  await saveContact(c);
  hideModal();
  toast('Note saved');
  renderContactDetail(contactId);
}

// ── Delete note ──
async function deleteNote(contactId, noteId) {
  const c = getContact(contactId);
  if (!c) return;
  c.notes = (c.notes || []).filter(n => n.id !== noteId);
  await saveContact(c);
  toast('Note deleted');
  renderContactDetail(contactId);
}

// ── Submit follow-up ──
async function submitFollowup(contactId, fuId) {
  const dtVal = document.getElementById('m-dt')?.value;
  if (!dtVal) { toast('Pick a date and time'); return; }

  const dt   = new Date(dtVal).getTime();
  const note = document.getElementById('m-fu-note')?.value.trim() || '';

  const c = getContact(contactId);
  if (!c) return;
  c.followUps = c.followUps || [];

  if (fuId) {
    const fu = c.followUps.find(f => f.id === fuId);
    if (fu) { fu.datetime = dt; fu.note = note; }
  } else {
    c.followUps.push({ id: uid(), datetime: dt, note, done: false, createdAt: Date.now() });
  }

  await saveContact(c);
  Notifs.schedule(c, dt, note);
  hideModal();
  toast(fuId ? 'Follow-up updated' : 'Reminder scheduled');
  renderContactDetail(contactId);
  updateBadge();
}

// ── Toggle follow-up done ──
async function toggleFu(contactId, fuId) {
  const c  = getContact(contactId);
  const fu = (c?.followUps || []).find(f => f.id === fuId);
  if (!fu) return;
  fu.done = !fu.done;
  await saveContact(c);
  updateBadge();
  if (state.view === 'contact-detail') renderContactDetail(contactId);
  else renderFollowups();
}

// ── Delete follow-up from detail view ──
async function deleteFuOnDetail(contactId, fuId) {
  showConfirm('Delete this follow-up?', async () => {
    const c = getContact(contactId);
    if (!c) return;
    c.followUps = (c.followUps || []).filter(f => f.id !== fuId);
    await saveContact(c);
    toast('Follow-up deleted');
    renderContactDetail(contactId);
    updateBadge();
  });
}

// ── Delete follow-up from global view ──
async function deleteFuGlobal(contactId, fuId) {
  showConfirm('Delete this follow-up?', async () => {
    const c = getContact(contactId);
    if (!c) return;
    c.followUps = (c.followUps || []).filter(f => f.id !== fuId);
    await saveContact(c);
    toast('Follow-up deleted');
    renderFollowups();
    updateBadge();
  });
}

// ── Delete contact ──
async function confirmDeleteContact(id) {
  const c = getContact(id);
  showConfirm(`Delete "${c?.name}"? This cannot be undone.`, async () => {
    await deleteContact(id);
    toast('Contact deleted');
    goBack();
  });
}

// ════════════════════════════════════════════════
// SEARCH / FILTER
// ════════════════════════════════════════════════
function onSearch(q) {
  state.searchQ = q;
  renderContacts();
}

function setCatFilter(cat) {
  state.catFilter = cat;
  renderContacts();
}

// ════════════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════════════
const Notifs = {
  // Schedule a native notification if permission granted
  schedule(contact, datetime, note) {
    if (Notification.permission !== 'granted') return;
    const delay = datetime - Date.now();
    if (delay <= 0) return;
    setTimeout(() => {
      if (document.visibilityState === 'visible') {
        // App is open — show a toast instead
        toast(`Follow-up due: ${contact.name}${note ? ' — ' + note : ''}`);
      } else {
        new Notification(`Follow-up: ${contact.name}`, {
          body: note || 'Time to follow up!',
          icon: './icon.svg',
          tag:  `fu-${contact.id}-${datetime}`,
          requireInteraction: true,
        });
      }
    }, Math.min(delay, 2147483647)); // clamp to max setTimeout value
  },

  // Check for overdue items and surface an in-app alert
  checkDue() {
    const now = Date.now();
    const due = [];
    state.contacts.forEach(c => {
      (c.followUps || []).forEach(f => {
        if (!f.done && f.datetime <= now && f.datetime >= now - 3600000) {
          due.push({ contact: c.name, note: f.note });
        }
      });
    });
    if (due.length > 0) {
      const names = [...new Set(due.map(d => d.contact))].slice(0, 3).join(', ');
      toast(`Follow-up due: ${names}`);
    }
  },

  // Re-register all pending follow-up notifications
  rescheduleAll() {
    if (Notification.permission !== 'granted') return;
    const now = Date.now();
    state.contacts.forEach(c => {
      (c.followUps || []).forEach(f => {
        if (!f.done && f.datetime > now) {
          Notifs.schedule(c, f.datetime, f.note);
        }
      });
    });
  }
};

async function requestNotifPermission() {
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    Notifs.rescheduleAll();
    toast('Reminders enabled');
    render(); // re-render to hide the banner
  } else {
    toast('Reminders blocked — check your browser settings');
  }
}

// ════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════
async function init() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Load data
  await loadContacts();

  // Render initial view
  render();

  // Check for due items every 60 seconds
  setInterval(() => { Notifs.checkDue(); updateBadge(); }, 60000);

  // Check once on load after a short delay
  setTimeout(() => Notifs.checkDue(), 2000);

  // Re-schedule notifications after page visibility restore
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      updateBadge();
      Notifs.checkDue();
    }
  });

  // Swipe back gesture (horizontal swipe from left edge)
  let touchStartX = 0;
  let touchStartY = 0;
  document.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
    if (touchStartX < 30 && dx > 60 && dy < 60 && state.stack.length > 0) {
      goBack();
    }
  }, { passive: true });
}

window.addEventListener('DOMContentLoaded', init);

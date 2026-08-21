const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  settings: null,
  dirty: new Map(), // field -> value
};

const NUMERIC_FIELDS = new Set([
  'smtp_secure', 'smtp_port', 'recently_added_count',
  'include_movies', 'include_tv', 'include_music', 'show_summaries',
  'enable_top_watched', 'enable_top_users', 'enable_stats',
  'stats_window_days', 'schedule_enabled', 'cloudinary_enabled',
  'radarr_enabled', 'sonarr_enabled', 'upcoming_window_days',
  'enable_upcoming', 'upcoming_replaces_recent',
  'greeting_enabled', 'request_enabled',
  'enable_superlatives', 'superlative_count', 'ai_curate_awards',
  'enable_flex_bar', 'uptime_enabled',
  'seasonal_theme_enabled', 'enable_fun_stats',
  'enable_ai_captions', 'ai_write_intro', 'ai_write_subject', 'ai_rewrite_summaries', 'ai_timeout_ms',
  'ai_daily_call_cap', 'ai_monthly_token_cap', 'ai_max_output_tokens', 'ai_cache_ttl_min'
]);

const BOOL_FIELDS = new Set([
  'smtp_secure', 'include_movies', 'include_tv', 'include_music',
  'show_summaries', 'enable_top_watched', 'enable_top_users',
  'enable_stats', 'schedule_enabled', 'cloudinary_enabled',
  'radarr_enabled', 'sonarr_enabled',
  'enable_upcoming', 'upcoming_replaces_recent',
  'greeting_enabled', 'request_enabled',
  'enable_superlatives', 'ai_curate_awards',
  'enable_flex_bar', 'uptime_enabled',
  'seasonal_theme_enabled', 'enable_fun_stats',
  'enable_ai_captions', 'ai_write_intro', 'ai_write_subject', 'ai_rewrite_summaries'
]);

// Labels + canonical order for the drag-to-reorder section list.
const SECTION_LABELS = {
  flex_bar: 'State of the server',
  superlatives: 'Server Wrapped awards',
  stats: 'Watch stats',
  top_movies: 'Most watched movies',
  top_tv: 'Most watched TV',
  top_users: 'Top viewers',
  recent_movies: 'New movies',
  recent_tv: 'New TV',
  recent_music: 'New music',
  upcoming_movies: 'Coming soon · Movies',
  upcoming_shows: 'Coming soon · TV'
};
const DEFAULT_SECTION_ORDER = [
  'flex_bar', 'stats', 'superlatives', 'top_movies', 'top_tv', 'top_users',
  'recent_movies', 'recent_tv', 'recent_music',
  'upcoming_movies', 'upcoming_shows'
];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body && !opts.headers?.['Content-Type'] ? { 'Content-Type': 'application/json' } : {},
    ...opts
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); msg = j.error || j.message || msg; } catch {}
    throw new Error(msg);
  }
  const ct = res.headers.get('Content-Type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

function applySettings(s) {
  state.settings = s;
  state.dirty.clear();
  updateSaveBtn();

  for (const el of $$('[data-field]')) {
    const k = el.dataset.field;
    const v = s[k];
    if (el.type === 'checkbox') {
      el.checked = !!Number(v);
    } else if (el.type === 'color') {
      el.value = String(v || '#e5a00d');
    } else {
      el.value = v ?? '';
    }
  }
  for (const el of $$('[data-field-pair]')) {
    el.value = String(s[el.dataset.fieldPair] || '#e5a00d');
  }
  $('#tz-name').textContent = window.__TZ__ || 'TZ';

  renderSectionOrder(parseSectionOrder(s.section_order));

  // Logo preview
  const logoPreview = $('#logo-preview');
  logoPreview.innerHTML = '';
  if (s.brand_logo_path) {
    const img = document.createElement('img');
    img.src = `/uploads/${s.brand_logo_path}?t=${Date.now()}`;
    img.alt = s.brand_name || 'logo';
    logoPreview.appendChild(img);
  } else {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = 'No logo uploaded';
    logoPreview.appendChild(span);
  }
}

function markDirty(field, value) {
  state.dirty.set(field, value);
  updateSaveBtn();
}

function updateSaveBtn() {
  $('#save-btn').disabled = state.dirty.size === 0;
  if (state.dirty.size === 0) {
    $('#save-status').textContent = '';
  } else {
    $('#save-status').textContent = `${state.dirty.size} unsaved change${state.dirty.size === 1 ? '' : 's'}`;
    $('#save-status').className = 'hint';
  }
}

async function loadSchedule() {
  try {
    const sched = await api('/api/schedule');
    window.__TZ__ = sched.tz;
    $('#tz-name').textContent = sched.tz;
    const pill = $('#schedule-pill');
    if (sched.enabled) {
      pill.textContent = `Schedule on (${sched.tz})`;
      pill.className = 'pill pill-active';
    } else {
      pill.textContent = 'Schedule off';
      pill.className = 'pill pill-muted';
    }
    if (sched.next) {
      const d = new Date(sched.next);
      $('#next-run').textContent = `Next run: ${d.toLocaleString()}`;
    } else {
      $('#next-run').textContent = sched.enabled ? 'Next run: (computing…)' : '';
    }
  } catch (err) {
    console.error('schedule fetch failed', err);
  }
}

async function loadRecipients() {
  const tbody = $('#recipients-table tbody');
  tbody.innerHTML = '';
  const recipients = await api('/api/recipients');
  const badge = $('#nav-recipient-count');
  if (badge) {
    badge.textContent = recipients.length;
    badge.hidden = recipients.length === 0;
  }
  if (recipients.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4" class="muted" style="text-align:center;padding:24px;">No recipients yet — add one above.</td>`;
    tbody.appendChild(tr);
    return;
  }
  for (const r of recipients) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(r.email)}</td>
      <td><input class="inline-edit" type="text" value="${escapeHtml(r.name || '')}" placeholder="—" data-name-id="${r.id}" data-original="${escapeHtml(r.name || '')}" /></td>
      <td><label class="checkbox" style="margin:0;"><input type="checkbox" data-active="${r.id}" ${r.active ? 'checked' : ''}/><span></span></label></td>
      <td class="row-actions"><button class="btn btn-danger" data-delete="${r.id}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  }
}

function renderSkippedImports(skipped) {
  const block = $('#skipped-imports');
  const list = $('#skipped-list');
  list.innerHTML = '';
  if (!skipped || skipped.length === 0) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  for (const u of skipped) {
    const row = document.createElement('div');
    row.className = 'skipped-row';
    row.innerHTML = `
      <div class="skipped-meta">
        <strong>${escapeHtml(u.name || u.username)}</strong>
        <span class="username">@${escapeHtml(u.username)}</span>
      </div>
      <input type="email" placeholder="email@example.com" />
      <button class="btn btn-primary" type="button">Add</button>
    `;
    const input = row.querySelector('input');
    const addBtn = row.querySelector('button');
    addBtn.addEventListener('click', async () => {
      const email = (input.value || '').trim();
      if (!email || !/^.+@.+\..+$/.test(email)) {
        input.focus();
        input.style.borderColor = 'var(--danger)';
        return;
      }
      addBtn.disabled = true;
      addBtn.textContent = 'Adding…';
      try {
        await api('/api/recipients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, name: u.name || u.username })
        });
        row.classList.add('done');
        addBtn.textContent = 'Added';
        await loadRecipients();
      await loadBroadcastRecipients();
      } catch (err) {
        addBtn.disabled = false;
        addBtn.textContent = 'Add';
        input.style.borderColor = 'var(--danger)';
        alert(err.message);
      }
    });
    input.addEventListener('input', () => { input.style.borderColor = ''; });
    list.appendChild(row);
  }
}

async function loadHistory() {
  const tbody = $('#history-table tbody');
  tbody.innerHTML = '';
  const log = await api('/api/sendlog');
  if (log.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" class="muted" style="text-align:center;padding:24px;">No sends yet.</td>`;
    tbody.appendChild(tr);
    return;
  }
  for (const r of log) {
    const kind = r.kind || 'newsletter';
    const subject = r.subject || (kind === 'broadcast' ? '(no subject)' : 'Newsletter');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(r.sent_at + 'Z').toLocaleString()}</td>
      <td><span class="kind-pill ${kind}">${escapeHtml(kind)}</span></td>
      <td>${escapeHtml(subject)}</td>
      <td>${r.recipient_count}</td>
      <td class="status-${r.status}">${r.status}</td>
      <td>${(r.duration_ms / 1000).toFixed(1)}s</td>
    `;
    tr.title = r.message || '';
    tbody.appendChild(tr);
  }
}

async function refreshPreview() {
  const frame = $('#preview-frame');
  frame.src = `/api/preview?ts=${Date.now()}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bindFieldHandlers() {
  for (const el of $$('[data-field]')) {
    const k = el.dataset.field;
    const handler = () => {
      let v;
      if (el.type === 'checkbox') v = el.checked ? 1 : 0;
      else if (NUMERIC_FIELDS.has(k)) v = Number(el.value);
      else v = el.value;
      markDirty(k, v);
      // sync color text + picker
      if (k === 'brand_accent') {
        for (const peer of $$(`[data-field-pair="${k}"]`)) peer.value = el.value;
      }
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }
  for (const el of $$('[data-field-pair]')) {
    el.addEventListener('input', () => {
      const k = el.dataset.fieldPair;
      const peer = $(`[data-field="${k}"]`);
      if (peer) {
        peer.value = el.value;
        markDirty(k, el.value);
      }
    });
  }
}

async function saveChanges() {
  if (state.dirty.size === 0) return;
  const patch = Object.fromEntries(state.dirty);
  $('#save-status').textContent = 'Saving…';
  try {
    const updated = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    applySettings(updated);
    toast('Settings saved', 'success');
    loadSchedule();
    loadAiUsage();
    if (currentPage() === 'dashboard') loadDashboard();
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
    $('#save-status').textContent = `Save failed: ${err.message}`;
    $('#save-status').className = 'hint error';
  }
}

// --- Section order (drag-to-reorder) ----------------------------------------

function parseSectionOrder(raw) {
  let order = [];
  try {
    const parsed = JSON.parse(raw || '[]');
    if (Array.isArray(parsed)) order = parsed.filter((k) => k in SECTION_LABELS);
  } catch {}
  // Insert missing keys at their canonical position (matches the template).
  DEFAULT_SECTION_ORDER.forEach((k, i) => {
    if (!order.includes(k)) order.splice(Math.min(i, order.length), 0, k);
  });
  return order;
}

function currentSectionOrder() {
  return $$('#section-order-list li').map((li) => li.dataset.section);
}

function refreshOrderIndices() {
  $$('#section-order-list li').forEach((li, i) => {
    const idx = li.querySelector('.order-index');
    if (idx) idx.textContent = i + 1;
  });
}

function renderSectionOrder(order) {
  const list = $('#section-order-list');
  if (!list) return;
  list.innerHTML = '';
  order.forEach((key, i) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.section = key;
    li.innerHTML = `
      <span class="drag-handle" aria-hidden="true">⠿</span>
      <span class="order-index">${i + 1}</span>
      <span class="order-label">${escapeHtml(SECTION_LABELS[key] || key)}</span>
    `;
    list.appendChild(li);
  });
}

function bindSectionOrder() {
  const list = $('#section-order-list');
  if (!list) return;
  let dragEl = null;

  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    dragEl = li;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    const li = e.target.closest('li');
    if (!li || li === dragEl) return;
    $$('#section-order-list li').forEach((n) => n.classList.toggle('over', n === li));
    const rect = li.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    list.insertBefore(dragEl, after ? li.nextSibling : li);
  });

  list.addEventListener('dragend', () => {
    if (!dragEl) return;
    dragEl.classList.remove('dragging');
    $$('#section-order-list li').forEach((n) => n.classList.remove('over'));
    dragEl = null;
    refreshOrderIndices();
    markDirty('section_order', JSON.stringify(currentSectionOrder()));
  });
}

// --- Device preview toggle (desktop / mobile width) -------------------------

function bindDeviceToggles() {
  for (const group of $$('.device-toggle')) {
    const frame = group.dataset.preview === 'bc' ? $('#bc-preview-frame') : $('#preview-frame');
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('.device-btn');
      if (!btn || !frame) return;
      $$('.device-btn', group).forEach((b) => b.classList.toggle('active', b === btn));
      frame.classList.toggle('mobile', btn.dataset.device === 'mobile');
    });
  }
}

// --- Routing (hash-based pages) ----------------------------------------------

const PAGES = {
  dashboard:  { title: 'Dashboard',       sub: 'A quick read on the next edition, your audience, and recent sends.' },
  branding:   { title: 'Branding',        sub: 'Name, colors, greeting, and logo for the newsletter shell.' },
  content:    { title: 'Content',         sub: 'What goes into each edition, and in what order.' },
  fun:        { title: 'Fun & stats',     sub: 'Server Wrapped awards, playful stats, and the uptime badge.' },
  ai:         { title: 'AI copy',         sub: 'Let a language model rewrite captions, subjects, and blurbs — with hard spend caps.' },
  tautulli:   { title: 'Tautulli',        sub: 'The source for recently added media and watch history.' },
  arr:        { title: 'Radarr / Sonarr', sub: 'Upcoming releases for the Coming Soon section.' },
  requests:   { title: 'Requests',        sub: 'Let recipients request content straight from the email.' },
  images:     { title: 'Image hosting',   sub: 'Host posters on Cloudinary instead of attaching them to each email.' },
  smtp:       { title: 'Email (SMTP)',    sub: 'Delivery credentials, sender identity, and unsubscribe links.' },
  schedule:   { title: 'Schedule',        sub: 'When each edition goes out, and its subject line.' },
  recipients: { title: 'Recipients',      sub: 'Manage your subscriber list, or import it from Plex.' },
  preview:    { title: 'Preview & send',  sub: 'See the next edition exactly as recipients will, then send it.' },
  compose:    { title: 'Compose',         sub: 'One-off broadcasts with the same branding shell.' },
  history:    { title: 'History',         sub: 'Every newsletter and broadcast that has gone out.' },
};

let previewLoaded = false;

function currentPage() {
  const raw = location.hash.replace(/^#\/?/, '');
  return PAGES[raw] ? raw : 'dashboard';
}

function route() {
  const page = currentPage();
  for (const p of $$('.page')) p.classList.toggle('active', p.dataset.page === page);
  for (const n of $$('.nav-link')) n.classList.toggle('active', n.dataset.page === page);
  $('#page-title').textContent = PAGES[page].title;
  $('#page-sub').textContent = PAGES[page].sub;
  document.title = `${PAGES[page].title} · Pivo`;
  window.scrollTo(0, 0);
  closeMobileNav();

  // Refresh page-specific data on entry (all cheap reads).
  if (page === 'dashboard') loadDashboard();
  if (page === 'history') loadHistory();
  if (page === 'ai') loadAiUsage();
  if (page === 'preview' && !previewLoaded) {
    previewLoaded = true; // composing the newsletter is expensive — only render once visited
    refreshPreview();
  }
}

function closeMobileNav() {
  $('#sidebar').classList.remove('open');
  $('#nav-backdrop').hidden = true;
}

function bindNav() {
  window.addEventListener('hashchange', route);
  $('#nav-toggle').addEventListener('click', () => {
    const open = $('#sidebar').classList.toggle('open');
    $('#nav-backdrop').hidden = !open;
  });
  $('#nav-backdrop').addEventListener('click', closeMobileNav);

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      saveChanges();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty.size > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// --- Toasts -------------------------------------------------------------------

function toast(message, kind = '') {
  const root = $('#toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

// --- Dashboard ------------------------------------------------------------------

async function loadDashboard() {
  try {
    const [sched, recipients, log, usage] = await Promise.all([
      api('/api/schedule'),
      api('/api/recipients'),
      api('/api/sendlog'),
      api('/api/ai/usage').catch(() => null),
    ]);

    // Next edition hero
    if (sched.enabled && sched.next) {
      $('#dash-next-run').textContent = new Date(sched.next).toLocaleString([], {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      $('#dash-schedule-detail').textContent = `Scheduled sending is on · ${sched.tz}`;
    } else if (sched.enabled) {
      $('#dash-next-run').textContent = 'Computing…';
      $('#dash-schedule-detail').textContent = `Scheduled sending is on · ${sched.tz}`;
    } else {
      $('#dash-next-run').textContent = 'Not scheduled';
      $('#dash-schedule-detail').textContent = 'Scheduled sending is off — editions only go out when you send them yourself.';
    }

    // Stat cards
    const active = recipients.filter((r) => r.active).length;
    $('#dash-recipients').textContent = active;
    $('#dash-recipients-detail').textContent = `${recipients.length} total on the list`;

    const last = log[0];
    if (last) {
      $('#dash-last-send').textContent = last.status;
      $('#dash-last-send-detail').textContent =
        `${new Date(last.sent_at + 'Z').toLocaleDateString()} · ${last.recipient_count} recipient${last.recipient_count === 1 ? '' : 's'}`;
    } else {
      $('#dash-last-send').textContent = '—';
      $('#dash-last-send-detail').textContent = 'Nothing sent yet';
    }

    $('#dash-send-count').textContent = log.length;
    const troubled = log.filter((l) => l.status !== 'success').length;
    $('#dash-send-count-detail').textContent =
      log.length === 0 ? 'No sends yet' : troubled > 0 ? `${troubled} with failures` : 'All succeeded';

    if (usage) {
      $('#dash-ai-calls').textContent = usage.callsLast24h.toLocaleString();
      $('#dash-ai-detail').textContent = usage.enabled
        ? `${usage.tokensLast30d.toLocaleString()} tokens over 30 days`
        : 'AI copy is off';
    } else {
      $('#dash-ai-calls').textContent = '—';
      $('#dash-ai-detail').textContent = '';
    }

    // Setup checklist
    const s = state.settings || {};
    const checks = [
      { label: 'Connect Tautulli', done: !!(s.tautulli_url && s.tautulli_api_key), page: 'tautulli' },
      { label: 'Configure SMTP delivery', done: !!(s.smtp_host && s.smtp_from_email), page: 'smtp' },
      { label: 'Add recipients', done: active > 0, page: 'recipients' },
      { label: 'Set a sending schedule', done: !!Number(s.schedule_enabled), page: 'schedule' },
      { label: 'Set the public URL for unsubscribe links', done: !!s.public_url, page: 'smtp' },
    ];
    $('#dash-setup-list').innerHTML = checks.map((c) => `
      <li class="${c.done ? 'done' : 'todo'}">
        <span class="setup-dot"></span>${escapeHtml(c.label)}
        ${c.done ? '' : `<a href="#/${c.page}">Set up →</a>`}
      </li>`).join('');

    // Recent activity
    const recent = log.slice(0, 5);
    $('#dash-activity').innerHTML = recent.length === 0
      ? `<div class="dash-empty">No sends yet — open <a href="#/preview">Preview &amp; send</a> when you're ready for the first edition.</div>`
      : `<table class="mini-table"><tbody>${recent.map((r) => `
          <tr>
            <td class="when">${new Date(r.sent_at + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
            <td><span class="kind-pill ${r.kind || 'newsletter'}">${escapeHtml(r.kind || 'newsletter')}</span></td>
            <td>${escapeHtml(r.subject || 'Newsletter')}</td>
            <td class="status-${r.status}">${escapeHtml(r.status)}</td>
          </tr>`).join('')}</tbody></table>`;
  } catch (err) {
    console.error('dashboard load failed', err);
  }
}

function bindActions() {
  $('#save-btn').addEventListener('click', saveChanges);

  // Logo upload
  $('#logo-upload-btn').addEventListener('click', () => $('#logo-input').click());
  $('#logo-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      await fetch('/api/upload/logo', { method: 'POST', body: fd });
      const s = await api('/api/settings');
      applySettings(s);
    } catch (err) {
      alert(`Upload failed: ${err.message}`);
    }
    e.target.value = '';
  });
  $('#logo-remove-btn').addEventListener('click', async () => {
    if (!state.settings?.brand_logo_path) return;
    if (!confirm('Remove the current logo?')) return;
    await fetch('/api/upload/logo', { method: 'DELETE' });
    const s = await api('/api/settings');
    applySettings(s);
  });

  // Test buttons
  bindTest('#test-tautulli-btn', '#test-tautulli-status', '/api/test/tautulli');
  bindTest('#test-radarr-btn', '#test-radarr-status', '/api/test/radarr');
  bindTest('#test-sonarr-btn', '#test-sonarr-status', '/api/test/sonarr');
  bindTest('#test-smtp-btn', '#test-smtp-status', '/api/test/smtp');
  bindTest('#test-uptime-btn', '#test-uptime-status', '/api/test/uptime');

  $('#test-send-btn').addEventListener('click', async () => {
    const email = $('#test-email').value.trim();
    if (!email) { alert('Enter an email first'); return; }
    setStatus('#send-status', 'Sending test…');
    try {
      const r = await api('/api/test/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      setStatus('#send-status', r.ok ? `Test sent to ${email} (${r.durationMs}ms)` : `Failed: ${(r.errors || []).join('; ')}`, r.ok ? 'success' : 'error');
    } catch (err) {
      setStatus('#send-status', `Failed: ${err.message}`, 'error');
    }
  });

  $('#send-now-btn').addEventListener('click', async () => {
    if (!confirm('Send the newsletter to all active recipients now?')) return;
    setStatus('#send-status', 'Sending…');
    try {
      const r = await api('/api/send-now', { method: 'POST' });
      setStatus('#send-status',
        r.ok ? `Sent to ${r.sent} recipient${r.sent === 1 ? '' : 's'} (${r.durationMs}ms)` : `Sent ${r.sent}, failed ${r.failed}: ${(r.errors || []).slice(0,2).join('; ')}`,
        r.ok ? 'success' : 'error');
      loadHistory();
    } catch (err) {
      setStatus('#send-status', `Failed: ${err.message}`, 'error');
    }
  });

  $('#preview-btn').addEventListener('click', refreshPreview);
  $('#history-refresh').addEventListener('click', loadHistory);

  // Schedule presets
  for (const btn of $$('.presets [data-cron]')) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const cron = btn.dataset.cron;
      const input = $('[data-field="schedule_cron"]');
      input.value = cron;
      input.dispatchEvent(new Event('input'));
    });
  }

  // Recipients
  $('#add-recipient-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#new-recipient-email').value.trim();
    const name = $('#new-recipient-name').value.trim();
    try {
      await api('/api/recipients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name })
      });
      $('#new-recipient-email').value = '';
      $('#new-recipient-name').value = '';
      loadRecipients();
    } catch (err) {
      alert(err.message);
    }
  });
  $('#import-plex-btn').addEventListener('click', async () => {
    const btn = $('#import-plex-btn');
    const status = $('#import-plex-status');
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Importing…';
    status.textContent = '';
    status.className = 'hint';
    try {
      const r = await api('/api/recipients/import-from-plex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false })
      });
      const parts = [];
      if (r.imported) parts.push(`${r.imported} imported`);
      if (r.skippedExisting) parts.push(`${r.skippedExisting} already added`);
      if (r.skippedNoEmail) parts.push(`${r.skippedNoEmail} skipped (no email)`);
      status.textContent = parts.length > 0 ? parts.join(' · ') : 'Nothing to import.';
      status.className = `hint ${r.imported > 0 ? 'success' : ''}`;
      renderSkippedImports(r.skippedNoEmailList || []);
      await loadRecipients();
      await loadBroadcastRecipients();
    } catch (err) {
      status.textContent = `Import failed: ${err.message}`;
      status.className = 'hint error';
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });

  $('#recipients-table').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-delete]');
    if (del) {
      const id = del.dataset.delete;
      if (!confirm('Delete this recipient?')) return;
      await api(`/api/recipients/${id}`, { method: 'DELETE' });
      loadRecipients();
    }
  });
  $('#recipients-table').addEventListener('change', async (e) => {
    const cb = e.target.closest('[data-active]');
    if (cb) {
      const id = cb.dataset.active;
      await api(`/api/recipients/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: cb.checked })
      });
    }
  });

  // Inline-edit the recipient name: save on blur (when changed) or Enter
  async function saveNameEdit(input) {
    const id = input.dataset.nameId;
    const original = input.dataset.original ?? '';
    const next = input.value.trim();
    if (next === original) return;
    input.classList.add('saving');
    try {
      const updated = await api(`/api/recipients/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next })
      });
      input.dataset.original = updated.name || '';
      input.value = updated.name || '';
      input.classList.remove('saving');
      input.classList.add('saved');
      setTimeout(() => input.classList.remove('saved'), 1200);
    } catch (err) {
      input.classList.remove('saving');
      input.classList.add('error');
      input.value = original;
      setTimeout(() => input.classList.remove('error'), 1500);
    }
  }
  $('#recipients-table').addEventListener('blur', (e) => {
    if (e.target.matches('[data-name-id]')) saveNameEdit(e.target);
  }, true);
  $('#recipients-table').addEventListener('keydown', (e) => {
    if (e.target.matches('[data-name-id]') && e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    } else if (e.target.matches('[data-name-id]') && e.key === 'Escape') {
      e.target.value = e.target.dataset.original ?? '';
      e.target.blur();
    }
  });
}

function bindTest(btnSel, statusSel, endpoint) {
  $(btnSel).addEventListener('click', async () => {
    const status = $(statusSel);
    status.textContent = 'Testing…';
    status.className = 'hint';
    try {
      const r = await api(endpoint, { method: 'POST' });
      status.textContent = r.message || (r.ok ? 'OK' : 'Failed');
      status.className = `hint ${r.ok ? 'success' : 'error'}`;
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
      status.className = 'hint error';
    }
  });
}

function setStatus(sel, text, kind = '') {
  const el = $(sel);
  el.textContent = text;
  el.className = `hint ${kind}`;
}

// --- Compose / broadcast section --------------------------------------------

const broadcastState = {
  recipients: [],         // [{id, email, name, active}]
  selected: new Set(),    // Set<id>
  filter: ''
};

function getBroadcastBody() {
  const wrap = $('#bc-wrap');
  const wrapWithBranding = wrap ? !!wrap.checked : true;
  return {
    subject: ($('#bc-subject').value || '').trim(),
    body_html: $('#bc-body').value || '',
    wrap_with_branding: wrapWithBranding
  };
}

function getBroadcastMode() {
  return document.querySelector('input[name="bc-rcpt-mode"]:checked')?.value || 'all';
}

function selectedBroadcastRecipientIds() {
  return Array.from(broadcastState.selected);
}

function renderBroadcastPicker() {
  const list = $('#bc-picker-list');
  list.innerHTML = '';
  const filter = broadcastState.filter.toLowerCase();
  const filtered = broadcastState.recipients.filter((r) => {
    if (!filter) return true;
    return (r.email || '').toLowerCase().includes(filter) || (r.name || '').toLowerCase().includes(filter);
  });

  if (filtered.length === 0) {
    list.innerHTML = `<div class="bc-picker-empty">${broadcastState.recipients.length === 0 ? 'No recipients yet — add some in the Recipients tab.' : 'No matches.'}</div>`;
    updatePickerCount();
    return;
  }

  for (const r of filtered) {
    const row = document.createElement('label');
    row.className = `bc-picker-row${r.active ? '' : ' inactive'}`;
    const checked = broadcastState.selected.has(r.id) ? 'checked' : '';
    row.innerHTML = `
      <input type="checkbox" ${checked} data-bc-rcpt="${r.id}" />
      <div class="bc-picker-meta">
        <strong>${escapeHtml(r.name || r.email)}</strong>
        <span class="bc-picker-email">${escapeHtml(r.email)}${r.active ? '' : ' · inactive'}</span>
      </div>
    `;
    const cb = row.querySelector('input');
    cb.addEventListener('change', () => {
      if (cb.checked) broadcastState.selected.add(r.id);
      else broadcastState.selected.delete(r.id);
      updatePickerCount();
    });
    list.appendChild(row);
  }
  updatePickerCount();
}

function updatePickerCount() {
  const el = $('#bc-picker-count');
  if (el) el.textContent = `${broadcastState.selected.size} selected`;
}

async function loadBroadcastRecipients() {
  try {
    broadcastState.recipients = await api('/api/recipients');
    const activeCount = broadcastState.recipients.filter((r) => r.active).length;
    const el = $('#bc-active-count');
    if (el) el.textContent = activeCount.toString();
    renderBroadcastPicker();
  } catch (err) {
    console.error('Failed to load broadcast recipients', err);
  }
}

async function broadcastPreview() {
  const status = $('#bc-status');
  const frame = $('#bc-preview-frame');
  const body = getBroadcastBody();
  if (!body.body_html.trim()) {
    setStatus('#bc-status', 'Add some HTML to preview.', 'error');
    return;
  }
  setStatus('#bc-status', 'Rendering preview…');
  try {
    const res = await fetch('/api/broadcast/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    const blob = new Blob([html], { type: 'text/html' });
    if (frame.dataset.url) URL.revokeObjectURL(frame.dataset.url);
    const url = URL.createObjectURL(blob);
    frame.dataset.url = url;
    frame.src = url;
    setStatus('#bc-status', 'Preview updated.', 'success');
  } catch (err) {
    setStatus('#bc-status', `Preview failed: ${err.message}`, 'error');
  }
}

async function broadcastSendTest() {
  const email = ($('#bc-test-email').value || '').trim();
  if (!email) { alert('Enter an email first.'); return; }
  const body = getBroadcastBody();
  if (!body.subject) { setStatus('#bc-status', 'Subject is required.', 'error'); return; }
  if (!body.body_html.trim()) { setStatus('#bc-status', 'Body cannot be empty.', 'error'); return; }
  setStatus('#bc-status', `Sending test to ${email}…`);
  try {
    const r = await api('/api/broadcast/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, test_email: email })
    });
    setStatus('#bc-status', r.ok ? `Test sent to ${email} (${r.durationMs}ms)` : `Failed: ${(r.errors || []).join('; ')}`, r.ok ? 'success' : 'error');
  } catch (err) {
    setStatus('#bc-status', `Test failed: ${err.message}`, 'error');
  }
}

async function broadcastSend() {
  const body = getBroadcastBody();
  if (!body.subject) { setStatus('#bc-status', 'Subject is required.', 'error'); return; }
  if (!body.body_html.trim()) { setStatus('#bc-status', 'Body cannot be empty.', 'error'); return; }

  const mode = getBroadcastMode();
  let recipient_ids;
  let recipientCount;
  if (mode === 'all') {
    recipientCount = broadcastState.recipients.filter((r) => r.active).length;
    recipient_ids = undefined;
  } else {
    recipient_ids = selectedBroadcastRecipientIds();
    recipientCount = recipient_ids.length;
  }
  if (recipientCount === 0) { setStatus('#bc-status', 'No recipients selected.', 'error'); return; }
  if (!confirm(`Send this broadcast to ${recipientCount} recipient${recipientCount === 1 ? '' : 's'}?`)) return;

  setStatus('#bc-status', `Sending to ${recipientCount}…`);
  try {
    const r = await api('/api/broadcast/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, recipient_ids })
    });
    setStatus(
      '#bc-status',
      r.ok ? `Sent to ${r.sent} recipient${r.sent === 1 ? '' : 's'} (${r.durationMs}ms)` : `Sent ${r.sent}, failed ${r.failed}: ${(r.errors || []).slice(0, 2).join('; ')}`,
      r.ok ? 'success' : 'error'
    );
    loadHistory();
  } catch (err) {
    setStatus('#bc-status', `Send failed: ${err.message}`, 'error');
  }
}

function bindBroadcastActions() {
  $('#bc-preview-btn').addEventListener('click', broadcastPreview);
  $('#bc-test-btn').addEventListener('click', broadcastSendTest);
  $('#bc-send-btn').addEventListener('click', broadcastSend);

  for (const radio of document.querySelectorAll('input[name="bc-rcpt-mode"]')) {
    radio.addEventListener('change', () => {
      const mode = getBroadcastMode();
      $('#bc-picker').hidden = mode !== 'some';
      if (mode === 'some') loadBroadcastRecipients();
    });
  }

  $('#bc-picker-search').addEventListener('input', (e) => {
    broadcastState.filter = e.target.value;
    renderBroadcastPicker();
  });
  $('#bc-picker-all').addEventListener('click', () => {
    for (const r of broadcastState.recipients) broadcastState.selected.add(r.id);
    renderBroadcastPicker();
  });
  $('#bc-picker-none').addEventListener('click', () => {
    broadcastState.selected.clear();
    renderBroadcastPicker();
  });
}

// --- AI spend usage ---------------------------------------------------------

function meter(label, used, cap, unit) {
  if (!cap || cap <= 0) {
    return `
      <div>
        <div class="meter-label"><span>${label}</span>
          <span class="meter-value">${used.toLocaleString()} ${unit} · no cap</span></div>
        <div class="meter-track"></div>
      </div>`;
  }
  const pct = Math.min(100, Math.round((used / cap) * 100));
  const cls = pct >= 100 ? 'full' : pct >= 75 ? 'warn' : '';
  return `
    <div>
      <div class="meter-label"><span>${label}</span>
        <span class="meter-value">${used.toLocaleString()} / ${cap.toLocaleString()} ${unit} (${pct}%)</span></div>
      <div class="meter-track"><div class="meter-fill ${cls}" style="width:${pct}%"></div></div>
    </div>`;
}

async function loadAiUsage() {
  const body = $('#ai-usage-body');
  const note = $('#ai-usage-note');
  if (!body) return;
  try {
    const u = await api('/api/ai/usage');
    body.innerHTML = `
      <div class="meter-row">
        ${meter('Billed calls, last 24h', u.callsLast24h, u.dailyCallCap, 'calls')}
        ${meter('Tokens, last 30 days', u.tokensLast30d, u.monthlyTokenCap, 'tokens')}
      </div>
      <div class="usage-facts">
        <div class="usage-fact"><span class="n">${u.callsLast30d.toLocaleString()}</span><span class="k">Calls / 30d</span></div>
        <div class="usage-fact"><span class="n">${u.promptTokensLast30d.toLocaleString()}</span><span class="k">Prompt tokens</span></div>
        <div class="usage-fact"><span class="n">${u.completionTokensLast30d.toLocaleString()}</span><span class="k">Output tokens</span></div>
        <div class="usage-fact"><span class="n">${u.cacheHitsLast30d.toLocaleString()}</span><span class="k">Served from cache</span></div>
        <div class="usage-fact"><span class="n">${u.blockedLast30d.toLocaleString()}</span><span class="k">Blocked by cap</span></div>
        <div class="usage-fact"><span class="n">${u.errorsLast30d.toLocaleString()}</span><span class="k">Failed</span></div>
      </div>`;
    const bits = [];
    if (!u.enabled) bits.push('AI copy is currently off, so nothing new is being billed.');
    if (u.lastCallAt) bits.push(`Last call ${new Date(u.lastCallAt + 'Z').toLocaleString()}.`);
    if (u.errorsLastHour >= 5) bits.push(`${u.errorsLastHour} failures in the last hour — requests are paused until they age out.`);
    else if (u.blockedLast30d > 0) bits.push('Blocked calls fell back to the standard wording — raise a cap if that was unintended.');
    note.textContent = bits.join(' ');
  } catch (err) {
    body.innerHTML = `<span class="hint error">Could not load usage: ${escapeHtml(err.message)}</span>`;
    note.textContent = '';
  }
}

function bindAiUsage() {
  const refresh = $('#ai-usage-refresh');
  if (!refresh) return;
  refresh.addEventListener('click', loadAiUsage);
  $('#ai-cache-clear').addEventListener('click', async () => {
    await api('/api/ai/cache/clear', { method: 'POST' });
    await loadAiUsage();
  });
  $('#ai-usage-reset').addEventListener('click', async () => {
    if (!confirm('Reset the AI usage counters? This clears the rolling windows the caps are measured against.')) return;
    await api('/api/ai/usage/reset', { method: 'POST' });
    await loadAiUsage();
  });
}

(async function init() {
  bindNav();
  bindFieldHandlers();
  bindActions();
  bindBroadcastActions();
  bindSectionOrder();
  bindDeviceToggles();
  bindAiUsage();
  try {
    const s = await api('/api/settings');
    applySettings(s);
    await loadSchedule();
    await loadRecipients();
    await loadBroadcastRecipients();
    await loadAiUsage();
    route(); // render the current page (and its data) once settings are in
  } catch (err) {
    console.error(err);
    document.body.innerHTML = `<pre style="padding:24px;color:#f87171;">Failed to load: ${escapeHtml(err.message)}</pre>`;
  }
})();

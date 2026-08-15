/* RD Agent Management System: all financial state stays on the server. */
const state = {
  agent: null,
  csrf: null,
  view: 'dashboard',
  customerPage: 1,
  customers: [],
  collectionRows: [],
  pendingCustomers: [],
  backups: [],
  profile: null,
  report: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const localToday = new Date();
const currentMonth = `${localToday.getFullYear()}-${String(localToday.getMonth() + 1).padStart(2, '0')}`;
const todayIso = localToday.toISOString().slice(0, 10);

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
function money(value) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value || 0));
}
function period(month, year) {
  return new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric' }).format(new Date(Number(year), Number(month) - 1, 1));
}
function calendarDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}
function formatCalendarDate(value) {
  if (!value) return '-';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const [, y, m, d] = match;
    return `${d}/${m}/${y}`;
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const d = String(parsed.getDate()).padStart(2, '0');
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const y = parsed.getFullYear();
    return `${d}/${m}/${y}`;
  }
  return value;
}
function remainingDuration(maturityDate) {
  const target = calendarDate(maturityDate);
  if (!target) return 'Duration unavailable';
  const now = new Date(Date.UTC(localToday.getFullYear(), localToday.getMonth(), localToday.getDate()));
  let months = ((target.getUTCFullYear() - now.getUTCFullYear()) * 12) + target.getUTCMonth() - now.getUTCMonth();
  if (target.getUTCDate() < now.getUTCDate()) months -= 1;
  if (months < 0) return 'Matured';
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  const parts = [];
  if (years) parts.push(`${years} year${years === 1 ? '' : 's'}`);
  if (remainder || !parts.length) parts.push(`${remainder} month${remainder === 1 ? '' : 's'}`);
  return `Remaining: ${parts.join(', ')}`;
}
function statusTag(status) {
  return `<span class="status ${escapeHtml(status).toLowerCase()}">${escapeHtml(status)}</span>`;
}
function emptyRow(columns, message) {
  return `<tr><td colspan="${columns}" class="empty">${escapeHtml(message)}</td></tr>`;
}
function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('#toast-region').append(node);
  setTimeout(() => node.remove(), 4200);
}

const REFRESH_TOKEN_KEY = 'rdagent_refresh_token';
const tokenStorage = {
  async get() {
    try {
      if (window.Capacitor?.Plugins?.Preferences) {
        const { value } = await window.Capacitor.Plugins.Preferences.get({ key: REFRESH_TOKEN_KEY });
        if (value) return value;
      }
    } catch { /* fall back to web storage */ }
    try { return localStorage.getItem(REFRESH_TOKEN_KEY); } catch { return null; }
  },
  async set(token) {
    try {
      if (window.Capacitor?.Plugins?.Preferences) {
        await window.Capacitor.Plugins.Preferences.set({ key: REFRESH_TOKEN_KEY, value: token });
        return;
      }
    } catch { /* fall back to web storage */ }
    try { localStorage.setItem(REFRESH_TOKEN_KEY, token); } catch { /* ignore */ }
  },
  async clear() {
    try {
      if (window.Capacitor?.Plugins?.Preferences) {
        await window.Capacitor.Plugins.Preferences.remove({ key: REFRESH_TOKEN_KEY });
        return;
      }
    } catch { /* fall back to web storage */ }
    try { localStorage.removeItem(REFRESH_TOKEN_KEY); } catch { /* ignore */ }
  },
};

async function attemptSessionRefresh() {
  const token = await tokenStorage.get();
  if (!token) return false;
  try {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: token }),
    });
    if (!response.ok) return false;
    const data = await response.json();
    await tokenStorage.set(data.refresh_token);
    state.csrf = data.csrf_token;
    state.agent = data.agent;
    return true;
  } catch {
    return false;
  }
}

async function api(url, options = {}) {
  const config = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
  if (options.body && !(options.body instanceof FormData) && typeof options.body !== 'string') {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(options.body);
  }
  if (state.csrf && !['GET', 'HEAD'].includes((config.method || 'GET').toUpperCase())) config.headers['X-CSRF-Token'] = state.csrf;
  const isAuthCall = url.startsWith('/api/auth/login') || url.startsWith('/api/auth/register');
  const isBackground = url.includes('/automatic');
  
  let activeBtn = null;
  if (!isBackground) {
    activeBtn = document.activeElement && document.activeElement.tagName === 'BUTTON' ? document.activeElement : null;
    if (activeBtn) {
      activeBtn.disabled = true;
      activeBtn.classList.add('loading-state');
    }
    document.body.classList.add('is-loading');
  }

  let response;
  try {
    response = await fetch(url, config);
    if (response.status === 401 && !isAuthCall && url !== '/api/auth/refresh') {
      const restored = await attemptSessionRefresh();
      if (restored) {
        if (state.csrf && !['GET', 'HEAD'].includes((config.method || 'GET').toUpperCase())) config.headers['X-CSRF-Token'] = state.csrf;
        response = await fetch(url, config);
      }
    }
  } finally {
    if (!isBackground) {
      document.body.classList.remove('is-loading');
      if (activeBtn) {
        activeBtn.disabled = false;
        activeBtn.classList.remove('loading-state');
      }
    }
  }

  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401 && !isAuthCall) {
      await tokenStorage.clear();
      showAuth();
    }
    throw new Error(data?.error || `Request failed (${response.status})`);
  }
  return data;
}

function refreshAgentHeader() {
  $('#agent-name').textContent = state.agent.name;
  $('#agent-initial').textContent = state.agent.name.slice(0, 1).toUpperCase();
}
function showAuth(mode = 'login') {
  state.agent = null;
  state.csrf = null;
  $('#app-shell').classList.add('hidden');
  $('#auth-shell').classList.remove('hidden');
  $('#login-form').classList.toggle('hidden', mode !== 'login');
  $('#register-form').classList.toggle('hidden', mode !== 'register');
}
function showApp(agent, csrf) {
  state.agent = agent;
  state.csrf = csrf;
  $('#auth-shell').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  refreshAgentHeader();
  const profileControl = $('.agent-menu');
  profileControl.setAttribute('role', 'button');
  profileControl.setAttribute('tabindex', '0');
  profileControl.setAttribute('aria-label', 'Open agent profile');
  setView('dashboard');
  maybeAutomaticBackup();
}
function openSidebar() {
  $('#sidebar')?.classList.add('open');
  $('#sidebar-overlay')?.classList.add('active');
}
function closeSidebar() {
  $('#sidebar')?.classList.remove('open');
  $('#sidebar-overlay')?.classList.remove('active');
}
function toggleSidebar() {
  const sidebar = $('#sidebar');
  if (sidebar?.classList.contains('open')) {
    closeSidebar();
  } else {
    openSidebar();
  }
}
function handleBackAction() {
  if ($('#modal-root')?.innerHTML.trim() !== '') {
    closeModal();
    return true;
  }
  const sidebar = $('#sidebar');
  if (sidebar && sidebar.classList.contains('open')) {
    closeSidebar();
    return true;
  }
  if (state.view && state.view !== 'dashboard') {
    setView('dashboard', false);
    return true;
  }
  return false;
}
function setView(view, pushHistory = true) {
  state.view = view;
  $$('.view').forEach(element => element.classList.toggle('active', element.id === `view-${view}`));
  $$('[data-view]').forEach(element => element.classList.toggle('active', element.dataset.view === view));
  closeSidebar();
  const info = {
    dashboard: ['OVERVIEW', 'Dashboard'],
    collections: ['MONTHLY COLLECTIONS', 'Collection register'],
    customers: ['CUSTOMER RECORDS', 'Customers'],
    pending: ['FOLLOW UP', 'Pending collections'],
    reports: ['ANALYTICS', 'Reports'],
    backups: ['DATA SAFETY', 'Backup & restore'],
  }[view];
  if (info) {
    $('#page-kicker').textContent = info[0];
    $('#page-title').textContent = info[1];
  }
  if (pushHistory && view !== 'dashboard') {
    history.pushState({ view }, '');
  }
  ({ dashboard: loadDashboard, collections: loadCollections, customers: loadCustomers, pending: loadPending, reports: loadReport, backups: loadBackups }[view])?.();
}

async function loadDashboard() {
  try {
    const result = await api('/api/dashboard/');
    $('#period-label').textContent = `Collection status for ${period(result.period.month, result.period.year)}`;
    const metrics = [
      ['Total customers', result.metrics.total_customers, 'Active accounts', `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>`, 'green'],
      ['Paid customers', result.metrics.paid_customers, 'Installments completed', `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`, 'green'],
      ['Partly paid', result.metrics.partial_customers, 'Balance still pending', `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>`, 'blue'],
      ['Pending collections', result.metrics.pending_count, 'Follow-up required', `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`, 'orange'],
      ['Total collection amount', money(result.metrics.collection), 'Amount received so far', `<span style="font-weight:800;font-size:0.95rem;">₹</span>`, 'teal'],
    ];
    $('#metric-grid').innerHTML = metrics.map(([label, value, note, icon, color]) => `<article class="metric"><div class="metric-header"><span class="metric-icon-badge ${color}">${icon}</span><div class="metric-label">${label}</div></div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></article>`).join('');
    $('#recent-table').innerHTML = result.recent_transactions.length
      ? result.recent_transactions.map(item => `<tr><td><div style="display:flex;align-items:center;gap:0.5rem;"><div class="avatar-sm"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div><div><strong>${escapeHtml(item.customer_name)}</strong><small>${escapeHtml(item.account_number)}</small></div></div></td><td>${formatCalendarDate(item.payment_date)}</td><td class="right"><strong class="amount-green">${money(item.amount)}</strong></td></tr>`).join('')
      : emptyRow(3, 'No payments have been recorded yet.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function selectedCollectionPeriod() {
  const [year, month] = ($('#collection-month').value || currentMonth).split('-');
  return { year: Number(year), month: Number(month) };
}
function receiptMarkup(receipts) {
  return receipts.length
    ? `<div class="receipt-list">${receipts.map(receipt => `<div><code>${escapeHtml(receipt.receipt_number)}</code><small>${money(receipt.amount)} · ${formatCalendarDate(receipt.payment_date)}</small></div>`).join('')}</div>`
    : '<span class="muted">No receipt yet</span>';
}
async function loadCollections() {
  try {
    if (!$('#collection-month').value) $('#collection-month').value = currentMonth;
    const { month, year } = selectedCollectionPeriod();
    const result = await api(`/api/collections/?month=${month}&year=${year}`);
    state.collectionRows = result.collections;
    const metrics = [
      ['Total customers', result.summary.total_customers, 'Active accounts', `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>`, 'green'],
      ['Paid customers', result.summary.paid_customers, 'Installments completed', `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`, 'green'],
      ['Partly paid', result.summary.partial_customers, 'Balance still pending', `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>`, 'blue'],
      ['Pending customers', result.summary.pending_customers, 'No amount collected', `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`, 'orange'],
      ['Total collection amount', money(result.summary.total_collection_amount), 'Amount received so far', `<span style="font-weight:800;font-size:0.95rem;">₹</span>`, 'teal'],
    ];
    $('#collection-metrics').innerHTML = metrics.map(([label, value, note, icon, color]) => `<article class="metric"><div class="metric-header"><span class="metric-icon-badge ${color}">${icon}</span><div class="metric-label">${label}</div></div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></article>`).join('');
    $('#collections-table').innerHTML = result.collections.length
      ? result.collections.map(item => {
        const customer = item.customer;
        const title = item.is_paid ? 'Installment fully paid and permanently locked' : item.is_partial ? 'Add another amount to complete this installment' : 'Record an amount collected';
        const editCell = item.payment ? `<button class="danger-action" data-collection-off="${customer.id}">OFF</button>` : '<span class="muted">—</span>';
        return `<tr><td><label class="collection-check" title="${title}"><input type="checkbox" data-collection-toggle="${customer.id}" ${item.is_paid ? 'checked disabled' : ''} aria-label="Record collection for ${escapeHtml(customer.customer_name)}" /><span></span></label></td><td><strong>${escapeHtml(customer.customer_name)}</strong><small>${escapeHtml(customer.phone)}</small></td><td>${escapeHtml(customer.account_number)}</td><td>${money(customer.monthly_rd_amount)}</td><td>${statusTag(item.status)}</td><td class="right"><div class="row-actions">${editCell}</div></td></tr>`;
      }).join('')
      : emptyRow(6, 'No active RD accounts have a term covering this collection month.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadCustomers() {
  try {
    const search = $('#customer-search').value.trim();
    const status = $('#customer-status').value;
    const query = new URLSearchParams({ page: state.customerPage, per_page: 10 });
    if (search) query.set('search', search);
    if (status) query.set('status', status);
    const result = await api(`/api/customers/?${query}`);
    state.customers = result.customers;
    $('#customers-table').innerHTML = result.customers.length
      ? result.customers.map(customer => `<tr><td><strong>${escapeHtml(customer.customer_name)}</strong><small>${escapeHtml(customer.phone)}</small></td><td>${escapeHtml(customer.account_number)}</td><td>${money(customer.monthly_rd_amount)}</td><td>${formatCalendarDate(customer.start_date)} - ${formatCalendarDate(customer.maturity_date)}<small>${escapeHtml(remainingDuration(customer.maturity_date))}</small></td><td>${statusTag(customer.status)}</td><td class="right"><div class="row-actions"><button data-customer-view="${customer.id}">View</button>${customer.status !== 'archived' ? `<button data-customer-edit="${customer.id}">Edit</button>` : ''}${customer.status === 'closed' ? `<button class="danger-action" data-customer-delete="${customer.id}">Delete</button>` : ''}</div></td></tr>`).join('')
      : emptyRow(6, 'No customers match this view.');
    const page = result.pagination;
    $('#customer-pagination').innerHTML = `<span>${page.total} record${page.total === 1 ? '' : 's'} · Page ${page.page} of ${Math.max(page.pages, 1)}</span><button data-page="${page.page - 1}" ${page.page <= 1 ? 'disabled' : ''}>Previous</button><button data-page="${page.page + 1}" ${page.page >= page.pages ? 'disabled' : ''}>Next</button>`;
  } catch (error) {
    toast(error.message, 'error');
  }
}

function selectedPendingPeriod() {
  const [year, month] = ($('#pending-month').value || currentMonth).split('-');
  return { year: Number(year), month: Number(month) };
}
async function loadPending() {
  try {
    if (!$('#pending-month').value) $('#pending-month').value = currentMonth;
    const { month, year } = selectedPendingPeriod();
    const search = $('#pending-search').value.trim();
    const query = new URLSearchParams({ month, year });
    if (search) query.set('search', search);
    const result = await api(`/api/dashboard/pending?${query}`);
    state.pendingCustomers = result.customers;
    $('#pending-summary').textContent = `${result.customers.length} customer${result.customers.length === 1 ? '' : 's'} pending for ${period(month, year)}`;
    $('#pending-table').innerHTML = result.customers.length
      ? result.customers.map(item => {
        const customer = item.customer;
        return `<tr><td><strong>${escapeHtml(customer.customer_name)}</strong></td><td>${escapeHtml(customer.account_number)}</td><td>${escapeHtml(customer.phone)}</td><td>${money(customer.monthly_rd_amount)}</td><td>${money(item.paid_amount)}</td><td><strong>${money(item.remaining_amount)}</strong></td><td>${statusTag(item.status)}</td><td class="right"><div class="row-actions"><button data-reminder="${customer.id}">Copy reminder</button><button data-pending-receipt="${customer.id}">Record amount</button></div></td></tr>`;
      }).join('')
      : emptyRow(8, 'All due active customers have fully paid for this month.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function backupDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}
function setBackupNetworkStatus() {
  const status = $('#backup-network-status');
  if (!status) return;
  if (navigator.onLine) {
    status.textContent = 'Online — automatic backups are enabled.';
    status.className = 'backup-status online';
  } else {
    status.textContent = 'Offline — the next automatic backup will run when internet returns.';
    status.className = 'backup-status offline';
  }
}
function renderBackups() {
  const table = $('#internal-backups-table');
  const summary = $('#backup-summary');
  if (!table || !summary) return;
  summary.textContent = `${state.backups.length} saved backup${state.backups.length === 1 ? '' : 's'}`;
  table.innerHTML = state.backups.length
    ? state.backups.map(backup => `<tr><td>${escapeHtml(backupDate(backup.created_at))}</td><td>${statusTag(backup.trigger)}</td><td>${backup.customer_count}</td><td>${backup.payment_count}</td><td>${backup.receipt_count}</td><td class="right"><div class="row-actions"><button data-restore-internal-backup="${backup.id}">Restore</button></div></td></tr>`).join('')
    : emptyRow(6, 'No internal backup has been saved yet. Connect to the internet or select Back up now.');
}
async function maybeAutomaticBackup() {
  if (!state.agent || !navigator.onLine) {
    setBackupNetworkStatus();
    return null;
  }
  try {
    const result = await api('/api/backups/internal/automatic', { method: 'POST' });
    return result;
  } catch {
    // Automatic backup will be retried on the next page load or online event.
    return null;
  } finally {
    setBackupNetworkStatus();
  }
}
async function loadBackups() {
  try {
    setBackupNetworkStatus();
    let result = await api('/api/backups/internal');
    state.backups = result.backups;
    const automaticResult = await maybeAutomaticBackup();
    if (automaticResult?.created) {
      result = await api('/api/backups/internal');
      state.backups = result.backups;
    }
    renderBackups();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function reportQuery(format) {
  const type = $('#report-type').value;
  const params = new URLSearchParams({ type });
  if (type !== 'customers') {
    const [year, month] = ($('#report-month').value || currentMonth).split('-');
    params.set('month', month);
    params.set('year', year);
  }
  if (format) params.set('format', format);
  return params;
}
function renderReportTable(searchTerm = '') {
  if (!state.report) return;
  const term = searchTerm.trim().toLowerCase();
  const filteredRows = term
    ? state.report.rows.filter(row =>
        state.report.columns.some(col => String(row[col] ?? '').toLowerCase().includes(term))
      )
    : state.report.rows;

  const thead = `<thead><tr>${state.report.columns.map(column => `<th>${escapeHtml(column.replaceAll('_', ' '))}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${filteredRows.length ? filteredRows.map(row => `<tr>${state.report.columns.map(column => `<td>${escapeHtml(row[column] ?? '')}</td>`).join('')}</tr>`).join('') : emptyRow(state.report.columns.length, term ? 'No report records match your search.' : 'There are no records for this report.')}</tbody>`;
  $('#report-table').innerHTML = thead + tbody;
}

async function loadReport() {
  try {
    if (!$('#report-month').value) $('#report-month').value = currentMonth;
    const result = await api(`/api/reports/?${reportQuery()}`);
    state.report = result;
    $('#report-period-field').classList.toggle('hidden', $('#report-type').value === 'customers');
    $('#report-summary').innerHTML = Object.entries(result.summary).map(([key, value]) => `<div class="report-stat-item"><span>${escapeHtml(key.replaceAll('_', ' '))}</span><strong>${key.includes('collection') || key.includes('collected') ? money(value) : escapeHtml(value)}</strong></div>`).join('');
    const searchVal = $('#report-search')?.value || '';
    renderReportTable(searchVal);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openModal(title, subtitle, body, footer = '') {
  $('#modal-root').innerHTML = `<div class="modal-overlay" role="dialog" aria-modal="true"><section class="modal"><header class="modal-header"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div><button class="modal-close" data-close-modal aria-label="Close">x</button></header><div class="modal-body">${body}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}</section></div>`;
  history.pushState({ modal: true }, '');
}
function closeModal() {
  $('#modal-root').innerHTML = '';
}
function openAgentProfile() {
  if (!state.agent) return;
  const agent = state.agent;
  openModal('Agent profile', 'Your signed-in RD collection account.', `<div class="agent-profile-card"><div class="profile-avatar">${escapeHtml(agent.name.slice(0, 1).toUpperCase())}</div><div><h4>${escapeHtml(agent.name)}</h4><p>RD Agent</p></div></div><div class="profile-summary agent-profile-details"><div>Phone number<strong>${escapeHtml(agent.phone)}</strong></div><div>Email address<strong>${escapeHtml(agent.email || 'Not provided')}</strong></div><div>Account access<strong>Active session</strong></div></div>`, '<button class="button danger" type="button" data-delete-agent-account>Delete agent account</button><button class="button secondary" type="button" data-edit-agent-profile>Edit profile</button><button class="button primary" type="button" data-close-modal>Close</button>');
}
function openAgentProfileEdit() {
  if (!state.agent) return;
  const agent = state.agent;
  openModal('Edit agent profile', 'Contact changes are retained in the audit log.', `<form id="agent-profile-form"><div class="form-grid"><label class="full">Full name<input name="name" required maxlength="120" value="${escapeHtml(agent.name)}" /></label><label>Phone number<input name="phone" type="tel" inputmode="tel" required maxlength="30" value="${escapeHtml(agent.phone)}" /></label><label>Email <span class="optional-label">(optional)</span><input name="email" type="email" maxlength="255" value="${escapeHtml(agent.email || '')}" placeholder="you@example.com" /></label></div><footer class="modal-footer"><button class="button secondary" type="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Save profile</button></footer></form>`);
}
function customerForm(customer = {}) {
  const value = (name, fallback = '') => escapeHtml(customer[name] ?? fallback);
  return `<form id="customer-form"><div class="form-grid"><label class="full">Customer name<input name="customer_name" required maxlength="160" placeholder="Enter full name" value="${value('customer_name')}" /></label><label>Account number<input name="account_number" required maxlength="64" placeholder="Enter account number" value="${value('account_number')}" /></label><label>Phone<input name="phone" required maxlength="30" placeholder="Enter phone number" value="${value('phone')}" /></label><label>Monthly RD amount<input name="monthly_rd_amount" type="number" min="0.01" max="9999999999.99" step="0.01" required placeholder="Enter monthly RD amount" value="${value('monthly_rd_amount')}" /></label><label>Status<select name="status"><option value="active" ${customer.status === 'active' || !customer.status ? 'selected' : ''}>Active</option><option value="matured" ${customer.status === 'matured' ? 'selected' : ''}>Matured</option><option value="closed" ${customer.status === 'closed' ? 'selected' : ''}>Closed</option></select></label><label>Start date<input name="start_date" type="text" placeholder="YYYY-MM-DD or DD/MM/YYYY" required value="${value('start_date')}" /></label><label>Maturity date<input name="maturity_date" type="text" placeholder="YYYY-MM-DD or DD/MM/YYYY" required value="${value('maturity_date')}" /></label></div><footer class="modal-footer"><button class="button secondary" type="button" data-close-modal>Cancel</button><button class="button primary" type="submit">${customer.id ? 'Save changes' : 'Create customer'}</button></footer></form>`;
}
function openCustomerModal(customer) {
  openModal(customer ? 'Edit customer' : 'Add customer', customer ? 'Changes are permanently retained in the audit log.' : 'Create a new RD customer account.', customerForm(customer));
}
function openDeleteCustomerModal(customer) {
  openModal('Delete customer', `Account ${customer.account_number} · ${customer.status}. This permanently removes the customer and all their records.`, `<div class="notice-panel"><strong>This action is permanent</strong><p>The customer profile, every payment, every receipt, and all related history will be permanently deleted. This cannot be undone.</p></div><form id="delete-customer-form" data-customer-id="${customer.id}"><label>Type DELETE to confirm deletion<input name="confirmation" required maxlength="20" placeholder="DELETE" autocomplete="off" /></label><footer class="modal-footer"><button class="button secondary" type="button" data-close-modal>Cancel</button><button class="button danger" type="submit">Delete customer permanently</button></footer></form>`);
}
function openDeleteAccountModal() {
  openModal('Delete agent account', 'This permanently removes your account and all your customer and financial records.', `<div class="notice-panel"><strong>Irreversible action</strong><p>Your account, every customer, every collection, every receipt, backup, and audit record will be permanently deleted. This cannot be undone.</p></div><form id="verify-delete-account-form"><label>Enter your password to continue<input name="password" type="password" required maxlength="128" placeholder="Your current password" /></label><footer class="modal-footer"><button class="button secondary" type="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Verify password</button></footer></form><div id="delete-account-step-2" class="hidden"><form id="confirm-delete-account-form"><p class="muted">Type <strong>DELETE</strong> to permanently delete your account.</p><label>Confirmation<input name="confirmation" required maxlength="20" placeholder="DELETE" autocomplete="off" /></label><footer class="modal-footer"><button class="button secondary" type="button" data-close-modal>Cancel</button><button class="button danger" type="submit">Permanently delete my account</button></footer></form></div>`);
}
function openCollectionOffModal(customerId) {
  const item = state.collectionRows.find(row => row.customer.id === customerId);
  if (!item || !item.payment) return;
  const customer = item.customer;
  const { month, year } = selectedCollectionPeriod();
  openModal('Undo Payment Mark?', `This will remove the paid mark for ${customer.customer_name} for ${period(month, year)}.`, `<form id="collection-off-form" data-customer-id="${customer.id}" data-month="${month}" data-year="${year}"><div class="notice-panel"><strong>Removes only this paid mark</strong><p>This undoes the paid mark for ${escapeHtml(customer.customer_name)} for ${period(month, year)}. The installment returns to its pending state. No other customer, payment, or month is affected.</p></div><footer class="modal-footer"><button class="button secondary" type="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Undo / Confirm</button></footer></form>`);
}

function receiptForm(customer, summary, month, year) {
  const remaining = summary?.remaining_amount ?? customer.monthly_rd_amount;
  const paid = summary?.paid_amount ?? '0.00';
  return `<form id="receipt-form" data-customer-id="${customer.id}" data-remaining="${escapeHtml(remaining)}">
    <div class="receipt-summary-grid">
      <div class="summary-stat"><span class="stat-label">Monthly RD</span><strong class="stat-value text-green">${money(customer.monthly_rd_amount)}</strong></div>
      <div class="summary-stat"><span class="stat-label">Collected so far</span><strong class="stat-value">${money(paid)}</strong></div>
      <div class="summary-stat"><span class="stat-label">Amount remaining</span><strong class="stat-value text-green">${money(remaining)}</strong></div>
    </div>
    <div class="form-grid">
      <label class="full">Installment month<input name="period" type="month" required value="${year}-${String(month).padStart(2, '0')}" /></label>
      <label class="full">Amount received<input name="amount" type="number" min="0.01" max="${escapeHtml(remaining)}" step="0.01" required value="${escapeHtml(remaining)}" /></label>
      <label class="full">Collection date<input name="payment_date" type="date" max="${todayIso}" required value="${todayIso}" /></label>
    </div>
    <p class="muted font-sm">A receipt is created for this amount. Recorded receipts cannot be changed or removed.</p>
    <footer class="modal-footer">
      <button class="button secondary" type="button" data-close-modal>Cancel</button>
      <button class="button primary" type="submit">Record amount and generate receipt</button>
    </footer>
  </form>`;
}
function openReceiptModal(customer, summary, periodInfo) {
  const { month, year } = periodInfo;
  openModal(`Record collection - ${customer.customer_name}`, `Account ${customer.account_number}. Enter the cash amount received for ${period(month, year)}.`, receiptForm(customer, summary, month, year));
}
function openCollectionReceiptModal(customerId) {
  const item = state.collectionRows.find(row => row.customer.id === customerId);
  if (!item || item.is_paid) return;
  openReceiptModal(item.customer, item, selectedCollectionPeriod());
}
function openPendingReceiptModal(customerId) {
  const item = state.pendingCustomers.find(row => row.customer.id === customerId);
  if (!item) return;
  openReceiptModal(item.customer, item, selectedPendingPeriod());
}
async function openPaymentModal(customerId) {
  try {
    const result = await api(`/api/customers/${customerId}`);
    const customer = result.customer;
    if (customer.status !== 'active') return toast('Payments can only be recorded for active customers.', 'error');
    const { month, year } = selectedCollectionPeriod();
    const matchingPayment = result.payments.find(payment => payment.month === month && payment.year === year);
    openReceiptModal(customer, matchingPayment, { month, year });
  } catch (error) {
    toast(error.message, 'error');
  }
}
function calculatePendingMonths(customer, payments) {
  if (!customer.start_date || !customer.maturity_date) return { count: 0, outstanding: '0.00', advance: '0.00', advanceMonths: 0, totalPaid: '0.00' };
  const [startYear, startMonth] = customer.start_date.split('-').map(Number);
  const [matYear, matMonth] = customer.maturity_date.split('-').map(Number);
  if (!startYear || !matYear) return { count: 0, outstanding: '0.00', advance: '0.00', advanceMonths: 0, totalPaid: '0.00' };

  const now = new Date();
  const currentY = now.getFullYear();
  const currentM = now.getMonth() + 1;

  let currY = startYear;
  let currM = startMonth;
  let pendingCount = 0;
  let outstanding = 0;
  let dueMonthsCount = 0;
  const monthly = Number(customer.monthly_rd_amount || 0);

  while (currY < currentY || (currY === currentY && currM <= currentM)) {
    if (currY > matYear || (currY === matYear && currM > matMonth)) break;
    dueMonthsCount++;
    const payment = payments.find(p => p.year === currY && p.month === currM);
    if (!payment) {
      pendingCount++;
      outstanding += monthly;
    } else if (!payment.is_paid) {
      pendingCount++;
      outstanding += Number(payment.remaining_amount || 0);
    }
    currM++;
    if (currM > 12) {
      currM = 1;
      currY++;
    }
  }

  const totalPaid = payments.reduce((sum, p) => sum + Number(p.paid_amount || 0), 0);
  const expectedDueTotal = dueMonthsCount * monthly;
  let advance = 0;
  let advanceMonths = 0;
  if (totalPaid > expectedDueTotal) {
    advance = totalPaid - expectedDueTotal;
    advanceMonths = monthly > 0 ? Math.floor(advance / monthly) : 0;
  }

  return {
    count: pendingCount,
    outstanding: outstanding.toFixed(2),
    advance: advance.toFixed(2),
    advanceMonths: advanceMonths,
    totalPaid: totalPaid.toFixed(2),
  };
}

function normalizeDateInput(val) {
  if (!val || typeof val !== 'string') return val;
  const str = val.trim();
  const parts = str.split(/[\/\-\.]/);
  if (parts.length === 3) {
    if (parts[2].length === 4 && parts[0].length <= 2) {
      const d = parts[0].padStart(2, '0');
      const m = parts[1].padStart(2, '0');
      const y = parts[2];
      return `${y}-${m}-${d}`;
    }
    if (parts[0].length === 4) {
      const y = parts[0];
      const m = parts[1].padStart(2, '0');
      const d = parts[2].padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }
  return str;
}

async function openCustomerProfile(customerId, showAllReceipts = false) {
  try {
    const result = await api(`/api/customers/${customerId}`);
    const customer = result.customer;
    state.profile = result;
    state.profileShowAllReceipts = showAllReceipts;
    const receipts = result.payments.flatMap(p => (p.receipts || []).map(r => ({ ...r, month: p.month, year: p.year })));
    const pendingInfo = calculatePendingMonths(customer, result.payments);
    const bodyHtml = `
      <div class="customer-detail-cards">
        <div class="detail-card">
          <div class="detail-card-title">Account information</div>
          <div class="detail-grid-2">
            <div><div class="detail-item-label">Account number</div><div class="detail-item-value">${escapeHtml(customer.account_number)}</div></div>
            <div><div class="detail-item-label">Monthly RD amount</div><div class="detail-item-value">${money(customer.monthly_rd_amount)} ${statusTag(customer.status)}</div></div>
          </div>
        </div>
        <div class="detail-card">
          <div class="detail-card-title">RD term</div>
          <div class="detail-grid-2">
            <div><div class="detail-item-label">Start date</div><div class="detail-item-value">${formatCalendarDate(customer.start_date)}</div></div>
            <div><div class="detail-item-label">Maturity date</div><div class="detail-item-value">${formatCalendarDate(customer.maturity_date)}</div></div>
          </div>
          <div style="margin-top:0.5rem;"><div class="detail-item-label">Remaining term</div><div class="detail-item-value" style="font-size:0.8125rem;">${escapeHtml(remainingDuration(customer.maturity_date))}</div></div>
        </div>
        <div class="detail-card">
          <div class="detail-card-title">Collection summary</div>
          <div class="summary-tile-grid">
            <div class="stat-tile">
              <div class="detail-item-label">Total paid</div>
              <div class="detail-item-value text-green">${money(pendingInfo.totalPaid)}</div>
            </div>
            <div class="stat-tile">
              <div class="detail-item-label">Pending months</div>
              <div class="detail-item-value ${pendingInfo.count > 0 ? 'text-amber' : 'text-green'}">
                ${pendingInfo.count} month${pendingInfo.count === 1 ? '' : 's'}
              </div>
            </div>
            <div class="stat-tile">
              <div class="detail-item-label">Outstanding</div>
              <div class="detail-item-value ${Number(pendingInfo.outstanding) > 0 ? 'text-amber' : ''}">
                ${money(pendingInfo.outstanding)}
              </div>
            </div>
            <div class="stat-tile">
              <div class="detail-item-label">Advance paid</div>
              <div class="detail-item-value ${Number(pendingInfo.advance) > 0 ? 'text-green' : ''}">
                ${money(pendingInfo.advance)} ${pendingInfo.advanceMonths > 0 ? `<small style="font-size:0.7rem;color:var(--green-text);font-weight:700;">(${pendingInfo.advanceMonths}m)</small>` : ''}
              </div>
            </div>
          </div>
        </div>
        <div class="detail-card">
          <div class="detail-card-title" style="display:flex;justify-content:space-between;align-items:center;">
            <span>${showAllReceipts ? `All receipts (${receipts.length})` : 'Recent receipts'}</span>
            ${receipts.length > 3 ? `<button type="button" class="text-button" data-toggle-receipts="${customer.id}">${showAllReceipts ? 'Show recent' : 'View all →'}</button>` : ''}
          </div>
          ${receipts.length ? `<div class="receipts-scroll-list">${(showAllReceipts ? receipts : receipts.slice(0, 3)).map(r => `<div class="receipt-item-row"><div><strong>${formatCalendarDate(r.payment_date)}</strong><small>${escapeHtml(r.receipt_number)}</small></div><strong class="amount-green">${money(r.amount)}</strong></div>`).join('')}</div>` : '<div class="muted font-sm">No receipts yet</div>'}
        </div>
      </div>
    `;
    openModal(customer.customer_name, `Account ${customer.account_number} · ${customer.status}`, bodyHtml, `<button class="button secondary" type="button" data-customer-edit="${customer.id}">Edit customer</button><button class="button primary" type="button" data-customer-payment="${customer.id}">Record collection</button>`);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function submitCustomer(form) {
  const customerId = form.dataset.customerId;
  const rawData = Object.fromEntries(new FormData(form));
  if (rawData.start_date) rawData.start_date = normalizeDateInput(rawData.start_date);
  if (rawData.maturity_date) rawData.maturity_date = normalizeDateInput(rawData.maturity_date);
  try {
    await api(customerId ? `/api/customers/${customerId}` : '/api/customers/', { method: customerId ? 'PUT' : 'POST', body: rawData });
    toast(customerId ? 'Customer updated and audit logged.' : 'Customer account created.');
    closeModal();
    await loadCustomers();
    if (state.view === 'dashboard') loadDashboard();
    maybeAutomaticBackup();
  } catch (error) {
    toast(error.message, 'error');
  }
}
async function submitReceipt(form) {
  const values = Object.fromEntries(new FormData(form));
  const [year, month] = values.period.split('-').map(Number);
  const amount = Number(values.amount);
  const remaining = Number(form.dataset.remaining);
  if (!year || !month || !amount || !values.payment_date) return toast('Complete the collection amount and date.', 'error');
  if (amount > remaining + 0.00001) return toast(`Amount cannot exceed the remaining balance of ${money(remaining)}.`, 'error');
  if (!window.confirm(`Record ${money(values.amount)} as a financial collection? A receipt will be generated and cannot be changed or removed.`)) return;
  try {
    const result = await api(`/api/collections/customers/${form.dataset.customerId}/receipts`, { method: 'POST', body: { month, year, amount: values.amount, payment_date: values.payment_date } });
    toast(result.action === 'completed' ? `Installment completed. Receipt ${result.receipt.receipt_number} recorded.` : `Partial amount recorded. Receipt ${result.receipt.receipt_number} generated.`);
    closeModal();
    await Promise.all([loadCollections(), loadDashboard()]);
    if (state.view === 'pending') loadPending();
    maybeAutomaticBackup();
  } catch (error) {
    toast(error.message, 'error');
  }
}

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.id === 'login-form' || form.id === 'register-form') {
    const endpoint = form.id === 'login-form' ? '/api/auth/login' : '/api/auth/register';
    try {
      const result = await api(endpoint, { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      await tokenStorage.set(result.refresh_token);
      showApp(result.agent, result.csrf_token);
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  if (form.id === 'customer-form') return submitCustomer(form);
  if (form.id === 'receipt-form') return submitReceipt(form);
  if (form.id === 'delete-customer-form') {
    const values = Object.fromEntries(new FormData(form));
    if (values.confirmation !== 'DELETE') return toast('Type DELETE to confirm customer deletion.', 'error');
    if (!window.confirm('This permanently deletes the customer and all their payments, receipts, and history. Continue?')) return;
    try {
      await api(`/api/customers/${form.dataset.customerId}/delete`, { method: 'POST', body: values });
      toast('Customer permanently deleted.');
      closeModal();
      await Promise.all([loadCustomers(), loadDashboard()]);
      maybeAutomaticBackup();
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  if (form.id === 'verify-delete-account-form') {
    try {
      const result = await api('/api/auth/account/verify', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      if (result.verified) {
        form.classList.add('hidden');
        $('#delete-account-step-2').classList.remove('hidden');
        toast('Password verified. Confirm the deletion to continue.');
      }
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  if (form.id === 'confirm-delete-account-form') {
    const values = Object.fromEntries(new FormData(form));
    if (values.confirmation !== 'DELETE') return toast('Type DELETE to confirm account deletion.', 'error');
    if (!window.confirm('This permanently deletes your account and ALL related customer and financial records. This cannot be undone.')) return;
    try {
      await api('/api/auth/account/delete', { method: 'POST', body: values });
      await tokenStorage.clear();
      showAuth();
      toast('Your account has been permanently deleted.');
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  if (form.id === 'collection-off-form') {
    try {
      await api(`/api/collections/customers/${form.dataset.customerId}/undo-payment`, { method: 'POST', body: { month: Number(form.dataset.month), year: Number(form.dataset.year) } });
      toast('Paid mark removed. The installment is back to pending.');
      closeModal();
      await Promise.all([loadCollections(), loadDashboard()]);
      if (state.view === 'pending') loadPending();
      maybeAutomaticBackup();
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  if (form.id === 'agent-profile-form') {
    try {
      const result = await api('/api/auth/profile', { method: 'PUT', body: Object.fromEntries(new FormData(form)) });
      state.agent = result.agent;
      state.csrf = result.csrf_token;
      refreshAgentHeader();
      closeModal();
      toast('Profile updated and audit logged.');
      maybeAutomaticBackup();
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  if (form.id === 'restore-form') {
    if (!window.confirm('Restore this backup? Existing financial data remains untouched and duplicate periods are skipped.')) return;
    try {
      const result = await api('/api/backups/restore', { method: 'POST', body: new FormData(form) });
      toast(`Restore finished: ${result.imported_customers} customers and ${result.imported_payments} installments added.`);
      form.reset();
    } catch (error) {
      toast(error.message, 'error');
    }
  }
});

document.addEventListener('click', async event => {
  if (event.target.classList.contains('modal-overlay')) {
    closeModal();
    return;
  }
  if (event.target.id === 'sidebar-overlay') {
    closeSidebar();
    return;
  }
  if ($('#sidebar')?.classList.contains('open') && !event.target.closest('#sidebar') && !event.target.closest('#menu-button')) {
    closeSidebar();
    return;
  }

  if (event.target.closest('.agent-menu')) return openAgentProfile();
  const passwordToggle = event.target.closest('[data-password-toggle]');
  if (passwordToggle) {
    const field = passwordToggle.closest('.password-field');
    const input = field ? field.querySelector('input[name="password"]') : null;
    if (input) {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      passwordToggle.setAttribute('aria-pressed', String(show));
      passwordToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      const eye = passwordToggle.querySelector('.icon-eye');
      const eyeOff = passwordToggle.querySelector('.icon-eye-off');
      if (eye) eye.classList.toggle('hidden', show);
      if (eyeOff) eyeOff.classList.toggle('hidden', !show);
    }
    return;
  }
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.authMode) return showAuth(button.dataset.authMode);
  if (button.dataset.view) return setView(button.dataset.view);
  if (button.dataset.nav) return setView(button.dataset.nav);
  if (button.id === 'menu-button') return toggleSidebar();
  if (button.dataset.closeModal !== undefined) return closeModal();
  if (button.dataset.editAgentProfile !== undefined) return openAgentProfileEdit();
  if (button.dataset.deleteAgentAccount !== undefined) return openDeleteAccountModal();
  if (button.dataset.openCustomer !== undefined) return openCustomerModal();
  if (button.dataset.customerView) return openCustomerProfile(Number(button.dataset.customerView));
  if (button.dataset.customerDelete) {
    const customer = state.customers.find(item => item.id === Number(button.dataset.customerDelete));
    if (customer) openDeleteCustomerModal(customer);
    return;
  }
  if (button.dataset.customerEdit) {
    const customer = state.customers.find(item => item.id === Number(button.dataset.customerEdit));
    if (customer) {
      openCustomerModal(customer);
      $('#customer-form').dataset.customerId = customer.id;
    }
    return;
  }
  if (button.dataset.customerPayment) {
    closeModal();
    return openPaymentModal(Number(button.dataset.customerPayment));
  }
  if (button.dataset.pendingReceipt) return openPendingReceiptModal(Number(button.dataset.pendingReceipt));
  if (button.dataset.collectionOff) return openCollectionOffModal(Number(button.dataset.collectionOff));
  if (button.dataset.page) {
    state.customerPage = Number(button.dataset.page);
    return loadCustomers();
  }
  if (button.id === 'refresh-pending') return loadPending();
  if (button.id === 'refresh-collections') return loadCollections();
  if (button.dataset.reminder) {
    const item = state.pendingCustomers.find(row => row.customer.id === Number(button.dataset.reminder));
    if (!item) return;
    const { month, year } = selectedPendingPeriod();
    const message = `Dear ${item.customer.customer_name}, your remaining RD installment of ${money(item.remaining_amount)} for ${period(month, year)} is pending. Please arrange payment at your convenience.`;
    try {
      await navigator.clipboard.writeText(message);
      toast('Reminder message copied.');
    } catch {
      toast(message);
    }
    return;
  }
  if (button.id === 'generate-report') return loadReport();
  if (button.dataset.export) {
    window.location.assign(`/api/reports/export?${reportQuery(button.dataset.export)}`);
    return;
  }
  if (button.id === 'create-internal-backup') {
    if (!navigator.onLine) return toast('Connect to the internet before creating an internal backup.', 'error');
    try {
      const result = await api('/api/backups/internal/manual', { method: 'POST' });
      toast(result.message);
      await loadBackups();
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  if (button.dataset.restoreInternalBackup) {
    const backup = state.backups.find(item => item.id === Number(button.dataset.restoreInternalBackup));
    if (!backup) return;
    if (!window.confirm(`Restore the backup saved on ${backupDate(backup.created_at)}? This safely adds missing records only; it never overwrites or deletes current financial records.`)) return;
    try {
      const result = await api(`/api/backups/internal/${backup.id}/restore`, { method: 'POST' });
      toast(`Restore finished: ${result.imported_customers} customers and ${result.imported_payments} installments added.`);
      await Promise.all([loadBackups(), loadDashboard(), loadCustomers()]);
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  if (button.dataset.toggleReceipts) {
    const custId = Number(button.dataset.toggleReceipts);
    return openCustomerProfile(custId, !state.profileShowAllReceipts);
  }
  if (button.id === 'logout-button') {
    try {
      const token = await tokenStorage.get();
      await api('/api/auth/logout', { method: 'POST', body: token ? { refresh_token: token } : {} });
    } catch { /* session is cleared on the device regardless */ }
    await tokenStorage.clear();
    showAuth();
  }
});

document.addEventListener('change', event => {
  const checkbox = event.target;
  if (!checkbox.matches('[data-collection-toggle]')) return;
  if (!checkbox.checked) return;
  checkbox.checked = false;
  openCollectionReceiptModal(Number(checkbox.dataset.collectionToggle));
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    handleBackAction();
  }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.agent-menu')) {
    event.preventDefault();
    openAgentProfile();
  }
});

window.handleAndroidBack = function() {
  const handled = handleBackAction();
  if (!handled) {
    if (window.Capacitor?.Plugins?.App) {
      window.Capacitor.Plugins.App.exitApp();
    }
  }
  return handled;
};

window.addEventListener('popstate', () => {
  handleBackAction();
});

if (window.Capacitor?.Plugins?.App) {
  window.Capacitor.Plugins.App.addListener('backButton', () => {
    window.handleAndroidBack();
  });
}

let customerSearchTimer;
$('#customer-search').addEventListener('input', () => {
  clearTimeout(customerSearchTimer);
  customerSearchTimer = setTimeout(() => { state.customerPage = 1; loadCustomers(); }, 250);
});
$('#customer-status').addEventListener('change', () => { state.customerPage = 1; loadCustomers(); });
document.addEventListener('input', event => {
  if (event.target.name === 'start_date' && event.target.closest('#customer-form')) {
    const form = event.target.closest('#customer-form');
    const matInput = form?.querySelector('input[name="maturity_date"]');
    if (matInput && (!matInput.value || matInput.dataset.autoFilled)) {
      const normalized = normalizeDateInput(event.target.value);
      if (normalized && /^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
        const [y, m, d] = normalized.split('-').map(Number);
        matInput.value = `${y + 5}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        matInput.dataset.autoFilled = 'true';
      }
    }
  }
});

let pendingSearchTimer;
$('#pending-search').addEventListener('input', () => {
  clearTimeout(pendingSearchTimer);
  pendingSearchTimer = setTimeout(loadPending, 250);
});
let reportSearchTimer;
$('#report-search')?.addEventListener('input', () => {
  clearTimeout(reportSearchTimer);
  reportSearchTimer = setTimeout(() => {
    renderReportTable($('#report-search')?.value || '');
  }, 150);
});

$('#report-type').addEventListener('change', loadReport);
window.addEventListener('online', async () => {
  setBackupNetworkStatus();
  const result = await maybeAutomaticBackup();
  if (result?.created) {
    toast('Internet connection restored. A new internal backup was saved.');
    if (state.view === 'backups') loadBackups();
  }
});
const overlay = $('#sidebar-overlay');
if (overlay) {
  overlay.addEventListener('click', (e) => { e.preventDefault(); closeSidebar(); });
  overlay.addEventListener('touchstart', (e) => { e.preventDefault(); closeSidebar(); }, { passive: false });
}

function hideLoadingScreen() {
  const screen = $('#loading-screen');
  if (screen && !screen.classList.contains('fade-out')) {
    screen.classList.add('fade-out');
    setTimeout(() => {
      screen.style.display = 'none';
    }, 450);
  }
}

async function checkBackendReadiness(maxRetries = 60, intervalMs = 1500) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch('/api/auth/me', {
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' },
      });
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        if (response.ok) {
          return { ready: true, authenticated: true, agent: data.agent, csrf: data.csrf_token };
        }
        if (response.status === 401) {
          const token = await tokenStorage.get();
          if (token) {
            const restored = await attemptSessionRefresh();
            if (restored) {
              return { ready: true, authenticated: true, agent: state.agent, csrf: state.csrf };
            }
          }
          return { ready: true, authenticated: false };
        }
      }
    } catch {
      // Backend is starting up / connection pending
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return { ready: false, authenticated: false };
}

(async function boot() {
  const result = await checkBackendReadiness();
  if (result.authenticated && result.agent) {
    showApp(result.agent, result.csrf);
  } else {
    showAuth();
  }
  hideLoadingScreen();
})();

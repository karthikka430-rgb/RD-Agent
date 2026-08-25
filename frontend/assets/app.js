/* RD Agent Management System: all financial state stays on the server. */
const state = {
  agent: null,
  csrf: null,
  view: 'dashboard',
  customerPage: 1,
  customers: [],
  collectionRows: [],
  pendingCustomers: [],
  profile: null,
  report: null,
  profileShowAllReceipts: false,
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
function formatTime(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).format(parsed);
}
function formatReceiptDateTime(paymentDate, createdAt) {
  const dateStr = formatCalendarDate(paymentDate);
  const timeStr = formatTime(createdAt);
  if (!timeStr) return dateStr;
  return `${dateStr}, ${timeStr}`;
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

function getTheme() {
  try {
    return localStorage.getItem('rdagent_theme') || 'light';
  } catch {
    return 'light';
  }
}

function setTheme(theme) {
  const activeTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', activeTheme);
  document.body.setAttribute('data-theme', activeTheme);
  try {
    localStorage.setItem('rdagent_theme', activeTheme);
  } catch { /* ignore */ }
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.setAttribute('content', activeTheme === 'dark' ? '#0F172A' : '#05685E');
  }
}

// Initialise theme on script load (light mode is default)
setTheme(getTheme());

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

  let activeBtn = null;
  const potentialBtn = document.activeElement && document.activeElement.tagName === 'BUTTON' ? document.activeElement : null;
  // Do NOT apply loading-state to nav buttons (data-view) — they must remain visibly selected while the destination page loads.
  activeBtn = (potentialBtn && potentialBtn.dataset.view !== undefined) ? null : potentialBtn;
  if (activeBtn) {
    activeBtn.disabled = true;
    activeBtn.classList.add('loading-state');
  }
  document.body.classList.add('is-loading');

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
    document.body.classList.remove('is-loading');
    if (activeBtn) {
      activeBtn.disabled = false;
      activeBtn.classList.remove('loading-state');
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

// Swipe gesture support: Edge swipe (L -> R from screen edge) opens sidebar, R -> L closes sidebar
(function initSidebarSwipeGestures() {
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;

  window.addEventListener('touchstart', (e) => {
    if (window.innerWidth > 880) return;
    if ($('#modal-root')?.innerHTML.trim() !== '') return;
    if (e.touches.length !== 1) return;

    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
  }, { passive: true });

  window.addEventListener('touchend', (e) => {
    if (window.innerWidth > 880) return;
    if ($('#modal-root')?.innerHTML.trim() !== '') return;
    if (e.changedTouches.length !== 1) return;

    const deltaX = e.changedTouches[0].clientX - touchStartX;
    const deltaY = e.changedTouches[0].clientY - touchStartY;
    const elapsed = Date.now() - touchStartTime;

    // Must be predominantly horizontal swipe within a reasonable duration
    if (elapsed > 600) return;
    if (Math.abs(deltaX) < 45 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return;

    const sidebar = $('#sidebar');
    const isOpen = sidebar?.classList.contains('open');

    // ONLY open sidebar if swipe started from the left edge (<= 35px) like native mobile apps
    if (deltaX > 0 && !isOpen && touchStartX <= 35) {
      openSidebar();
    } else if (deltaX < 0 && isOpen) {
      // Swiped Right to Left -> Close Sidebar
      closeSidebar();
    }
  }, { passive: true });
})();
function handleBackAction() {
  // 1. Close any open modal first (stays on same view)
  if ($('#modal-root')?.innerHTML.trim() !== '') {
    closeModal();
    return true;
  }
  // 2. Close sidebar if open (stays on same view)
  const sidebar = $('#sidebar');
  if (sidebar && sidebar.classList.contains('open')) {
    closeSidebar();
    return true;
  }
  // 3. Navigate to dashboard from any other view
  if (state.view && state.view !== 'dashboard') {
    setView('dashboard', false);
    return true;
  }
  // 4. On dashboard, let the app exit (return false = system handles it)
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
  }[view];
  if (info) {
    $('#page-kicker').textContent = info[0];
    $('#page-title').textContent = info[1];
  }
  if (pushHistory && view !== 'dashboard') {
    history.pushState({ view }, '');
  }
  ({ dashboard: loadDashboard, collections: loadCollections, customers: loadCustomers, pending: loadPending, reports: loadReport }[view])?.();
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
    ? `<div class="receipt-list">${receipts.map(receipt => `<div><code>${escapeHtml(receipt.receipt_number)}</code><small>${money(receipt.amount)} · ${formatReceiptDateTime(receipt.payment_date, receipt.created_at)}</small></div>`).join('')}</div>`
    : '<span class="muted">No receipt yet</span>';
}
function renderCollectionsTable(searchTerm = '') {
  const term = (searchTerm || $('#collection-search')?.value || '').trim().toLowerCase();
  const rows = term
    ? state.collectionRows.filter(item => {
        const c = item.customer;
        return (
          String(c.customer_name || '').toLowerCase().includes(term) ||
          String(c.account_number || '').toLowerCase().includes(term) ||
          String(c.phone || '').toLowerCase().includes(term)
        );
      })
    : state.collectionRows;

  $('#collections-table').innerHTML = rows.length
    ? rows.map(item => {
        const customer = item.customer;
        const title = item.is_paid ? 'Installment fully paid and permanently locked' : item.is_partial ? 'Add another amount to complete this installment' : 'Record an amount collected';
        const editCell = item.payment ? `<button class="danger-action" data-collection-off="${customer.id}">OFF</button>` : '<span class="muted">—</span>';
        return `<tr><td><label class="collection-check" title="${title}"><input type="checkbox" data-collection-toggle="${customer.id}" ${item.is_paid ? 'checked disabled' : ''} aria-label="Record collection for ${escapeHtml(customer.customer_name)}" /><span></span></label></td><td><strong>${escapeHtml(customer.customer_name)}</strong><small>${escapeHtml(customer.phone)}</small></td><td>${escapeHtml(customer.account_number)}</td><td>${money(customer.monthly_rd_amount)}</td><td>${statusTag(item.status)}</td><td class="right"><div class="row-actions">${editCell}</div></td></tr>`;
      }).join('')
    : emptyRow(6, term ? 'No customers match your search.' : 'No active RD accounts have a term covering this collection month.');
}

async function loadCollections() {
  try {
    if (!$('#collection-month').value) $('#collection-month').value = currentMonth;
    const { month, year } = selectedCollectionPeriod();
    const result = await api(`/api/collections/?month=${month}&year=${year}`);
    state.collectionRows = result.collections;
    const pendingAmount = result.collections.reduce((sum, item) => sum + Number(item.remaining_amount || 0), 0);
    const metrics = [
      ['Total customers', result.summary.total_customers, 'Active accounts', `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>`, 'green'],
      ['Paid customers', result.summary.paid_customers, 'Installments completed', `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`, 'green'],
      ['Partly paid', result.summary.partial_customers, 'Balance still pending', `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>`, 'blue'],
      ['Pending customers', result.summary.pending_customers, 'No amount collected', `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`, 'orange'],
      ['Total collection amount', money(result.summary.total_collection_amount), 'Amount received so far', `<span style="font-weight:800;font-size:0.95rem;">₹</span>`, 'teal'],
      ['Pending amount', money(pendingAmount), 'Amount yet to be collected', `<span style="font-weight:800;font-size:0.95rem;">₹</span>`, 'red'],
    ];
    $('#collection-metrics').innerHTML = metrics.map(([label, value, note, icon, color]) => `<article class="metric"><div class="metric-header"><span class="metric-icon-badge ${color}">${icon}</span><div class="metric-label">${label}</div></div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></article>`).join('');
    renderCollectionsTable($('#collection-search')?.value || '');
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
      ? result.customers.map(customer => `<tr data-customer-row="${customer.id}">
          <td><strong>${escapeHtml(customer.customer_name)}</strong><small>${escapeHtml(customer.phone)}</small></td>
          <td>${escapeHtml(customer.account_number)}</td>
          <td>${money(customer.monthly_rd_amount)}</td>
          <td class="right"><span class="row-chevron">›</span></td>
        </tr>`).join('')
      : emptyRow(4, 'No customers match this view.');
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
        const phoneEncoded = encodeURIComponent(customer.phone);
        return `<tr>
          <td><strong>${escapeHtml(customer.customer_name)}</strong></td>
          <td>${escapeHtml(customer.account_number)}</td>
          <td>${escapeHtml(customer.phone)}</td>
          <td>
            <div class="pending-contact-btns">
              <a href="tel:${escapeHtml(customer.phone)}" class="pending-icon-btn" aria-label="Call ${escapeHtml(customer.customer_name)}" title="Call customer">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
              </a>
              <button class="pending-icon-btn msg-btn" data-reminder="${customer.id}" aria-label="Copy reminder for ${escapeHtml(customer.customer_name)}" title="Copy reminder message">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              </button>
            </div>
          </td>
        </tr>`;
      }).join('')
      : emptyRow(4, 'All due active customers have fully paid for this month.');
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

function openModal(title, subtitle, body, footer = '', pushHistory = true) {
  const wasOpen = $('#modal-root')?.innerHTML.trim() !== '';
  $('#modal-root').innerHTML = `<div class="modal-overlay" role="dialog" aria-modal="true"><section class="modal"><header class="modal-header"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div><button class="modal-close" data-close-modal aria-label="Close">✕</button></header><div class="modal-body">${body}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}</section></div>`;
  if (pushHistory && !wasOpen) {
    history.pushState({ modal: true }, '');
  }
}
function closeModal() {
  $('#modal-root').innerHTML = '';
  state.profileShowAllReceipts = false;
}
function openAgentProfile() {
  if (!state.agent) return;
  const agent = state.agent;
  const initial = agent.name.slice(0, 2).toUpperCase();
  const memberSince = agent.created_at
    ? new Date(agent.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'Active session';

  const modalContent = `
    <div class="profile-modal-header">
      <div class="profile-modal-topbar">
        <h3 class="profile-modal-title">My profile</h3>
        <button class="profile-settings-btn" type="button" data-open-settings aria-label="Open settings" title="Settings">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
      <div class="profile-hex-avatar">
        <span class="profile-hex-initials">${escapeHtml(initial)}</span>
      </div>
      <h4 class="profile-agent-name">${escapeHtml(agent.name)}</h4>
      <p class="profile-agent-role">RD Agent</p>
    </div>
    <div class="modal-body">
      <div class="profile-detail-list">
        <div class="profile-detail-row">
          <span class="profile-detail-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          </span>
          <div class="profile-detail-info">
            <p class="profile-detail-label">Phone number</p>
            <p class="profile-detail-value">${escapeHtml(agent.phone)}</p>
          </div>
        </div>
        <div class="profile-detail-row">
          <span class="profile-detail-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          </span>
          <div class="profile-detail-info">
            <p class="profile-detail-label">Email address</p>
            <p class="profile-detail-value">${escapeHtml(agent.email || 'Not provided')}</p>
          </div>
        </div>
        <div class="profile-detail-row">
          <span class="profile-detail-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </span>
          <div class="profile-detail-info">
            <p class="profile-detail-label">Account access</p>
            <p class="profile-detail-value">Active session</p>
          </div>
        </div>
        <div class="profile-detail-row">
          <span class="profile-detail-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </span>
          <div class="profile-detail-info">
            <p class="profile-detail-label">Member since</p>
            <p class="profile-detail-value">${escapeHtml(memberSince)}</p>
          </div>
        </div>
      </div>
      <div class="profile-actions">
        <button class="profile-action-btn" type="button" data-edit-agent-profile>Edit profile</button>
        <button class="profile-action-btn danger" type="button" data-delete-agent-account>Delete account</button>
        <button class="profile-signout-row" type="button" id="profile-signout-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          <span>Sign out</span>
        </button>
      </div>
    </div>
  `;

  // Build modal manually without the generic footer
  const wasOpen = $('#modal-root')?.innerHTML.trim() !== '';
  $('#modal-root').innerHTML = `<div class="modal-overlay" role="dialog" aria-modal="true"><section class="modal profile-modal">${modalContent}<button class="modal-close profile-modal-close" data-close-modal aria-label="Close">✕</button></section></div>`;
  if (!wasOpen) history.pushState({ modal: true }, '');

  // Wire up sign-out inside profile
  const signOutBtn = $('#profile-signout-btn');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      try {
        const token = await tokenStorage.get();
        await api('/api/auth/logout', { method: 'POST', body: token ? { refresh_token: token } : {} });
      } catch { /* session cleared regardless */ }
      await tokenStorage.clear();
      closeModal();
      showAuth();
    }, { once: true });
  }
}

function openSettingsModal() {
  const currentTheme = getTheme();
  const bodyHtml = `
    <div class="settings-section">
      <h4 class="settings-section-title">Theme & Appearance</h4>
      <p class="settings-section-desc">Choose your preferred workspace color theme.</p>
      
      <div class="theme-options-grid">
        <label class="theme-option-card ${currentTheme === 'light' ? 'active' : ''}">
          <input type="radio" name="app_theme" value="light" ${currentTheme === 'light' ? 'checked' : ''} />
          <div class="theme-option-icon light-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="3"/><line x1="12" y1="1" x2="12" y2="2"/><line x1="12" y1="8" x2="12" y2="9"/><line x1="4.93" y1="4.93" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.07" y2="19.07"/><line x1="1" y1="12" x2="2" y2="12"/><line x1="22" y1="12" x2="23" y2="12"/><line x1="4.93" y1="19.07" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.07" y2="4.93"/></svg>
          </div>
          <div class="theme-option-info">
            <strong>Light mode</strong>
            <small>Default appearance</small>
          </div>
          <span class="theme-check-badge">✓</span>
        </label>

        <label class="theme-option-card ${currentTheme === 'dark' ? 'active' : ''}">
          <input type="radio" name="app_theme" value="dark" ${currentTheme === 'dark' ? 'checked' : ''} />
          <div class="theme-option-icon dark-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </div>
          <div class="theme-option-info">
            <strong>Dark mode</strong>
            <small>High contrast dark theme</small>
          </div>
          <span class="theme-check-badge">✓</span>
        </label>
      </div>
    </div>

    <div class="settings-section" style="margin-top: 1.25rem;">
      <h4 class="settings-section-title">Account settings</h4>
      <div class="settings-action-rows">
        <button type="button" class="settings-action-row" data-edit-agent-profile>
          <div style="display:flex;align-items:center;gap:0.75rem;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span>Edit profile details</span>
          </div>
          <span>›</span>
        </button>
        <button type="button" class="settings-action-row danger-text" data-delete-agent-account>
          <div style="display:flex;align-items:center;gap:0.75rem;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            <span>Delete account</span>
          </div>
          <span>›</span>
        </button>
      </div>
    </div>
  `;
  openModal('Settings', 'Appearance and workspace options', bodyHtml, '<button class="button primary" type="button" data-close-modal>Done</button>');
}
function openAgentProfileEdit() {
  if (!state.agent) return;
  const agent = state.agent;
  openModal('Edit agent profile', 'Contact changes are retained in the audit log.', `<form id="agent-profile-form"><div class="form-grid"><label class="full">Full name<input name="name" required maxlength="120" value="${escapeHtml(agent.name)}" /></label><label>Phone number<input name="phone" type="tel" inputmode="tel" required maxlength="30" value="${escapeHtml(agent.phone)}" /></label><label>Email <span class="optional-label">(optional)</span><input name="email" type="email" maxlength="255" value="${escapeHtml(agent.email || '')}" placeholder="you@example.com" /></label></div><footer class="modal-footer"><button class="button secondary" type="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Save profile</button></footer></form>`);
}
function customerForm(customer = {}) {
  const value = (name, fallback = '') => escapeHtml(customer[name] ?? fallback);
  const startDateVal = customer.start_date ? formatCalendarDate(customer.start_date) : '';
  const maturityDateVal = customer.maturity_date ? formatCalendarDate(customer.maturity_date) : '';
  return `<form id="customer-form"${customer.id ? ` data-customer-id="${customer.id}"` : ''}><div class="form-grid"><label class="full">Customer name<input name="customer_name" required maxlength="160" placeholder="Enter full name" value="${value('customer_name')}" /></label><label>Account number<input name="account_number" required maxlength="64" placeholder="Enter account number" value="${value('account_number')}" /></label><label>Phone<input name="phone" required maxlength="30" placeholder="Enter phone number" value="${value('phone')}" /></label><label>Monthly RD amount<input name="monthly_rd_amount" type="number" min="0.01" max="9999999999.99" step="0.01" required placeholder="Enter monthly RD amount" value="${value('monthly_rd_amount')}" /></label><label>Status<select name="status"><option value="active" ${customer.status === 'active' || !customer.status ? 'selected' : ''}>Active</option><option value="matured" ${customer.status === 'matured' ? 'selected' : ''}>Matured</option><option value="closed" ${customer.status === 'closed' ? 'selected' : ''}>Closed</option></select></label><label>Start date<input name="start_date" type="text" placeholder="DD/MM/YYYY" required value="${startDateVal}" /></label><label>Maturity date<input name="maturity_date" type="text" placeholder="DD/MM/YYYY" required value="${maturityDateVal}" /></label></div><footer class="modal-footer"><button class="button secondary" type="button" data-close-modal>Cancel</button><button class="button primary" type="submit">${customer.id ? 'Save changes' : 'Create customer'}</button></footer></form>`;
}
function openCustomerModal(customer) {
  openModal(customer ? 'Edit customer' : 'Add customer', customer ? 'Changes are permanently retained in the audit log.' : 'Create a new RD customer account.', customerForm(customer));
}
function openDeleteCustomerModal(customer) {
  openModal('Delete customer', `Account ${customer.account_number} · ${customer.status}. This permanently removes the customer and all their records.`, `<div class="notice-panel"><strong>This action is permanent</strong><p>The customer profile, every payment, every receipt, and all related history will be permanently deleted. This cannot be undone.</p></div><form id="delete-customer-form" data-customer-id="${customer.id}"><label>Type DELETE to confirm deletion<input name="confirmation" required maxlength="20" placeholder="DELETE" autocomplete="off" /></label><footer class="modal-footer"><button class="button secondary" type="button" data-close-modal>Cancel</button><button class="button danger" type="submit">Delete customer permanently</button></footer></form>`);
}
function openDeleteAccountModal() {
  openModal('Delete agent account', 'This permanently removes your account and all your customer and financial records.', `<div class="notice-panel"><strong>Irreversible action</strong><p>Your account, every customer, every collection, every receipt, and audit record will be permanently deleted. This cannot be undone.</p></div><form id="verify-delete-account-form"><label>Enter your password to continue<input name="password" type="password" required maxlength="128" placeholder="Your current password" /></label><footer class="modal-footer"><button class="button secondary" type="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Verify password</button></footer></form><div id="delete-account-step-2" class="hidden"><form id="confirm-delete-account-form"><p class="muted">Type <strong>DELETE</strong> to permanently delete your account.</p><label>Confirmation<input name="confirmation" required maxlength="20" placeholder="DELETE" autocomplete="off" /></label><footer class="modal-footer"><button class="button secondary" type="button" data-close-modal>Cancel</button><button class="button danger" type="submit">Permanently delete my account</button></footer></form></div>`);
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

function renderCustomerProfile(result, showAllReceipts) {
  const customer = result.customer;
  state.profileShowAllReceipts = showAllReceipts;
  const receipts = result.payments.flatMap(p => (p.receipts || []).map(r => ({ ...r, month: p.month, year: p.year })));
  const pendingInfo = calculatePendingMonths(customer, result.payments);

  // Build advance paid section — only show if there is actual advance
  const hasAdvance = Number(pendingInfo.advance) > 0;

  const bodyHtml = `
    <div class="customer-detail-cards">
      <div class="detail-card">
        <div class="detail-card-title">Account information</div>
        <div class="detail-grid-2">
          <div><div class="detail-item-label">Account number</div><div class="detail-item-value">${escapeHtml(customer.account_number)}</div></div>
          <div><div class="detail-item-label">Monthly RD</div><div class="detail-item-value">${money(customer.monthly_rd_amount)} ${statusTag(customer.status)}</div></div>
        </div>
      </div>
      <div class="detail-card">
        <div class="detail-card-title">RD term</div>
        <div class="detail-grid-2">
          <div><div class="detail-item-label">Start date</div><div class="detail-item-value">${formatCalendarDate(customer.start_date)}</div></div>
          <div><div class="detail-item-label">Maturity date</div><div class="detail-item-value">${formatCalendarDate(customer.maturity_date)}</div></div>
        </div>
        <div class="remaining-term-row"><span class="detail-item-label">Remaining term</span><span class="detail-item-value" style="font-size:0.8125rem;">${escapeHtml(remainingDuration(customer.maturity_date))}</span></div>
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
            <div class="detail-item-value ${pendingInfo.count > 0 ? 'text-amber' : 'text-green'}">${pendingInfo.count} month${pendingInfo.count === 1 ? '' : 's'}</div>
          </div>
          <div class="stat-tile">
            <div class="detail-item-label">Outstanding</div>
            <div class="detail-item-value ${Number(pendingInfo.outstanding) > 0 ? 'text-amber' : ''}">${money(pendingInfo.outstanding)}</div>
          </div>
          <div class="stat-tile ${hasAdvance ? 'stat-tile-advance' : ''}">
            <div class="detail-item-label">Advance paid</div>
            <div class="detail-item-value ${hasAdvance ? 'text-green' : ''}">
              ${money(pendingInfo.advance)}
              ${pendingInfo.advanceMonths > 0 ? `<small style="font-size:0.68rem;color:var(--green-text);font-weight:700;">(${pendingInfo.advanceMonths}m ahead)</small>` : ''}
            </div>
          </div>
        </div>
      </div>
      <div class="detail-card">
        <div class="detail-card-title" style="display:flex;justify-content:space-between;align-items:center;">
          <span>${showAllReceipts ? `All receipts (${receipts.length})` : `Recent receipts`}</span>
          ${receipts.length > 3 ? `<button type="button" class="text-button" data-toggle-receipts="${customer.id}">${showAllReceipts ? '← Show recent' : 'View all →'}</button>` : ''}
        </div>
        ${receipts.length
          ? `<div class="receipts-scroll-list">${(showAllReceipts ? receipts : receipts.slice(0, 3)).map(r =>
              `<div class="receipt-item-row"><div><strong>${formatReceiptDateTime(r.payment_date, r.created_at)}</strong><small>${escapeHtml(r.receipt_number)} · ${period(r.month, r.year)}</small></div><strong class="amount-green">${money(r.amount)}</strong></div>`
            ).join('')}</div>`
          : '<div class="muted font-sm">No receipts yet</div>'
        }
      </div>
    </div>
  `;
  openModal(
    customer.customer_name,
    `Account ${customer.account_number} · ${customer.status}`,
    bodyHtml,
    `<button class="button secondary" type="button" data-customer-edit="${customer.id}">Edit customer</button><button class="button primary" type="button" data-customer-payment="${customer.id}">Record collection</button>`,
    !$('#modal-root')?.innerHTML.trim()   // only push history if modal isn't already open
  );
}

async function openCustomerProfile(customerId) {
  try {
    const result = await api(`/api/customers/${customerId}`);
    state.profile = result;
    state.profileShowAllReceipts = false;
    renderCustomerProfile(result, false);
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
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
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
  // Tapping anywhere on a customer row (outside the action buttons) opens the customer detail.
  const customerRow = event.target.closest('[data-customer-row]');
  if (customerRow && !event.target.closest('.row-actions')) {
    return openCustomerProfile(Number(customerRow.dataset.customerRow));
  }

  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.authMode) return showAuth(button.dataset.authMode);
  if (button.id === 'settings-nav-btn' || button.dataset.openSettings !== undefined) { closeSidebar(); return openSettingsModal(); }
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
  if (button.dataset.toggleReceipts) {
    if (state.profile) {
      renderCustomerProfile(state.profile, !state.profileShowAllReceipts);
    }
    return;
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
  if (event.target.name === 'app_theme') {
    setTheme(event.target.value);
    $$('.theme-option-card').forEach(card => {
      const radio = card.querySelector('input[type="radio"]');
      card.classList.toggle('active', radio && radio.checked);
    });
    toast(event.target.value === 'dark' ? 'Dark theme enabled.' : 'Light mode enabled.');
    return;
  }
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

// Android back: handled ONLY via MainActivity.onBackPressed -> window.handleAndroidBack
// Do NOT use Capacitor backButton listener to avoid double-firing
window.handleAndroidBack = function() {
  return handleBackAction();
};

// For browsers (desktop/web): popstate fires when user presses browser back button
window.addEventListener('popstate', () => {
  handleBackAction();
});

let customerSearchTimer;
$('#customer-search').addEventListener('input', () => {
  clearTimeout(customerSearchTimer);
  customerSearchTimer = setTimeout(() => { state.customerPage = 1; loadCustomers(); }, 250);
});

let collectionSearchTimer;
$('#collection-search')?.addEventListener('input', () => {
  clearTimeout(collectionSearchTimer);
  collectionSearchTimer = setTimeout(() => {
    renderCollectionsTable($('#collection-search')?.value || '');
  }, 150);
});
$('#customer-status').addEventListener('change', () => { state.customerPage = 1; loadCustomers(); });
document.addEventListener('input', event => {
  if (event.target.name === 'start_date' && event.target.closest('#customer-form')) {
    const form = event.target.closest('#customer-form');
    const matInput = form?.querySelector('input[name="maturity_date"]');
    if (matInput && (!matInput.value || matInput.dataset.autoFilled)) {
      const val = event.target.value.trim();
      const parts = val.split(/[\/\-\.]/);
      if (parts.length === 3) {
        let d, m, y;
        if (parts[0].length === 4) {
          // YYYY-MM-DD format typed by user → normalise to DD/MM/YYYY
          y = Number(parts[0]);
          m = parts[1].padStart(2, '0');
          d = parts[2].padStart(2, '0');
          // Rewrite the start_date field itself to DD/MM/YYYY
          event.target.value = `${d}/${m}/${y}`;
        } else if (parts[2].length === 4) {
          // DD/MM/YYYY format
          d = parts[0].padStart(2, '0');
          m = parts[1].padStart(2, '0');
          y = Number(parts[2]);
        }
        if (d && m && y && !Number.isNaN(y)) {
          matInput.value = `${d}/${m}/${y + 5}`;
          matInput.dataset.autoFilled = 'true';
        }
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

// The backend may still be waking up after a period of inactivity. The
// loading screen stays visible while the saved session is restored in the
// background using the existing session-refresh mechanism. This wait is
// BOUNDED so the app can never be stuck on the loading screen: once the
// backend responds (or the time runs out) the app always proceeds.
const BOOT_WAIT_LIMIT_MS = 30000;
const BOOT_WAIT_INTERVAL_MS = 1500;

async function restoreSessionWithRetry(limitMs, intervalMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const token = await tokenStorage.get();
    if (!token) return false;
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: token }),
      });
      if (response.ok) {
        const data = await response.json();
        await tokenStorage.set(data.refresh_token);
        state.csrf = data.csrf_token;
        state.agent = data.agent;
        return true;
      }
      if (response.status === 401) {
        // The backend answered and rejected the saved session — stop retrying.
        await tokenStorage.clear();
        return false;
      }
      // 5xx / wake-up page / anything else: the backend is still starting.
    } catch {
      // Network not ready yet — retry after the interval.
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

(async function boot() {
  const hasSavedSession = Boolean(await tokenStorage.get());

  if (!hasSavedSession) {
    // No saved session: the login screen is the destination.
    showAuth();
    hideLoadingScreen();
    return;
  }

  // A saved session exists. Render the frontend right away (it never waits
  // for the backend to draw), then restore the session in the background
  // while the loading screen is visible. As soon as the backend is reachable
  // the app auto-enters the Dashboard; if the bounded wait expires the app
  // simply lands on the login screen. The loading screen is always hidden.
  showAuth();
  const restored = await restoreSessionWithRetry(BOOT_WAIT_LIMIT_MS, BOOT_WAIT_INTERVAL_MS);
  if (restored && state.agent) {
    showApp(state.agent, state.csrf);
  }
  hideLoadingScreen();
})();

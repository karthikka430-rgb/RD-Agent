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
  const parsed = calendarDate(value);
  return parsed ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(parsed) : '-';
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

async function api(url, options = {}) {
  const config = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
  if (options.body && !(options.body instanceof FormData) && typeof options.body !== 'string') {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(options.body);
  }
  if (state.csrf && !['GET', 'HEAD'].includes((config.method || 'GET').toUpperCase())) config.headers['X-CSRF-Token'] = state.csrf;
  const response = await fetch(url, config);
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401) showAuth();
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
function setView(view) {
  state.view = view;
  $$('.view').forEach(element => element.classList.toggle('active', element.id === `view-${view}`));
  $$('.nav-item[data-view]').forEach(element => element.classList.toggle('active', element.dataset.view === view));
  $('#sidebar').classList.remove('open');
  const info = {
    dashboard: ['OVERVIEW', 'Dashboard'],
    collections: ['MONTHLY COLLECTIONS', 'Collection register'],
    customers: ['CUSTOMER RECORDS', 'Customers'],
    pending: ['FOLLOW UP', 'Pending collections'],
    reports: ['ANALYTICS', 'Reports'],
    backups: ['DATA SAFETY', 'Backup & restore'],
  }[view];
  $('#page-kicker').textContent = info[0];
  $('#page-title').textContent = info[1];
  ({ dashboard: loadDashboard, collections: loadCollections, customers: loadCustomers, pending: loadPending, reports: loadReport, backups: loadBackups }[view])();
}

async function loadDashboard() {
  try {
    const result = await api('/api/dashboard/');
    $('#period-label').textContent = `Collection status for ${period(result.period.month, result.period.year)}`;
    const metrics = [
      ['Total customers', result.metrics.total_customers, 'Active accounts due this month', 'C'],
      ['Paid customers', result.metrics.paid_customers, 'Installments completed', 'OK'],
      ['Partly paid', result.metrics.partial_customers, 'Balance still pending', 'P'],
      ['Collected this month', money(result.metrics.collection), period(result.period.month, result.period.year), 'Rs'],
      ['Pending collections', result.metrics.pending_count, 'Follow-up required', 'D'],
    ];
    $('#metric-grid').innerHTML = metrics.map(([label, value, note, icon]) => `<article class="metric"><span class="metric-icon">${icon}</span><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></article>`).join('');
    $('#recent-table').innerHTML = result.recent_transactions.length
      ? result.recent_transactions.map(item => `<tr><td><strong>${escapeHtml(item.customer_name)}</strong><small>${escapeHtml(item.account_number)}</small></td><td>${period(item.month, item.year)}</td><td><code>${escapeHtml(item.receipt_number)}</code><small>${formatCalendarDate(item.payment_date)}</small></td><td><strong>${money(item.amount)}</strong></td><td>${statusTag(item.status || (item.is_void ? 'Voided' : 'Recorded'))}</td></tr>`).join('')
      : emptyRow(5, 'No payments have been recorded yet.');
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
    $('#collection-heading').textContent = `Collection cycle · ${period(month, year)}`;
    const metrics = [
      ['Total customers', result.summary.total_customers, 'Active accounts due this month', 'C'],
      ['Paid customers', result.summary.paid_customers, 'Installments completed', 'OK'],
      ['Partly paid', result.summary.partial_customers, 'Balance still pending', 'P'],
      ['Pending customers', result.summary.pending_customers, 'No amount collected', 'D'],
      ['Total collection amount', money(result.summary.total_collection_amount), 'Amount received so far', 'Rs'],
    ];
    $('#collection-metrics').innerHTML = metrics.map(([label, value, note, icon]) => `<article class="metric"><span class="metric-icon">${icon}</span><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></article>`).join('');
    $('#collections-table').innerHTML = result.collections.length
      ? result.collections.map(item => {
        const customer = item.customer;
        const title = item.is_paid ? 'Installment fully paid and permanently locked' : item.is_partial ? 'Add another amount to complete this installment' : 'Record an amount collected';
        return `<tr><td><label class="collection-check" title="${title}"><input type="checkbox" data-collection-toggle="${customer.id}" ${item.is_paid ? 'checked disabled' : ''} aria-label="Record collection for ${escapeHtml(customer.customer_name)}" /><span></span></label></td><td><strong>${escapeHtml(customer.customer_name)}</strong></td><td>${escapeHtml(customer.account_number)}</td><td>${escapeHtml(customer.phone)}</td><td>${money(customer.monthly_rd_amount)}</td><td class="balance-cell"><strong>${money(item.paid_amount)}</strong><small>Remaining ${money(item.remaining_amount)} of ${money(customer.monthly_rd_amount)}</small></td><td>${receiptMarkup(item.receipts)}</td><td>${statusTag(item.status)}</td></tr>`;
      }).join('')
      : emptyRow(8, 'No active RD accounts have a term covering this collection month.');
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
      ? result.customers.map(customer => `<tr><td><strong>${escapeHtml(customer.customer_name)}</strong><small>${escapeHtml(customer.phone)}</small></td><td>${escapeHtml(customer.account_number)}</td><td>${money(customer.monthly_rd_amount)}</td><td>${formatCalendarDate(customer.start_date)} - ${formatCalendarDate(customer.maturity_date)}<small>${escapeHtml(remainingDuration(customer.maturity_date))}</small></td><td>${statusTag(customer.status)}</td><td class="right"><div class="row-actions"><button data-customer-view="${customer.id}">View</button>${customer.status !== 'archived' ? `<button data-customer-edit="${customer.id}">Edit</button>` : ''}</div></td></tr>`).join('')
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
async function loadReport() {
  try {
    if (!$('#report-month').value) $('#report-month').value = currentMonth;
    const result = await api(`/api/reports/?${reportQuery()}`);
    state.report = result;
    $('#report-period-field').classList.toggle('hidden', $('#report-type').value === 'customers');
    $('#report-summary').innerHTML = Object.entries(result.summary).map(([key, value]) => `<span>${escapeHtml(key.replaceAll('_', ' '))}: <strong>${key.includes('collection') || key.includes('collected') ? money(value) : escapeHtml(value)}</strong></span>`).join('');
    $('#report-table').innerHTML = `<thead><tr>${result.columns.map(column => `<th>${escapeHtml(column.replaceAll('_', ' '))}</th>`).join('')}</tr></thead><tbody>${result.rows.length ? result.rows.map(row => `<tr>${result.columns.map(column => `<td>${escapeHtml(row[column] ?? '')}</td>`).join('')}</tr>`).join('') : emptyRow(result.columns.length, 'There are no records for this report.')}</tbody>`;
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openModal(title, subtitle, body, footer = '') {
  $('#modal-root').innerHTML = `<div class="modal-overlay" role="dialog" aria-modal="true"><section class="modal"><header class="modal-header"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div><button class="modal-close" data-close-modal aria-label="Close">x</button></header><div class="modal-body">${body}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}</section></div>`;
}
function closeModal() {
  $('#modal-root').innerHTML = '';
}
function openAgentProfile() {
  if (!state.agent) return;
  const agent = state.agent;
  openModal('Agent profile', 'Your signed-in RD collection account.', `<div class="agent-profile-card"><div class="profile-avatar">${escapeHtml(agent.name.slice(0, 1).toUpperCase())}</div><div><h4>${escapeHtml(agent.name)}</h4><p>RD Agent</p></div></div><div class="profile-summary agent-profile-details"><div>Phone number<strong>${escapeHtml(agent.phone)}</strong></div><div>Email address<strong>${escapeHtml(agent.email || 'Not provided')}</strong></div><div>Account access<strong>Active session</strong></div></div>`, '<button class="button secondary" type="button" data-edit-agent-profile>Edit profile</button><button class="button primary" type="button" data-close-modal>Close</button>');
}
function openAgentProfileEdit() {
  if (!state.agent) return;
  const agent = state.agent;
  openModal('Edit agent profile', 'Contact changes are retained in the audit log.', `<form id="agent-profile-form"><div class="form-grid"><label class="full">Full name<input name="name" required maxlength="120" value="${escapeHtml(agent.name)}" /></label><label>Phone number<input name="phone" type="tel" inputmode="tel" required maxlength="30" value="${escapeHtml(agent.phone)}" /></label><label>Email <span class="optional-label">(optional)</span><input name="email" type="email" maxlength="255" value="${escapeHtml(agent.email || '')}" placeholder="you@example.com" /></label></div><footer class="modal-footer"><button class="button secondary" type="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Save profile</button></footer></form>`);
}
function customerForm(customer = {}) {
  const value = (name, fallback = '') => escapeHtml(customer[name] ?? fallback);
  return `<form id="customer-form"><div class="form-grid"><label class="full">Customer name<input name="customer_name" required maxlength="160" value="${value('customer_name')}" /></label><label>Account number<input name="account_number" required maxlength="64" value="${value('account_number')}" /></label><label>Phone<input name="phone" required maxlength="30" value="${value('phone')}" /></label><label>Monthly RD amount<input name="monthly_rd_amount" type="number" min="0.01" max="9999999999.99" step="0.01" required value="${value('monthly_rd_amount')}" /></label><label>Status<select name="status"><option value="active" ${customer.status === 'active' || !customer.status ? 'selected' : ''}>Active</option><option value="matured" ${customer.status === 'matured' ? 'selected' : ''}>Matured</option><option value="closed" ${customer.status === 'closed' ? 'selected' : ''}>Closed</option></select></label><label>Start date<input name="start_date" type="date" required value="${value('start_date')}" /></label><label>Maturity date<input name="maturity_date" type="date" required value="${value('maturity_date')}" /></label></div><footer class="modal-footer"><button class="button secondary" type="button" data-close-modal>Cancel</button><button class="button primary" type="submit">${customer.id ? 'Save changes' : 'Create customer'}</button></footer></form>`;
}
function openCustomerModal(customer) {
  openModal(customer ? 'Edit customer' : 'Add customer', customer ? 'Changes are permanently retained in the audit log.' : 'Create a new RD customer account.', customerForm(customer));
}

function receiptForm(customer, summary, month, year) {
  const remaining = summary?.remaining_amount ?? customer.monthly_rd_amount;
  const paid = summary?.paid_amount ?? '0.00';
  return `<form id="receipt-form" data-customer-id="${customer.id}" data-remaining="${escapeHtml(remaining)}"><div class="profile-summary receipt-summary"><div>Monthly RD<strong>${money(customer.monthly_rd_amount)}</strong></div><div>Collected so far<strong>${money(paid)}</strong></div><div>Amount remaining<strong>${money(remaining)}</strong></div></div><div class="form-grid"><label>Installment month<input name="period" type="month" required value="${year}-${String(month).padStart(2, '0')}" /></label><label>Amount received<input name="amount" type="number" min="0.01" max="${escapeHtml(remaining)}" step="0.01" required value="${escapeHtml(remaining)}" /></label><label class="full">Collection date<input name="payment_date" type="date" max="${todayIso}" required value="${todayIso}" /></label></div><p class="muted">A receipt is created for this amount. Recorded receipts cannot be changed or removed.</p><footer class="modal-footer"><button class="button secondary" type="button" data-close-modal>Cancel</button><button class="button primary" type="submit">Record amount and generate receipt</button></footer></form>`;
}
function openReceiptModal(customer, summary, periodInfo) {
  const { month, year } = periodInfo;
  openModal(`Record collection · ${customer.customer_name}`, `Account ${customer.account_number}. Enter the cash amount received for ${period(month, year)}.`, receiptForm(customer, summary, month, year));
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
async function openCustomerProfile(customerId) {
  try {
    const result = await api(`/api/customers/${customerId}`);
    const customer = result.customer;
    state.profile = result;
    const rows = result.payments.length
      ? result.payments.map(payment => `<tr><td>${period(payment.month, payment.year)}</td><td>${money(customer.monthly_rd_amount)}</td><td><strong>${money(payment.paid_amount)}</strong><small>Remaining ${money(payment.remaining_amount)}</small></td><td>${receiptMarkup(payment.receipts || [])}</td><td>${statusTag(payment.is_void ? 'Voided' : payment.status)}</td></tr>`).join('')
      : emptyRow(5, 'No payments recorded.');
    openModal(customer.customer_name, `Account ${customer.account_number} · ${customer.status}`, `<div class="profile-summary"><div>Monthly RD<strong>${money(customer.monthly_rd_amount)}</strong></div><div>Start date<strong>${formatCalendarDate(customer.start_date)}</strong></div><div>Maturity date<strong>${formatCalendarDate(customer.maturity_date)}</strong></div></div><div class="panel-header"><div><h3>Payment history</h3><p>Each receipt and balance is retained permanently.</p></div><button class="button primary" data-customer-payment="${customer.id}">Record payment</button></div><div class="table-wrap"><table><thead><tr><th>Period</th><th>Monthly RD</th><th>Paid / remaining</th><th>Receipt history</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div><div class="panel-header"><div><h3>Change history</h3><p>Auditable customer, installment, and receipt events</p></div></div><div id="audit-content" class="muted">Loading audit history...</div>`);
    const audit = await api(`/api/customers/${customerId}/audit`);
    const auditNode = $('#audit-content');
    if (auditNode) auditNode.innerHTML = audit.audit_logs.length ? `<ul class="audit-list">${audit.audit_logs.map(log => `<li><strong>${escapeHtml(log.action)}</strong> · ${escapeHtml(log.entity_type)} <small>${new Date(log.timestamp).toLocaleString('en-IN')}</small></li>`).join('')}</ul>` : 'No audit entries yet.';
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function submitCustomer(form) {
  const customerId = form.dataset.customerId;
  try {
    await api(customerId ? `/api/customers/${customerId}` : '/api/customers/', { method: customerId ? 'PUT' : 'POST', body: Object.fromEntries(new FormData(form)) });
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
      showApp(result.agent, result.csrf_token);
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  if (form.id === 'customer-form') return submitCustomer(form);
  if (form.id === 'receipt-form') return submitReceipt(form);
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
  if (event.target.closest('.agent-menu')) return openAgentProfile();
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.authMode) return showAuth(button.dataset.authMode);
  if (button.dataset.view) return setView(button.dataset.view);
  if (button.dataset.nav) return setView(button.dataset.nav);
  if (button.id === 'menu-button') return $('#sidebar').classList.toggle('open');
  if (button.dataset.closeModal !== undefined) return closeModal();
  if (button.dataset.editAgentProfile !== undefined) return openAgentProfileEdit();
  if (button.dataset.openCustomer !== undefined) return openCustomerModal();
  if (button.dataset.customerView) return openCustomerProfile(Number(button.dataset.customerView));
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
  if (button.id === 'logout-button') {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      showAuth();
    }
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
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.agent-menu')) {
    event.preventDefault();
    openAgentProfile();
  }
});
let customerSearchTimer;
$('#customer-search').addEventListener('input', () => {
  clearTimeout(customerSearchTimer);
  customerSearchTimer = setTimeout(() => { state.customerPage = 1; loadCustomers(); }, 250);
});
$('#customer-status').addEventListener('change', () => { state.customerPage = 1; loadCustomers(); });
let pendingSearchTimer;
$('#pending-search').addEventListener('input', () => {
  clearTimeout(pendingSearchTimer);
  pendingSearchTimer = setTimeout(loadPending, 250);
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
window.addEventListener('offline', setBackupNetworkStatus);

(async function boot() {
  try {
    const result = await api('/api/auth/me');
    showApp(result.agent, result.csrf_token);
  } catch {
    showAuth();
  }
})();

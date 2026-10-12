/**
 * EasyLearn AI — Frontend Application Logic (v2.0 Production)
 * Connects with FastAPI backend, JWT multi-tenant isolation, hybrid RAG, and Metriqual telemetry.
 */

const API_BASE = (
    window.location.protocol === 'file:' || 
    window.location.origin === 'null' || 
    window.location.port === '3000' || 
    window.location.port === '5500'
) ? 'http://127.0.0.1:8080' : window.location.origin;

// State management - Session-scoped so opening the site defaults to the login page
let currentUser = null;
let authToken = sessionStorage.getItem('easylearn_jwt_token') || null;
// Clean up any legacy persistent localStorage token and local tasks cache
try { 
    localStorage.removeItem('easylearn_jwt_token'); 
    localStorage.removeItem('easylearn_local_tasks'); 
} catch (e) {}
let currentSearchMode = 'hybrid';
let activeChatDocFilter = null;
let activeRoadmap = null;
let telemetryInterval = null;

// Telemetry Drawer Toggle
function toggleTelemetryDrawer() {
    const drawer = document.getElementById('telemetry-drawer');
    if (drawer) {
        drawer.style.display = (drawer.style.display === 'none' || !drawer.style.display) ? 'flex' : 'none';
    }
}

// Terminal Log Helper
function logActivity(msg, type = 'info') {
    const term = document.getElementById('terminal-body');
    const now = new Date().toTimeString().split(' ')[0];
    if (term) {
        const item = document.createElement('div');
        item.className = `log-item ${type}`;
        item.innerHTML = `<span class="log-time">[${now}]</span> ${escapeHtml(msg)}`;
        term.prepend(item);
    }

    // Also update dashboard preview
    const dashTel = document.getElementById('dash-recent-telemetry');
    if (dashTel) {
        const row = document.createElement('div');
        row.className = 'dash-telemetry-item';
        row.innerHTML = `<span><code style="color:var(--accent-cyan)">[${now}]</code> ${escapeHtml(msg)}</span>`;
        if (dashTel.querySelector('.empty-state-box')) {
            dashTel.innerHTML = '';
        }
        dashTel.prepend(row);
        while (dashTel.children.length > 5) {
            dashTel.removeChild(dashTel.lastChild);
        }
    }
}

function clearTerminalLogs() {
    const term = document.getElementById('terminal-body');
    if (term) term.innerHTML = '';
    const dashTel = document.getElementById('dash-recent-telemetry');
    if (dashTel) dashTel.innerHTML = '<div class="empty-state-box">Logs cleared.</div>';
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── TOAST NOTIFICATION ───
function showToast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-msg">${escapeHtml(message)}</span>`;
    toast.style.cssText = `
        display:flex;align-items:center;gap:10px;padding:12px 18px;
        background:${type==='success'?'#0f3a2a':type==='error'?'#3a0f0f':type==='warning'?'#3a2e0f':'#0f1f3a'};
        border:1px solid ${type==='success'?'#22c55e':type==='error'?'#ef4444':type==='warning'?'#f59e0b':'#3b82f6'};
        color:#fff;border-radius:10px;font-size:14px;font-weight:500;
        box-shadow:0 4px 24px rgba(0,0,0,0.4);margin-bottom:8px;
        animation:slideInRight 0.3s ease;max-width:360px;word-break:break-word;
        opacity:1;transition:opacity 0.4s ease;
    `;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 400);
    }, duration);
}

// State management for admin & activity
let adminUsersCache = [];
let adminActivityCache = [];

function isAdminUser() {
    return currentUser && (currentUser.role === 'admin' || (currentUser.email && currentUser.email.toLowerCase() === 'uthejsaithandlam@gmail.com'));
}

// ─── AUTHENTICATION HELPERS ───
async function apiFetch(endpoint, options = {}) {
    const headers = options.headers || {};
    if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }
    if (!(options.body instanceof FormData) && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
    if (res.status === 401) {
        logActivity('Authentication token expired or invalid. Please sign in.', 'error');
        handleLogout();
        return res;
    }
    return res;
}

async function initAuth() {
    if (authToken) {
        try {
            const res = await apiFetch('/api/auth/me');
            if (res.ok) {
                const data = await res.json();
                currentUser = data.user;
                hideAuthPage();
                switchTab('dashboard');  // ← Activate dashboard view on token restore
                updateUserUI();
                logActivity(`Authenticated via JWT as ${currentUser.username} (${isAdminUser() ? '👑 Superadmin' : '👤 Member'})`, 'success');
                refreshAllViews();
                return;
            }
        } catch (e) {
            console.error('Auth verification failed', e);
        }
    }
    // No valid token: display dedicated login page
    showAuthPage();
}

function clearAuthInputs() {
    const uLogin = document.getElementById('auth-input-login-ident');
    const pLogin = document.getElementById('auth-input-login-pwd');
    const uReg = document.getElementById('auth-input-reg-user');
    const emReg = document.getElementById('auth-input-reg-email');
    const pReg = document.getElementById('auth-input-reg-pwd');
    if (uLogin) uLogin.value = '';
    if (pLogin) pLogin.value = '';
    if (uReg) uReg.value = '';
    if (emReg) emReg.value = '';
    if (pReg) pReg.value = '';
}

function showAuthPage() {
    const authPage = document.getElementById('view-auth-page');
    const appRoot = document.getElementById('app-root');
    if (authPage) {
        authPage.classList.remove('hidden');
        authPage.style.removeProperty('display');
        authPage.style.setProperty('display', 'flex', 'important');
    }
    if (appRoot) {
        appRoot.classList.add('hidden');
        appRoot.style.removeProperty('display');
        appRoot.style.setProperty('display', 'none', 'important');
    }
    clearAuthInputs();
    setTimeout(clearAuthInputs, 120);
}

function hideAuthPage() {
    const authPage = document.getElementById('view-auth-page');
    const appRoot = document.getElementById('app-root');
    if (authPage) {
        authPage.classList.add('hidden');
        authPage.style.removeProperty('display');
        authPage.style.setProperty('display', 'none', 'important');
    }
    if (appRoot) {
        appRoot.classList.remove('hidden');
        appRoot.style.removeProperty('display');
        appRoot.style.setProperty('display', 'flex', 'important');
    }
    toggleMobileSidebar(false);
}

function switchAuthPageTab(tab) {
    const isLogin = tab === 'login';
    document.getElementById('auth-page-tab-login')?.classList.toggle('active', isLogin);
    document.getElementById('auth-page-tab-register')?.classList.toggle('active', !isLogin);
    const formLogin = document.getElementById('auth-page-form-login');
    const formReg = document.getElementById('auth-page-form-register');
    if (formLogin) formLogin.style.display = isLogin ? 'block' : 'none';
    if (formReg) formReg.style.display = isLogin ? 'none' : 'block';
    hideAuthAlert();
    clearAuthInputs();
}

function showAuthAlert(msg, type = 'error') {
    const alertEl = document.getElementById('auth-page-alert');
    if (alertEl) {
        alertEl.className = `auth-alert ${type}`;
        alertEl.textContent = msg;
        alertEl.style.display = 'block';
    }
}

function hideAuthAlert() {
    const alertEl = document.getElementById('auth-page-alert');
    if (alertEl) alertEl.style.display = 'none';
}

function togglePwdVisibility(inputId) {
    const el = document.getElementById(inputId);
    if (el) {
        el.type = el.type === 'password' ? 'text' : 'password';
    }
}

function quickFillCredentials(ident, pwd) {
    switchAuthPageTab('login');
    const uInput = document.getElementById('auth-input-login-ident');
    const pInput = document.getElementById('auth-input-login-pwd');
    if (uInput) uInput.value = ident;
    if (pInput) pInput.value = pwd;
    showAuthAlert(`Filled credentials for ${ident}. Click 'Sign In' to login.`, 'success');
}

async function handlePageLogin(e) {
    e.preventDefault();
    hideAuthAlert();
    const ident = document.getElementById('auth-input-login-ident').value.trim();
    const pwd = document.getElementById('auth-input-login-pwd').value.trim();
    const submitBtn = document.getElementById('btn-auth-login-submit');

    if (!ident || !pwd) {
        showAuthAlert('Please enter both username/email and password.');
        return;
    }

    try {
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<span>Signing in...</span>';
        }
        const res = await fetch(`${API_BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: ident, password: pwd })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            let msg = 'Login failed';
            if (data && data.detail) {
                if (typeof data.detail === 'string') msg = data.detail;
                else if (Array.isArray(data.detail)) msg = data.detail.map(d => d.msg || JSON.stringify(d)).join('; ');
                else msg = JSON.stringify(data.detail);
            }
            throw new Error(msg);
        }

        authToken = data.token;
        currentUser = data.user;
        sessionStorage.setItem('easylearn_jwt_token', authToken);
        try { localStorage.removeItem('easylearn_jwt_token'); } catch (e) {}

        showToast(`✅ Welcome back, ${currentUser.username}!`, 'success', 3500);
        hideAuthPage();
        switchTab('dashboard');  // ← Navigate to dashboard after login
        updateUserUI();
        logActivity(`Welcome back, ${currentUser.username}! Session active.`, 'success');
        refreshAllViews();
    } catch (err) {
        showAuthAlert(err.message, 'error');
        showToast(`Login failed: ${err.message}`, 'error', 4500);
        logActivity(`Login failed for ${ident}: ${err.message}`, 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span class="btn-text">Sign In</span>';
        }
    }
}

async function handlePageRegister(e) {
    e.preventDefault();
    hideAuthAlert();
    const u = document.getElementById('auth-input-reg-user').value.trim();
    const em = document.getElementById('auth-input-reg-email').value.trim();
    const pwd = document.getElementById('auth-input-reg-pwd').value.trim();
    const submitBtn = document.getElementById('btn-auth-reg-submit');

    if (!u || !em || !pwd) {
        showAuthAlert('Please fill in all registration fields.');
        return;
    }

    try {
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<span>Creating account...</span>';
        }
        const res = await fetch(`${API_BASE}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, email: em, password: pwd })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            let msg = 'Registration failed';
            if (data && data.detail) {
                if (typeof data.detail === 'string') msg = data.detail;
                else if (Array.isArray(data.detail)) msg = data.detail.map(d => d.msg || JSON.stringify(d)).join('; ');
                else msg = JSON.stringify(data.detail);
            }
            throw new Error(msg);
        }

        // Switch to the Sign In tab so user can decide when to sign in
        switchAuthPageTab('login');

        // Pre-fill the login identifier with the newly created account username
        const loginIdentInput = document.getElementById('auth-input-login-ident');
        const loginPwdInput = document.getElementById('auth-input-login-pwd');
        if (loginIdentInput) loginIdentInput.value = u;
        if (loginPwdInput) {
            loginPwdInput.value = '';
            setTimeout(() => loginPwdInput.focus(), 150);
        }

        // Show prominent confirmation banner and toast
        showAuthAlert(`🎉 Account created successfully for "${u}"! Please enter your password and click Sign In when you're ready.`, 'success');
        showToast(`🎉 Account created successfully! Please enter your password and sign in.`, 'success', 5000);
        logActivity(`Account created for ${u}. Ready for sign in.`, 'info');
    } catch (err) {
        showAuthAlert(err.message, 'error');
        showToast(`Registration failed: ${err.message}`, 'error', 4500);
        logActivity(`Registration failed: ${err.message}`, 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span class="btn-text">Create Account</span>';
        }
    }
}

function handleLogout() {
    try {
        sessionStorage.removeItem('easylearn_jwt_token');
        localStorage.removeItem('easylearn_jwt_token');
    } catch (e) {}
    authToken = null;
    currentUser = null;
    logActivity('Signed out of session.', 'info');
    showAuthPage();
    const adminNav = document.getElementById('nav-group-admin');
    if (adminNav) adminNav.style.display = 'none';
}

async function handleGuestLogin() {
    try {
        const res = await fetch(`${API_BASE}/api/auth/guest`, { method: 'POST' });
        const data = await res.json();
        authToken = data.token;
        currentUser = data.user;
        sessionStorage.setItem('easylearn_jwt_token', authToken);
        try { localStorage.removeItem('easylearn_jwt_token'); } catch (e) {}
        showToast(`Welcome to your Guest Workspace!`, 'info', 3000);
        hideAuthPage();
        switchTab('dashboard');  // ← Navigate to dashboard after guest login
        closeAuthModal();
        updateUserUI();
        logActivity(`Created isolated guest workspace: ${currentUser.username}`, 'success');
        refreshAllViews();
    } catch (e) {
        logActivity('Failed to create guest session', 'error');
    }
}

async function handleLogin(e) {
    return handlePageLogin(e);
}

async function handleRegister(e) {
    return handlePageRegister(e);
}

function updateUserUI() {
    if (!currentUser) return;
    const nameEl = document.getElementById('sidebar-user-name');
    const roleEl = document.getElementById('sidebar-user-role');
    const avatarEl = document.getElementById('sidebar-user-avatar');
    const greetingEl = document.getElementById('topbar-greeting');
    const adminNav = document.getElementById('nav-group-admin');

    const admin = isAdminUser();

    if (nameEl) nameEl.textContent = currentUser.username;
    if (roleEl) {
        if (admin) {
            roleEl.innerHTML = '<span style="color:#fbbf24;font-weight:700;">👑 Superadmin</span>';
        } else if (currentUser.is_guest) {
            roleEl.textContent = '● Guest Workspace';
        } else {
            roleEl.innerHTML = '<span style="color:var(--accent-cyan);font-weight:600;">👤 Verified User</span>';
        }
    }
    if (avatarEl) {
        avatarEl.textContent = admin ? '👑' : (currentUser.username ? currentUser.username.charAt(0).toUpperCase() : '👤');
        if (admin) {
            avatarEl.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
            avatarEl.style.color = '#000';
        } else {
            avatarEl.style.background = 'linear-gradient(135deg, var(--accent-cyan), var(--accent-blue))';
            avatarEl.style.color = '#070a12';
        }
    }
    if (greetingEl) {
        greetingEl.textContent = admin 
            ? `Administrator Portal — ${currentUser.username}` 
            : `Welcome back, ${currentUser.username}`;
    }

    if (adminNav) {
        adminNav.style.display = 'block';
        const adminNavTitle = document.getElementById('nav-group-admin-title');
        const adminNavBadge = document.getElementById('snav-admin-badge');
        const adminNavIcon = document.getElementById('nav-group-admin-icon');
        if (adminNavTitle) adminNavTitle.textContent = admin ? 'ADMINISTRATION' : 'USER ACTIVITY';
        if (adminNavBadge) adminNavBadge.textContent = admin ? 'Admin' : 'Activity';
        if (adminNavIcon) adminNavIcon.textContent = admin ? '👑' : '📜';
    }
}

function openAuthModal() {
    showAuthPage();
}
function closeAuthModal() {
    if (currentUser) hideAuthPage();
}
function switchAuthTab(tab) {
    switchAuthPageTab(tab);
}

// ─── MOBILE SIDEBAR DRAWER ───
function toggleMobileSidebar(force) {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (!sidebar) return;
    const isCurrentlyOpen = sidebar.classList.contains('mobile-open');
    const nextState = typeof force === 'boolean' ? force : !isCurrentlyOpen;
    sidebar.classList.toggle('mobile-open', nextState);
    if (overlay) overlay.style.display = nextState ? 'block' : 'none';
}

// ─── RESIZABLE & ADJUSTABLE SIDEBAR ENGINE ───
function initSidebarResizer() {
    const sidebar = document.getElementById('sidebar');
    const resizer = document.getElementById('sidebar-resizer');
    const collapseBtn = document.getElementById('btn-sidebar-collapse');
    if (!sidebar || !resizer) return;

    // Restore saved width and collapsed preference
    const savedWidth = localStorage.getItem('easylearn_sidebar_width');
    const isCollapsed = localStorage.getItem('easylearn_sidebar_collapsed') === 'true';

    if (isCollapsed) {
        sidebar.classList.add('collapsed');
        if (collapseBtn) {
            collapseBtn.textContent = '▶';
            collapseBtn.title = 'Expand Sidebar';
        }
    } else if (savedWidth) {
        const w = parseInt(savedWidth, 10);
        if (w >= 170 && w <= 480) {
            sidebar.style.width = `${w}px`;
            document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
        }
    }

    let isDragging = false;

    function startDrag(e) {
        if (sidebar.classList.contains('collapsed')) return;
        isDragging = true;
        sidebar.classList.add('resizing');
        resizer.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const moveHandler = (moveEvent) => {
            if (!isDragging) return;
            const clientX = moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX;
            const maxWidth = Math.min(500, Math.floor(window.innerWidth * 0.55));
            const newWidth = Math.max(170, Math.min(clientX, maxWidth));

            sidebar.style.width = `${newWidth}px`;
            document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
        };

        const stopDrag = () => {
            if (!isDragging) return;
            isDragging = false;
            sidebar.classList.remove('resizing');
            resizer.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';

            const finalWidth = parseInt(sidebar.style.width, 10) || 240;
            localStorage.setItem('easylearn_sidebar_width', finalWidth);

            window.removeEventListener('mousemove', moveHandler);
            window.removeEventListener('mouseup', stopDrag);
            window.removeEventListener('touchmove', moveHandler);
            window.removeEventListener('touchend', stopDrag);
        };

        window.addEventListener('mousemove', moveHandler);
        window.addEventListener('mouseup', stopDrag);
        window.addEventListener('touchmove', moveHandler, { passive: true });
        window.addEventListener('touchend', stopDrag);
    }

    resizer.addEventListener('mousedown', startDrag);
    resizer.addEventListener('touchstart', startDrag, { passive: true });

    // Double-click to reset or toggle width
    resizer.addEventListener('dblclick', () => {
        if (sidebar.classList.contains('collapsed')) {
            toggleSidebarCollapse();
        } else {
            const currentW = parseInt(sidebar.style.width, 10);
            const defaultW = 240;
            const targetW = (currentW === defaultW) ? 320 : defaultW;
            sidebar.style.width = `${targetW}px`;
            document.documentElement.style.setProperty('--sidebar-width', `${targetW}px`);
            localStorage.setItem('easylearn_sidebar_width', targetW);
            showToast(`Sidebar adjusted to ${targetW}px`, 'info');
        }
    });
}

function toggleSidebarCollapse() {
    const sidebar = document.getElementById('sidebar');
    const collapseBtn = document.getElementById('btn-sidebar-collapse');
    if (!sidebar) return;

    const willCollapse = !sidebar.classList.contains('collapsed');
    sidebar.classList.toggle('collapsed', willCollapse);
    localStorage.setItem('easylearn_sidebar_collapsed', willCollapse ? 'true' : 'false');

    if (collapseBtn) {
        collapseBtn.textContent = willCollapse ? '▶' : '◀';
        collapseBtn.title = willCollapse ? 'Expand Sidebar' : 'Collapse Sidebar';
    }

    if (!willCollapse) {
        const savedWidth = localStorage.getItem('easylearn_sidebar_width') || '240';
        sidebar.style.width = `${savedWidth}px`;
        document.documentElement.style.setProperty('--sidebar-width', `${savedWidth}px`);
    }
}

// ─── TAB NAVIGATION ───
function switchTab(tabId) {
    toggleMobileSidebar(false);
    const tabs = ['dashboard', 'knowledge', 'chat', 'search', 'roadmap', 'planner', 'monitoring', 'admin'];
    tabs.forEach(t => {
        const sec = document.getElementById(`view-${t}`);
        const nav = document.getElementById(`snav-${t}`);
        if (sec) sec.style.display = (t === tabId) ? 'block' : 'none';
        if (nav) nav.classList.toggle('active', t === tabId);
    });

    if (tabId === 'dashboard') loadKnowledgeBase();
    if (tabId === 'knowledge') loadKnowledgeBase();
    if (tabId === 'chat') refreshChatDocs();
    if (tabId === 'planner') loadPlannerTasks();
    if (tabId === 'monitoring') {
        loadTelemetry();
        if (telemetryInterval) clearInterval(telemetryInterval);
        telemetryInterval = setInterval(loadTelemetry, 15000);
    } else {
        if (telemetryInterval) {
            clearInterval(telemetryInterval);
            telemetryInterval = null;
        }
    }
    if (tabId === 'admin') loadAdminData();
}

// ─── ADMIN AUDIT & ACTIVITY DATA ───
async function loadAdminData() {
    if (!currentUser) return;
    try {
        const [statsRes, usersRes, actRes] = await Promise.all([
            apiFetch('/api/admin/stats'),
            apiFetch('/api/admin/users'),
            apiFetch('/api/admin/activity')
        ]);

        if (statsRes.ok) {
            const stats = await statsRes.json();
            const elTotalUsers = document.getElementById('admin-stat-total-users');
            const elTotalLogins = document.getElementById('admin-stat-total-logins');
            const elActiveUsers = document.getElementById('admin-stat-active-users');
            if (elTotalUsers) elTotalUsers.textContent = stats.total_users || 0;
            if (elTotalLogins) elTotalLogins.textContent = stats.successful_logins || 0;
            if (elActiveUsers) elActiveUsers.textContent = stats.unique_active_users || 0;
        }

        if (usersRes.ok) {
            adminUsersCache = await usersRes.json();
            const badge = document.getElementById('admin-users-badge');
            if (badge) badge.textContent = adminUsersCache.length;
            renderAdminUsersTable(adminUsersCache);
        }

        if (actRes.ok) {
            adminActivityCache = await actRes.json();
            const badge = document.getElementById('admin-activity-badge');
            if (badge) badge.textContent = adminActivityCache.length;
            renderAdminActivityTable(adminActivityCache);
        }
    } catch (e) {
        console.error('Failed to load admin data', e);
        logActivity('Failed to fetch admin audit data', 'error');
    }
}

function renderAdminUsersTable(users) {
    const tbody = document.getElementById('admin-users-table-body');
    if (!tbody) return;
    if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-tertiary);">No registered accounts found.</td></tr>';
        return;
    }

    tbody.innerHTML = users.map(u => {
        const isAdmin = u.role === 'admin' || (u.email && u.email.toLowerCase() === 'uthejsaithandlam@gmail.com');
        const avatarInitial = isAdmin ? '👑' : (u.username ? u.username.charAt(0).toUpperCase() : '?');
        return `
            <tr>
                <td>
                    <div class="user-row-meta">
                        <div class="table-user-avatar ${isAdmin ? 'admin' : ''}">${avatarInitial}</div>
                        <div>
                            <div class="table-user-name">${escapeHtml(u.username)}</div>
                            <div style="font-size:10px;color:var(--text-tertiary);font-family:var(--font-mono);">${escapeHtml(u.id)}</div>
                        </div>
                    </div>
                </td>
                <td><code style="color:var(--text-primary);font-size:11px;">${escapeHtml(u.email)}</code></td>
                <td>
                    <span class="badge-role ${isAdmin ? 'admin' : 'user'}">
                        ${isAdmin ? '👑 ADMIN' : '👤 USER'}
                    </span>
                </td>
                <td>
                    <span style="font-size:11px;color:${u.is_guest ? 'var(--text-tertiary)' : 'var(--accent-emerald)'}">
                        ${u.is_guest ? 'Guest Session' : '● Verified Member'}
                    </span>
                </td>
                <td><span style="font-size:11px;color:var(--text-secondary);">${escapeHtml(u.created_at)}</span></td>
                <td><span style="font-size:11px;color:${u.last_login !== 'Never' ? 'var(--accent-cyan)' : 'var(--text-tertiary)'};font-family:var(--font-mono);">${escapeHtml(u.last_login)}</span></td>
                <td><strong style="font-family:var(--font-mono);">${u.login_count}</strong></td>
                <td><span class="snav-badge">${u.doc_count} files</span></td>
            </tr>
        `;
    }).join('');
}

function filterAdminUsers() {
    const q = (document.getElementById('admin-user-search')?.value || '').toLowerCase().trim();
    const info = document.getElementById('admin-user-filter-info');
    if (!q) {
        if (info) info.textContent = `Showing all ${adminUsersCache.length} registered accounts`;
        renderAdminUsersTable(adminUsersCache);
        return;
    }
    const filtered = adminUsersCache.filter(u => 
        (u.username && u.username.toLowerCase().includes(q)) ||
        (u.email && u.email.toLowerCase().includes(q)) ||
        (u.role && u.role.toLowerCase().includes(q)) ||
        (u.id && u.id.toLowerCase().includes(q))
    );
    if (info) info.textContent = `Found ${filtered.length} of ${adminUsersCache.length} accounts matching "${q}"`;
    renderAdminUsersTable(filtered);
}

function renderAdminActivityTable(activities) {
    const tbody = document.getElementById('admin-activity-table-body');
    if (!tbody) return;
    if (!activities || activities.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-tertiary);">No login activity recorded yet.</td></tr>';
        return;
    }

    tbody.innerHTML = activities.map(a => {
        const isSuccess = a.status === 'success';
        const isAdmin = a.role === 'admin' || (a.email && a.email.toLowerCase() === 'uthejsaithandlam@gmail.com');
        return `
            <tr>
                <td><code style="color:var(--accent-cyan);font-size:11px;">${escapeHtml(a.created_at)}</code></td>
                <td><strong>${escapeHtml(a.username || 'Anonymous')}</strong></td>
                <td><span style="font-size:11px;color:var(--text-secondary);">${escapeHtml(a.email || 'N/A')}</span></td>
                <td>
                    <span class="badge-role ${isAdmin ? 'admin' : 'user'}">
                        ${isAdmin ? '👑 ADMIN' : '👤 USER'}
                    </span>
                </td>
                <td><code style="font-size:10px;background:rgba(255,255,255,0.06);padding:2px 6px;border-radius:4px;">${escapeHtml(a.auth_method || 'jwt_bearer')}</code></td>
                <td>
                    <span class="badge-audit-status ${isSuccess ? 'success' : 'failed'}">
                        ● ${isSuccess ? 'SUCCESS' : 'FAILED'}
                    </span>
                </td>
                <td><code style="font-size:11px;color:var(--text-tertiary);">${escapeHtml(a.ip_address || '127.0.0.1')}</code></td>
                <td><span style="font-size:10px;color:var(--text-tertiary);max-width:200px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(a.user_agent)}">${escapeHtml(a.user_agent || 'Browser')}</span></td>
            </tr>
        `;
    }).join('');
}

function filterAdminActivity() {
    const filter = document.getElementById('admin-activity-filter')?.value || 'all';
    if (filter === 'all') {
        renderAdminActivityTable(adminActivityCache);
    } else {
        const filtered = adminActivityCache.filter(a => a.status === filter);
        renderAdminActivityTable(filtered);
    }
}

async function loadAdminActivity() {
    if (!isAdminUser()) return;
    try {
        const res = await apiFetch('/api/admin/activity');
        if (res.ok) {
            adminActivityCache = await res.json();
            const badge = document.getElementById('admin-activity-badge');
            if (badge) badge.textContent = adminActivityCache.length;
            filterAdminActivity();
        }
    } catch (e) {
        console.error(e);
    }
}

function switchAdminTab(tab) {
    const isUsers = tab === 'users';
    document.getElementById('admin-tab-btn-users')?.classList.toggle('active', isUsers);
    document.getElementById('admin-tab-btn-activity')?.classList.toggle('active', !isUsers);
    const panelUsers = document.getElementById('admin-panel-users');
    const panelAct = document.getElementById('admin-panel-activity');
    if (panelUsers) panelUsers.style.display = isUsers ? 'block' : 'none';
    if (panelAct) panelAct.style.display = isUsers ? 'none' : 'block';
    if (!isUsers) loadAdminActivity();
}

function refreshAllViews() {
    loadKnowledgeBase();
    loadPlannerTasks();
    loadTelemetry();
    if (isAdminUser()) loadAdminData();
}


// ─── KNOWLEDGE BASE INGESTION (Fillo Style) ───
async function loadKnowledgeBase() {
    try {
        const res = await apiFetch('/api/documents');
        if (!res.ok) return;
        const data = await res.json();
        
        const count = data.total_documents || 0;
        const chunks = data.total_chunks || 0;

        // Sidebar stats
        const sfDocs = document.getElementById('sf-docs');
        const sfChunks = document.getElementById('sf-chunks');
        const snavDocCount = document.getElementById('snav-doc-count');
        if (sfDocs) sfDocs.textContent = count;
        if (sfChunks) sfChunks.textContent = chunks;
        if (snavDocCount) snavDocCount.textContent = count;

        // Dashboard KPI & folders
        const dashKpiDocs = document.getElementById('dash-kpi-docs');
        const dashKpiChunks = document.getElementById('dash-kpi-chunks');
        const dashFolderDocs = document.getElementById('dash-folder-docs');
        if (dashKpiDocs) dashKpiDocs.textContent = count;
        if (dashKpiChunks) dashKpiChunks.textContent = chunks;
        if (dashFolderDocs) dashFolderDocs.textContent = `${count} files · ${chunks} chunks`;

        // Render Recent Docs on Dashboard
        const dashRecent = document.getElementById('dash-recent-docs');
        if (dashRecent) {
            if (count === 0) {
                dashRecent.innerHTML = '<div class="empty-state-box">No documents in this workspace yet. Upload a PDF above!</div>';
            } else {
                dashRecent.innerHTML = (data.documents || []).slice(0, 4).map(d => {
                    const ext = d.doc_name.split('.').pop().toLowerCase();
                    const sizeKb = Math.round((d.file_size || 0) / 1024);
                    return `
                        <div class="dash-file-item">
                            <div style="display:flex;align-items:center;gap:8px;">
                                <span class="doc-icon-badge ${ext === 'pdf' ? 'pdf' : 'doc'}">${ext}</span>
                                <strong>${escapeHtml(d.doc_name)}</strong>
                            </div>
                            <div style="display:flex;align-items:center;gap:12px;">
                                <span style="color:var(--text-tertiary);">${sizeKb} KB · ${d.chunk_count} chunks</span>
                                <button class="btn btn-danger btn-sm" onclick="deleteDocument('${d.doc_id}', '${escapeHtml(d.doc_name)}')">✕</button>
                            </div>
                        </div>
                    `;
                }).join('');
            }
        }

        // Render Knowledge Base Table
        const listEl = document.getElementById('kb-docs-list');
        if (listEl) {
            if (count === 0) {
                listEl.innerHTML = '<div class="docs-empty">No documents uploaded yet. Drop a PDF or document above!</div>';
            } else {
                listEl.innerHTML = data.documents.map(d => {
                    const ext = d.doc_name.split('.').pop().toLowerCase();
                    const badgeClass = ext === 'pdf' ? 'pdf' : (ext.includes('doc') ? 'doc' : 'txt');
                    const sizeKb = Math.round((d.file_size || 0) / 1024);
                    return `
                        <div class="docs-table-row">
                            <div class="doc-name-cell">
                                <span class="doc-icon-badge ${badgeClass}">${ext}</span>
                                <span>${escapeHtml(d.doc_name)}</span>
                            </div>
                            <div>${sizeKb > 0 ? sizeKb + ' KB' : 'Standard'}</div>
                            <div><span class="mini-stat-val" style="display:inline;">${d.chunk_count}</span> chunks</div>
                            <div><span class="badge-status indexed">● ${d.status || 'Indexed'}</span></div>
                            <div>
                                <button class="btn btn-danger btn-sm" onclick="deleteDocument('${d.doc_id}', '${escapeHtml(d.doc_name)}')">Delete</button>
                            </div>
                        </div>
                    `;
                }).join('');
            }
        }

    } catch (e) {
        console.error('Failed to load knowledge base', e);
    }
}

async function uploadDashboardFile(e) {
    const input = e.target;
    if (!input.files || input.files.length === 0) return;
    await processFileUpload(input.files[0]);
    input.value = '';
}

async function uploadDocument() {
    const input = document.getElementById('kb-file-input');
    if (!input.files || input.files.length === 0) return;
    await processFileUpload(input.files[0]);
    input.value = '';
}

async function processFileUpload(file) {
    if (file.size > 15 * 1024 * 1024) {
        alert('File size exceeds the 15MB limit.');
        return;
    }

    logActivity(`Uploading & chunking "${file.name}" (${(file.size/1024).toFixed(1)} KB)...`, 'info');

    const reader = new FileReader();
    reader.onload = async function(e) {
        const base64Data = e.target.result.split(',')[1];
        try {
            const res = await apiFetch('/api/upload-document', {
                method: 'POST',
                body: JSON.stringify({
                    filename: file.name,
                    base64: base64Data
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Upload failed');

            logActivity(`✅ Indexed "${file.name}": generated ${data.chunks_indexed} structure-aware chunks.`, 'success');
            loadKnowledgeBase();
            refreshChatDocs();
        } catch (err) {
            logActivity(`Upload failed: ${err.message}`, 'error');
            alert(`Upload error: ${err.message}`);
        }
    };
    reader.readAsDataURL(file);
}

async function deleteDocument(docId, docName) {
    if (!confirm(`Delete "${docName}" from your knowledge base?`)) return;
    try {
        const res = await apiFetch(`/api/documents/${docId}`, { method: 'DELETE' });
        if (res.ok) {
            logActivity(`Deleted document: ${docName}`, 'info');
            loadKnowledgeBase();
            refreshChatDocs();
        }
    } catch (e) {
        logActivity(`Failed to delete document: ${e.message}`, 'error');
    }
}

// ─── RAG CHAT (RTA-CERT Style) ───
async function refreshChatDocs() {
    try {
        const res = await apiFetch('/api/documents');
        if (!res.ok) return;
        const data = await res.json();
        const list = document.getElementById('chat-doc-selector-list');
        const count = document.getElementById('chat-doc-count');
        if (!list) return;

        count.textContent = `${data.total_documents || 0} Files`;
        list.innerHTML = `
            <div class="rta-doc-item ${!activeChatDocFilter ? 'active' : ''}" onclick="selectChatDocFilter(null, this)">
                <span>📚 All Knowledge (${data.total_chunks || 0} chunks)</span>
            </div>
        ` + (data.documents || []).map(d => `
            <div class="rta-doc-item ${activeChatDocFilter === d.doc_name ? 'active' : ''}" onclick="selectChatDocFilter('${escapeHtml(d.doc_name)}', this)">
                <span>📄 ${escapeHtml(d.doc_name)}</span>
            </div>
        `).join('');
    } catch (e) {
        console.error(e);
    }
}

function selectChatDocFilter(docName, el) {
    activeChatDocFilter = docName;
    document.querySelectorAll('.rta-doc-item').forEach(i => i.classList.remove('active'));
    if (el) el.classList.add('active');
    document.getElementById('active-chat-doc-title').textContent = docName ? `Document: ${docName}` : 'All Knowledge Documents';
    logActivity(`Chat filter focused on: ${docName || 'All Documents'}`, 'info');
}

function clearChatMessages() {
    const area = document.getElementById('chat-messages');
    if (area) {
        area.innerHTML = `
            <div class="rta-msg ai">
                <div class="rta-msg-avatar">🤖</div>
                <div class="rta-msg-body">
                    <div class="rta-msg-content">Chat cleared. Ready for your next learning question!</div>
                </div>
            </div>
        `;
    }
}

async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (!msg) return;

    input.value = '';
    const chatArea = document.getElementById('chat-messages');

    // User Message
    const userDiv = document.createElement('div');
    userDiv.className = 'rta-msg user';
    userDiv.innerHTML = `
        <div class="rta-msg-avatar">👤</div>
        <div class="rta-msg-body">
            <div class="rta-msg-content">${escapeHtml(msg)}</div>
        </div>
    `;
    chatArea.appendChild(userDiv);

    // AI Thinking Message
    const aiDiv = document.createElement('div');
    aiDiv.className = 'rta-msg ai';
    aiDiv.innerHTML = `
        <div class="rta-msg-avatar">🤖</div>
        <div class="rta-msg-body">
            <div class="rta-msg-content" style="color:var(--text-secondary);">Thinking & retrieving passages...</div>
        </div>
    `;
    chatArea.appendChild(aiDiv);
    chatArea.scrollTop = chatArea.scrollHeight;

    const startT = performance.now();
    try {
        const res = await apiFetch('/api/rag/chat', {
            method: 'POST',
            body: JSON.stringify({
                message: msg,
                doc_filter: activeChatDocFilter
            })
        });
        const data = await res.json();
        const duration = Math.round(performance.now() - startT);

        let rawContent = data.message || 'No response returned.';
        
        let formatted = escapeHtml(rawContent);
        if (data.citations && data.citations.length > 0) {
            data.citations.forEach((c, idx) => {
                const pat = new RegExp(`\\[${c.doc_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},?\\s*Page\\s*${c.page_num}\\]`, 'gi');
                formatted = formatted.replace(pat, `<a class="citation-badge" onclick="inspectCitation(${idx})">📖 ${escapeHtml(c.doc_name)} (p.${c.page_num})</a>`);
            });
            window._lastCitations = data.citations;
        }

        aiDiv.querySelector('.rta-msg-content').innerHTML = formatted;
        logActivity(`AI responded in ${duration}ms (retrieval: ${data.retrieval_time_ms}ms) via ${data.provider}`, 'success');

    } catch (e) {
        aiDiv.querySelector('.rta-msg-content').innerHTML = `❌ Error communicating with AI: ${escapeHtml(e.message)}`;
        logActivity(`Chat error: ${e.message}`, 'error');
    } finally {
        chatArea.scrollTop = chatArea.scrollHeight;
    }
}

function inspectCitation(idx) {
    if (!window._lastCitations || !window._lastCitations[idx]) return;
    const c = window._lastCitations[idx];
    document.getElementById('citation-modal-title').textContent = `📖 Citation: ${c.doc_name} (Page ${c.page_num})`;
    document.getElementById('citation-modal-meta').textContent = `Chunk: ${c.chunk_id} · Similarity Score: ${c.similarity || c.final_score}`;
    document.getElementById('citation-modal-text').textContent = c.snippet || 'No preview text available.';
    document.getElementById('citation-modal').style.display = 'flex';
}

function closeCitationModal() {
    document.getElementById('citation-modal').style.display = 'none';
}

// ─── SEMANTIC RETRIEVAL INSPECTOR ───
function setSearchMode(mode, el) {
    currentSearchMode = mode;
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
}

async function performSemanticSearch() {
    const input = document.getElementById('search-query-input');
    const query = input.value.trim();
    if (!query) return;

    const topK = parseInt(document.getElementById('search-topk').value) || 5;
    const container = document.getElementById('search-results-container');
    container.innerHTML = '<div class="docs-empty">Searching vector embedding space...</div>';

    try {
        const res = await apiFetch('/api/rag/search', {
            method: 'POST',
            body: JSON.stringify({
                query: query,
                mode: currentSearchMode,
                top_k: topK
            })
        });
        const data = await res.json();
        
        if (!data.results || data.results.length === 0) {
            container.innerHTML = '<div class="docs-empty">No matching chunks found above threshold (0.08).</div>';
            return;
        }

        container.innerHTML = data.results.map((r, idx) => `
            <div class="search-chunk-card">
                <div class="chunk-top-bar">
                    <div class="chunk-meta-tags">
                        <span class="chunk-meta-tag">#${idx + 1}</span>
                        <span class="chunk-meta-tag">📄 ${escapeHtml(r.chunk.doc_name)}</span>
                        <span class="chunk-meta-tag">Page ${r.chunk.page_num}</span>
                        <span class="chunk-meta-tag">${r.chunk.chunk_id}</span>
                    </div>
                    <span class="chunk-score-pill">Score: ${r.final_score} (Sim: ${r.similarity_score} / KW: ${r.keyword_score})</span>
                </div>
                <div class="chunk-matching-text">${escapeHtml(r.chunk.content)}</div>
            </div>
        `).join('');

        logActivity(`Semantic search returned ${data.results.length} chunks for "${query}"`, 'info');
    } catch (e) {
        container.innerHTML = `<div class="docs-empty" style="color:var(--accent-red)">Search failed: ${e.message}</div>`;
    }
}

// ─── AI ROADMAP GENERATOR ───
async function handleCreateGoal(e) {
    e.preventDefault();
    const topic = document.getElementById('goal-query').value.trim();
    const depth = document.getElementById('goal-level').value;
    const hours = parseFloat(document.getElementById('goal-hours').value) || 2.0;
    const deadline = document.getElementById('goal-deadline').value;

    logActivity(`Generating structured roadmap for "${topic}" (${depth})...`, 'info');

    try {
        const res = await apiFetch('/api/generate-plan', {
            method: 'POST',
            body: JSON.stringify({
                topic: topic,
                depth: depth,
                daily_hours: hours,
                deadline: deadline
            })
        });
        const data = await res.json();
        renderRoadmap(data.roadmap, data.modules);
        logActivity(`AI Roadmap generated for "${topic}" with ${data.modules ? data.modules.length : 0} study modules!`, 'success');
    } catch (err) {
        logActivity(`Roadmap generation error: ${err.message}`, 'error');
    }
}

function renderRoadmap(roadmap, modules) {
    if (!roadmap) return;
    document.getElementById('active-roadmap-title-badge').textContent = roadmap.name.toUpperCase();
    const container = document.getElementById('tree-container');
    container.innerHTML = (roadmap.children || []).map(child => `
        <div class="tree-node">
            <div class="tree-node-title">
                <span>🌿 ${escapeHtml(child.name)}</span>
                <span style="color:var(--accent-cyan);font-size:11px;">~${child.estimated_hours || 2}h</span>
            </div>
            <div class="tree-node-desc">${escapeHtml(child.description)}</div>
        </div>
    `).join('');
}

// ─── DAILY STUDY PLANNER & TIMETABLE CHART ENGINE (SCREENSHOT-MATCHED) ───
let plannerTasksCache = [];
let focusActiveTaskId = null;
let focusActiveTaskTitle = "NO ACTIVE TASK";
let focusTimerSeconds = 0;
let focusTimerRunning = false;
let focusTimerInterval = null;

// Format HH:MM 24h into "8:00 AM"
function formatAmPm(timeStr) {
    if (!timeStr) return "--:--";
    const parts = timeStr.split(':');
    let h = parseInt(parts[0], 10);
    const m = parts[1] || "00";
    if (isNaN(h)) return timeStr;
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${ampm}`;
}

// Generate the 24 hour rows (00:00 to 23:00)
function initTimelineRows() {
    const container = document.getElementById('timeline-hour-rows');
    if (!container || container.children.length >= 24) return;

    let html = '';
    for (let h = 0; h < 24; h++) {
        const hh = String(h).padStart(2, '0') + ':00';
        html += `
            <div class="hour-row" data-hour="${h}">
                <div class="hour-label">${hh}</div>
                <div class="hour-slot"></div>
            </div>
        `;
    }
    container.innerHTML = html;
}

async function loadPlannerTasks() {
    try {
        const dateEl = document.getElementById('current-planner-date');
        if (dateEl) {
            const now = new Date();
            const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
            dateEl.textContent = dateStr;
        }

        initTimelineRows();

        const res = await apiFetch('/api/planner/tasks');
        if (res.ok) {
            plannerTasksCache = await res.json();
        } else {
            plannerTasksCache = [];
        }
    } catch (e) {
        console.warn('Failed to load planner tasks', e);
        plannerTasksCache = [];
    }

    renderTimelineBlocks();
}

function renderTimelineBlocks() {
    const overlay = document.getElementById('timeline-blocks-overlay');
    if (!overlay) return;

    if (!plannerTasksCache || plannerTasksCache.length === 0) {
        overlay.innerHTML = '';
        return;
    }

    let minTop = 1440;

    overlay.innerHTML = plannerTasksCache.map(task => {
        const [sh, sm] = (task.start_time || "08:00").split(':').map(Number);
        const [eh, em] = (task.end_time || "09:00").split(':').map(Number);

        const startMin = (isNaN(sh) ? 8 : sh) * 60 + (isNaN(sm) ? 0 : sm);
        const endMin = (isNaN(eh) ? 9 : eh) * 60 + (isNaN(em) ? 0 : em);
        const durationMin = Math.max(25, endMin - startMin);

        // 1 minute = 1 pixel
        const topPx = startMin;
        const heightPx = Math.max(38, durationMin);

        if (topPx < minTop) minTop = topPx;

        const isFocused = task.id === focusActiveTaskId;
        const isDone = Boolean(task.completed);
        const timeRangeLabel = `${formatAmPm(task.start_time)} - ${formatAmPm(task.end_time)}`;

        return `
            <div class="timeline-task-block ${isFocused ? 'is-active-focus' : ''} ${isDone ? 'is-completed' : ''}" 
                 style="top: ${topPx}px; height: ${heightPx}px;"
                 onclick="selectFocusTask('${task.id}')"
                 title="${escapeHtml(task.title)} (${timeRangeLabel})">
                <div class="block-title">${escapeHtml(task.title)}</div>
                <div class="block-time-range">${timeRangeLabel}</div>
            </div>
        `;
    }).join('');

    // Smoothly scroll to the earliest block so user sees their schedule immediately
    const viewport = document.getElementById('timeline-viewport');
    if (viewport && minTop < 1440) {
        const targetScroll = Math.max(0, minTop - 60);
        viewport.scrollTo({ top: targetScroll, behavior: 'smooth' });
    }
}

function selectFocusTask(taskId) {
    const task = plannerTasksCache.find(t => t.id === taskId);
    if (!task) return;

    focusActiveTaskId = task.id;
    focusActiveTaskTitle = task.title;

    const labelEl = document.getElementById('focus-active-task-name');
    if (labelEl) {
        labelEl.textContent = task.title;
        labelEl.title = task.title;
    }

    renderTimelineBlocks();
    showToast(`Active task: "${task.title}"`, 'info');
}

// ─── FOCUS TIMER ENGINE ───
function updateFocusClockDisplay() {
    const clockEl = document.getElementById('focus-clock-display');
    if (!clockEl) return;
    const hrs = Math.floor(focusTimerSeconds / 3600);
    const mins = Math.floor((focusTimerSeconds % 3600) / 60);
    const secs = focusTimerSeconds % 60;
    clockEl.textContent = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function handleFocusPlay() {
    const btn = document.getElementById('btn-focus-play');
    if (focusTimerRunning) {
        // Pause timer
        clearInterval(focusTimerInterval);
        focusTimerRunning = false;
        if (btn) btn.textContent = 'Play';
        logActivity(`Focus timer paused at ${document.getElementById('focus-clock-display')?.textContent || ''}`, 'info');
    } else {
        // Start/resume timer
        focusTimerRunning = true;
        if (btn) btn.textContent = 'Pause';
        focusTimerInterval = setInterval(() => {
            focusTimerSeconds++;
            updateFocusClockDisplay();
        }, 1000);
        logActivity(`Focus timer started for task: ${focusActiveTaskTitle}`, 'info');
    }
}

async function handleFocusComplete() {
    const elapsedMinutes = Math.max(1, Math.round(focusTimerSeconds / 60));
    const finishedTaskTitle = focusActiveTaskTitle;

    // Stop timer & reset clock
    clearInterval(focusTimerInterval);
    focusTimerRunning = false;
    focusTimerSeconds = 0;
    updateFocusClockDisplay();

    const playBtn = document.getElementById('btn-focus-play');
    if (playBtn) playBtn.textContent = 'Play';

    // Mark current active task as complete if selected
    if (focusActiveTaskId) {
        try {
            await apiFetch(`/api/planner/tasks/${focusActiveTaskId}/toggle`, { method: 'PUT' });
            const task = plannerTasksCache.find(t => t.id === focusActiveTaskId);
            if (task) task.completed = 1;
            renderTimelineBlocks();
        } catch (e) {
            console.error('Failed to toggle task completion', e);
        }
    }

    showToast(`🎉 Focus session completed! (${elapsedMinutes}m logged)`, 'success');
    logActivity(`Focus session completed: "${finishedTaskTitle}" (${elapsedMinutes}m logged).`, 'success');
}

// ─── ADD BLOCK FORM ───
async function handlePlannerAddBlock(e) {
    e.preventDefault();
    const nameInput = document.getElementById('add-block-name');
    const catInput = document.getElementById('add-block-category');
    const startInput = document.getElementById('add-block-start');
    const endInput = document.getElementById('add-block-end');

    const title = nameInput ? nameInput.value.trim() : '';
    const category = catInput ? catInput.value : 'Learning';
    const start_time = startInput ? startInput.value : '08:00';
    const end_time = endInput ? endInput.value : '09:00';

    if (!title || !start_time || !end_time) {
        showToast('Please enter block name and time slot.', 'error');
        return;
    }

    try {
        const res = await apiFetch('/api/planner/tasks', {
            method: 'POST',
            body: JSON.stringify({
                title,
                category,
                start_time,
                end_time,
                color: 'cyan'
            })
        });

        if (res.ok) {
            const data = await res.json();
            if (nameInput) nameInput.value = '';
            await loadPlannerTasks();
            if (data.id) selectFocusTask(data.id);
            showToast(`Added block: "${title}"`, 'success');
            logActivity(`Added timetable block: ${title} (${start_time} - ${end_time})`, 'info');
        } else {
            showToast('Failed to add study block.', 'error');
        }
    } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
    }
}

// ─── ACTIONS: AUTO SCHEDULE & CLEAR ALL ───
async function handleAutoSchedule() {
    try {
        const res = await apiFetch('/api/planner/tasks/auto-schedule', { method: 'POST' });
        if (res.ok) {
            await loadPlannerTasks();
            if (plannerTasksCache.length > 0) {
                selectFocusTask(plannerTasksCache[0].id);
            }
            showToast('⚡ Auto-scheduled 5 curriculum study sessions!', 'success');
            logActivity('Auto-scheduled daily timetable blocks matching curriculum modules.', 'success');
        } else {
            showToast('Failed to auto-schedule sessions.', 'error');
        }
    } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
    }
}

async function handleClearAllTasks() {
    if (!confirm('Are you sure you want to clear all blocks from your timeline?')) {
        return;
    }

    try {
        const res = await apiFetch('/api/planner/tasks/clear', { method: 'DELETE' });
        if (res.ok) {
            plannerTasksCache = [];
            focusActiveTaskId = null;
            focusActiveTaskTitle = "NO ACTIVE TASK";
            const labelEl = document.getElementById('focus-active-task-name');
            if (labelEl) labelEl.textContent = 'NO ACTIVE TASK';

            renderTimelineBlocks();
            showToast('All timetable blocks cleared.', 'info');
            logActivity('Cleared all timetable study blocks.', 'info');
        } else {
            showToast('Failed to clear blocks.', 'error');
        }
    } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
    }
}


// ─── METRIQUAL OBSERVABILITY (Image 4 Style) ───
async function loadTelemetry() {
    try {
        const [statsRes, logsRes] = await Promise.all([
            apiFetch('/api/telemetry/stats'),
            apiFetch('/api/telemetry/logs')
        ]);

        if (statsRes.ok) {
            const stats = await statsRes.json();
            
            // Dashboard KPI latency
            const dashLatency = document.getElementById('dash-kpi-latency');
            if (dashLatency) dashLatency.textContent = `${stats.avg_latency_ms} ms`;

            // Full monitoring tab
            const kpiTotal = document.getElementById('kpi-total-reqs');
            const kpiCost = document.getElementById('kpi-cost');
            const kpiLat = document.getElementById('kpi-latency');
            const kpiErr = document.getElementById('kpi-error-rate');
            if (kpiTotal) kpiTotal.textContent = stats.total_requests;
            if (kpiCost) kpiCost.textContent = `$${stats.total_cost_usd.toFixed(4)}`;
            if (kpiLat) kpiLat.textContent = `${stats.avg_latency_ms} ms`;
            if (kpiErr) kpiErr.textContent = `${stats.error_rate_pct}%`;

            const gemini = stats.provider_breakdown?.gemini || 0;
            const groq = stats.provider_breakdown?.groq || 0;
            const local = stats.provider_breakdown?.local || 0;
            const total = Math.max(gemini + groq + local, 1);

            const statGeminiCount = document.getElementById('stat-gemini-count');
            const statGeminiBar = document.getElementById('stat-gemini-bar');
            const statGroqCount = document.getElementById('stat-groq-count');
            const statGroqBar = document.getElementById('stat-groq-bar');
            const statLocalCount = document.getElementById('stat-local-count');
            const statLocalBar = document.getElementById('stat-local-bar');

            if (statGeminiCount) statGeminiCount.textContent = `${gemini} calls`;
            if (statGeminiBar) statGeminiBar.style.width = `${(gemini/total)*100}%`;
            if (statGroqCount) statGroqCount.textContent = `${groq} calls`;
            if (statGroqBar) statGroqBar.style.width = `${(groq/total)*100}%`;
            if (statLocalCount) statLocalCount.textContent = `${local} calls`;
            if (statLocalBar) statLocalBar.style.width = `${(local/total)*100}%`;
        }

        if (logsRes.ok) {
            const logs = await logsRes.json();
            const tbody = document.getElementById('telemetry-table-body');
            if (tbody) {
                if (logs.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-tertiary);">No requests logged yet.</td></tr>';
                } else {
                    tbody.innerHTML = logs.map(l => `
                        <tr>
                            <td>${l.timestamp}</td>
                            <td><code>${l.endpoint}</code></td>
                            <td>${l.model} (${l.provider})</td>
                            <td>${l.latency_ms} ms</td>
                            <td><span class="badge-status ${l.status === 'success' ? 'indexed' : 'processing'}">● ${l.status}</span></td>
                        </tr>
                    `).join('');
                }
            }
        }
    } catch (e) {
        console.error('Failed to load telemetry', e);
    }
}

// ─── INIT ───
window.addEventListener('DOMContentLoaded', () => {
    clearAuthInputs();
    initSidebarResizer();
    initAuth();
});

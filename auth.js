// ── AbsoraCloud Central Authentication & API Client ──

const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:3000'
  : 'https://absoracloud.onrender.com';

function getToken() {
  return localStorage.getItem('absora_token') || localStorage.getItem('auth_token') || null;
}

function setToken(token) {
  if (!token) return;
  localStorage.setItem('absora_token', token);
  localStorage.setItem('auth_token', token);
}

function clearToken() {
  localStorage.removeItem('absora_token');
  localStorage.removeItem('auth_token');
}

function logout() {
  clearToken();
  window.location.href = 'index.html';
}

function showWakeupBanner(msg, showRetry = false, retryFn = null) {
  let banner = document.getElementById('auth-wakeup-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'auth-wakeup-banner';
    banner.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;background:#141a24;color:#f1f5f9;padding:12px 18px;border-radius:14px;border:1px solid rgba(255,255,255,0.15);box-shadow:0 12px 30px rgba(0,0,0,0.5);font-size:12px;font-family:sans-serif;display:flex;align-items:center;gap:12px;backdrop-filter:blur(8px);';
    document.body.appendChild(banner);
  }
  banner.innerHTML = `<span>${msg}</span>`;
  if (showRetry && retryFn) {
    const btn = document.createElement('button');
    btn.textContent = 'Retry';
    btn.style.cssText = 'background:#0ea5e9;color:#fff;border:none;padding:5px 12px;border-radius:8px;font-weight:bold;cursor:pointer;font-size:11px;';
    btn.onclick = () => {
      banner.remove();
      retryFn();
    };
    banner.appendChild(btn);
  }
}

function hideWakeupBanner() {
  const banner = document.getElementById('auth-wakeup-banner');
  if (banner) banner.remove();
}

async function requireLogin() {
  const token = getToken();
  const pageName = window.location.pathname.split('/').pop() || 'console.html';

  if (!token) {
    clearToken();
    window.location.href = `app.html?mode=login&next=${encodeURIComponent(pageName)}`;
    return null;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      // Definitive invalid credentials: clear token and redirect
      if (res.status === 401 || res.status === 403) {
        hideWakeupBanner();
        clearToken();
        window.location.href = `app.html?mode=login&next=${encodeURIComponent(pageName)}`;
        return null;
      }

      if (res.ok) {
        const data = await res.json();
        // A response that is OK but has no user object counts as invalid: treat like 401
        if (!data || !data.user) {
          hideWakeupBanner();
          clearToken();
          window.location.href = `app.html?mode=login&next=${encodeURIComponent(pageName)}`;
          return null;
        }
        hideWakeupBanner();
        return data;
      }

      // Other HTTP errors (429, 5xx): keep token, retry up to 3 times
      if (attempt < 3) {
        showWakeupBanner('Server is waking up, retrying...');
        await new Promise(r => setTimeout(r, 3000));
      } else {
        // All retries failed: do NOT clear token, do NOT redirect, offer Retry
        showWakeupBanner('Server is unavailable. Please check your connection.', true, () => requireLogin());
        return null;
      }
    } catch (err) {
      // Network errors, connection timeouts: keep token, retry up to 3 times
      if (attempt < 3) {
        showWakeupBanner('Server is waking up, retrying...');
        await new Promise(r => setTimeout(r, 3000));
      } else {
        // All retries failed: do NOT clear token, do NOT redirect, offer Retry
        showWakeupBanner('Connection error. Server is waking up.', true, () => requireLogin());
        return null;
      }
    }
  }

  return null;
}

// Expose on window
window.API_BASE = API_BASE;
window.getToken = getToken;
window.setToken = setToken;
window.clearToken = clearToken;
window.logout = logout;
window.requireLogin = requireLogin;

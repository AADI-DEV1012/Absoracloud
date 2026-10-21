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

async function requireLogin() {
  const token = getToken();
  const pageName = window.location.pathname.split('/').pop() || 'console.html';

  if (!token) {
    clearToken();
    window.location.href = `app.html?mode=login&next=${encodeURIComponent(pageName)}`;
    return null;
  }

  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) {
      clearToken();
      window.location.href = `app.html?mode=login&next=${encodeURIComponent(pageName)}`;
      return null;
    }

    const data = await res.json();
    if (!data || !data.user) {
      clearToken();
      window.location.href = `app.html?mode=login&next=${encodeURIComponent(pageName)}`;
      return null;
    }

    return data;
  } catch (err) {
    console.error('requireLogin error:', err);
    clearToken();
    window.location.href = `app.html?mode=login&next=${encodeURIComponent(pageName)}`;
    return null;
  }
}

// Expose on window
window.API_BASE = API_BASE;
window.getToken = getToken;
window.setToken = setToken;
window.clearToken = clearToken;
window.logout = logout;
window.requireLogin = requireLogin;

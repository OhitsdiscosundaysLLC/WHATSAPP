(function () {
  const form = document.getElementById('login-form');
  const passwordInput = document.getElementById('password');
  const errorEl = document.getElementById('error');
  const submitBtn = document.getElementById('submit-btn');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';

    try {
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput.value }),
      });

      if (res.ok) {
        window.location.href = '/';
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        const seconds = Math.ceil((data.retryAfterMs || 0) / 1000);
        errorEl.textContent = `Too many attempts. Try again in ${seconds}s.`;
      } else if (res.status === 503) {
        errorEl.textContent =
          'Dashboard is not configured yet (DASHBOARD_ADMIN_PASSWORD is unset).';
      } else {
        errorEl.textContent = 'Incorrect password.';
      }
    } catch (err) {
      errorEl.textContent = 'Could not reach the server. Try again.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
      passwordInput.value = '';
      passwordInput.focus();
    }
  });
})();

// Cloudflare Turnstile（免费的人机验证）服务端校验。
// 仅本地测试用：把 TURNSTILE_SECRET 设为 "__dev_skip__" 会跳过校验，正式环境绝对不要这样设。
export async function verifyTurnstile(token, secret, ip) {
  if (secret === '__dev_skip__') return true;
  if (!secret || !token) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const j = await r.json();
    return j.success === true;
  } catch {
    return false;
  }
}

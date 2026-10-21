// Judging Cloudflare Turnstile's siteverify answer.
// A token that passed is not enough: it must also have been earned on one of our own hostnames and for the action
// this server asks about, so a token solved on another site that shares the widget cannot be used here.
// Hostname and action are only enforced when hostnames are configured (TURNSTILE_HOSTNAMES in wrangler.jsonc); local
// development with Cloudflare's test keys leaves it empty.
export const CAPTCHA_ACTION = 'create_project';

export function parseHostnames(value) {
	return typeof value === 'string' ? value.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) : [];
}

export function captchaAccepted(result, hostnames = []) {
	if (!result || result.success !== true) return false;
	if (!hostnames.length) return true;
	return result.action === CAPTCHA_ACTION && typeof result.hostname === 'string' && hostnames.includes(result.hostname.toLowerCase());
}

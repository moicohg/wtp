// Teléfono como usuario de login del vendedor. Espejo exacto de
// normalizePhone / vendorLoginEmail en dashboard/app.js: el navegador deriva
// el mismo correo sintético para iniciar sesión, así que cualquier cambio
// aquí debe replicarse allá.

// TLD reservado (RFC 2606): nunca resuelve, nunca recibe correo. Los
// vendedores no reciben emails de Auth (se crean confirmados y su contraseña
// la resetea su empresa desde el panel).
export const VENDOR_LOGIN_DOMAIN = 'vendedor.invalid';

const E164 = /^\+[1-9][0-9]{6,14}$/;

export function normalizePhone(dial: string, number: string): string | null {
  const cc = (dial ?? '').replace(/\D/g, '');
  const n = (number ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (!cc || !n) return null;
  const e164 = `+${cc}${n}`;
  return E164.test(e164) ? e164 : null;
}

export function normalizeE164(raw: string): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const e164 = `+${digits}`;
  return E164.test(e164) ? e164 : null;
}

export function vendorLoginEmail(e164: string): string {
  return `${e164.replace(/\D/g, '')}@${VENDOR_LOGIN_DOMAIN}`;
}

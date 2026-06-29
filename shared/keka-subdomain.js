// Normalize Keka tenant slug — JWT may use "acquaint" or "acquaint.keka.com".

function normalizeKekaSubdomain(value) {
  if (!value || typeof value !== "string") return null;

  let s = value.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

  const fullHost = s.match(/^([a-z0-9-]+)\.keka\.com$/i);
  if (fullHost) return fullHost[1];

  if (/^[a-z0-9-]+$/i.test(s)) return s;

  const embedded = s.match(/([a-z0-9-]+)\.keka\.com/i);
  if (embedded) return embedded[1];

  return null;
}

function getKekaSubdomainFromPayload(payload) {
  if (!payload) return null;

  const candidates = [
    payload.subdomain,
    payload.tenant_subdomain,
    payload.tenantSubdomain,
  ];

  for (const candidate of candidates) {
    const slug = normalizeKekaSubdomain(candidate);
    if (slug) return slug;
  }

  const fromIss = normalizeKekaSubdomain(payload.iss);
  if (fromIss && fromIss !== "app") return fromIss;

  return null;
}

function getKekaSubdomainFromToken(token) {
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return getKekaSubdomainFromPayload(JSON.parse(atob(base64)));
  } catch {
    return null;
  }
}

function kekaTenantBaseUrl(subdomainOrSlug) {
  const slug = normalizeKekaSubdomain(subdomainOrSlug) || "acquaint";
  return `https://${slug}.keka.com`;
}

// Parse GET /k/dashboard/api/context JSON (extension scripts)

function pickProfileString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseKekaContextPayload(data) {
  if (!data || typeof data !== "object") return null;

  const root =
    data.data && typeof data.data === "object"
      ? data.data
      : data.employee || data.org
        ? data
        : null;
  if (!root) return null;

  const display_name = pickProfileString(
    root.employee?.displayName,
    root.employee?.display_name,
    root.employee?.name,
  );
  const company_name = pickProfileString(
    root.org?.name,
    root.org?.shortName,
    root.org?.short_name,
  );

  if (!display_name && !company_name) return null;
  return { display_name, company_name };
}

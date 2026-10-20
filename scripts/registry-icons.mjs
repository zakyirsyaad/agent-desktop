// Picks the registry's agent icons that the app may bundle: SVG, small, and only
// from the registry CDN. Mirrors the checks in src-tauri/src/registry/icons.rs.

export const ICON_URL_PREFIX = "https://cdn.agentclientprotocol.com/";
export const MAX_ICON_BYTES = 64 * 1024;

export const isAllowedIconUrl = (url) => typeof url === "string" && url.startsWith(ICON_URL_PREFIX);

export const isSvg = (text) => typeof text === "string" && /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text);

/** `{ [id]: svg }` for the entries whose icon downloads as a small SVG; keys sorted. */
export const bundleIcons = async (entries, fetchText) => {
  const icons = {};
  for (const { id, icon } of entries) {
    if (!isAllowedIconUrl(icon)) continue;
    let body;
    try {
      body = await fetchText(icon);
    } catch (error) {
      console.warn(`Skipping the icon for ${id}: ${error.message}`);
      continue;
    }
    if (typeof body === "string" && Buffer.byteLength(body) <= MAX_ICON_BYTES && isSvg(body)) icons[id] = body;
  }
  return Object.fromEntries(Object.entries(icons).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};

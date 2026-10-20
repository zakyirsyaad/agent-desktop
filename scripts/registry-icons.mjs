// Picks the registry's agent icons that the app may bundle: SVG, small, and only
// from the registry CDN. Mirrors the checks in src-tauri/src/registry/icons.rs.

export const ICON_URL_PREFIX = "https://cdn.agentclientprotocol.com/";
export const MAX_ICON_BYTES = 64 * 1024;

export const isAllowedIconUrl = (url) => typeof url === "string" && url.startsWith(ICON_URL_PREFIX);

// Same rule as `is_svg` in icons.rs: after whitespace and an optional XML prolog, an `<svg` tag.
export const isSvg = (text) => typeof text === "string" && /^\s*(<\?xml[\s\S]*?\?>\s*)?<svg[\s>/]/i.test(text);

/**
 * `{ [id]: svg }` for the entries whose icon downloads as a small SVG; keys sorted.
 * A still-listed id whose download fails or is invalid keeps its `previous` copy.
 */
export const bundleIcons = async (entries, fetchText, previous = {}) => {
  const icons = {};
  for (const { id, icon } of entries) {
    if (!isAllowedIconUrl(icon)) continue;
    const fallback = isSvg(previous[id]) ? previous[id] : undefined;
    let body;
    try {
      body = await fetchText(icon);
    } catch (error) {
      console.warn(`Could not download the icon for ${id}${fallback ? ", keeping the bundled copy" : ""}: ${error.message}`);
      if (fallback) icons[id] = fallback;
      continue;
    }
    if (typeof body === "string" && Buffer.byteLength(body) <= MAX_ICON_BYTES && isSvg(body)) icons[id] = body;
    else if (fallback) icons[id] = fallback;
  }
  return Object.fromEntries(Object.entries(icons).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};

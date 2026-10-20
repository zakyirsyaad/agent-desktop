// Picks the registry's agent icons that the app may bundle: SVG, small, and only
// from the registry CDN. Mirrors the checks in src-tauri/src/registry/icons.rs.

export const ICON_URL_PREFIX = "https://cdn.agentclientprotocol.com/";
export const MAX_ICON_BYTES = 64 * 1024;

export const isAllowedIconUrl = (url) => typeof url === "string" && url.startsWith(ICON_URL_PREFIX);

// Rust's `char::is_whitespace`; JS `\s` differs (it adds U+FEFF and lacks U+0085).
const RUST_WHITESPACE = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

const trimStartLikeRust = (text) => {
  let start = 0;
  while (start < text.length && RUST_WHITESPACE.test(text[start])) start += 1;
  return text.slice(start);
};

// Same rule as `is_svg` in icons.rs, step for step and without a regex over the body (so no
// backtracking): after whitespace and an optional `<?xml … ?>` prolog, an `<svg` tag in any case
// followed by whitespace, `>` or `/`.
export const isSvg = (text) => {
  if (typeof text !== "string") return false;
  let rest = trimStartLikeRust(text);
  if (rest.startsWith("<?xml")) {
    const end = rest.indexOf("?>");
    if (end === -1) return false;
    rest = trimStartLikeRust(rest.slice(end + 2));
  }
  const next = rest.charAt(4);
  return rest.slice(0, 4).toLowerCase() === "<svg" && (RUST_WHITESPACE.test(next) || next === ">" || next === "/");
};

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

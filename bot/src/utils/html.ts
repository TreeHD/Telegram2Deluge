// Escape text for Telegram HTML parse_mode (entity body).
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Escape a URL for use inside an HTML href="" attribute.
// The URL should already be percent-encoded; here we only neutralize
// the few characters that would break the attribute or HTML parsing.
export function escapeHref(url: string): string {
  return url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "%22")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
}

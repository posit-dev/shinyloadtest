export function getUrlState(): {
  section: string
  tab: string | null
  run: string | null
} {
  const params = new URLSearchParams(window.location.search)
  return {
    section: params.get("section") ?? "sessions",
    tab: params.get("tab"),
    run: params.get("run"),
  }
}

export function updateUrlState(
  updates: Record<string, string | number | null | undefined>,
): void {
  const params = new URLSearchParams(window.location.search)
  for (const [key, value] of Object.entries(updates)) {
    if (value !== null && value !== undefined) {
      params.set(key, String(value))
    } else {
      params.delete(key)
    }
  }
  const qs = params.toString()
  const url = window.location.pathname + (qs ? "?" + qs : "")
  window.history.replaceState(null, "", url)
}

/**
 * Token discovery and replacement for recording.
 * Maps actual session values to their ${PLACEHOLDER} equivalents.
 */

export class RecordingTokens {
  // Maps actual value -> placeholder name (e.g. "abc123" -> "WORKER")
  private readonly tokens = new Map<string, string>()

  /**
   * Register a discovered token value.
   * If the value is empty or already known, this is a no-op.
   */
  discover(name: string, value: string): void {
    if (!value) return
    this.tokens.set(value, name)
  }

  /**
   * Replace all known actual values in a string with their ${PLACEHOLDER} equivalents.
   * Longer values are replaced first to avoid partial matches.
   */
  replaceInString(str: string): string {
    if (this.tokens.size === 0) return str

    // Sort by value length descending to replace longer matches first
    const entries = [...this.tokens.entries()].sort(
      (a, b) => b[0].length - a[0].length,
    )

    let result = str
    for (const [actual, name] of entries) {
      result = result.replaceAll(actual, `\${${name}}`)
    }
    return result
  }

  /** Number of discovered tokens. */
  get size(): number {
    return this.tokens.size
  }

  /** Check if a token name has been discovered. */
  has(name: string): boolean {
    for (const v of this.tokens.values()) {
      if (v === name) return true
    }
    return false
  }
}

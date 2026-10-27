/**
 * Xana's agent mark: a cyan tile with a voice level, and the colour of its letter-spaced XANA wordmark. Cyan is a hue
 * none of Ultimate's own marks or state colours use (brand violet, success green, warning amber, error red), so the
 * relay reads as its own identity next to @ultimate and the lander.
 */
export const xanaTile = {
  tint: 'bg-cyan-500/12 text-cyan-700 ring-cyan-600/25 dark:text-cyan-300/80 dark:ring-cyan-300/20',
  // Three thick bars, the middle one tallest: a finer waveform blurs into a block on the 14px tile.
  glyph: (
    <svg
      className="size-[64%]"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth={2.75}
      viewBox="0 0 24 24"
    >
      <path d="M5.5 9v6M12 4v16M18.5 7.5v9" />
    </svg>
  ),
  wordmark: 'text-cyan-700 dark:text-cyan-300/80',
}

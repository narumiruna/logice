export type GlyphName =
  | "activity"
  | "search"
  | "chevron"
  | "clock"
  | "pause"
  | "play"
  | "collapse"
  | "expand"
  | "close"
  | "copy"
  | "arrow-down"
  | "reset"
  | "code"
  | "layers"
  | "box"
  | "arrow-left"

const paths: Record<GlyphName, string> = {
  activity: "M3 12h4l3-8 4 16 3-8h4",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  chevron: "m9 5 7 7-7 7",
  clock: "M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  pause: "M8 5v14 M16 5v14",
  play: "m8 4 12 8-12 8z",
  collapse: "m5 8 7 6 7-6 M5 3l7 6 7-6 M4 21h16",
  expand: "m5 10 7-6 7 6 M5 16l7-6 7 6 M4 21h16",
  close: "m6 6 12 12 M6 18 18 6",
  copy: "M9 9h12v12H9z M15 5V2H2v13h3",
  "arrow-down": "M12 3v17 m-6-6 6 6 6-6",
  reset: "M3 10a9 9 0 1 1 2 9 M3 3v7h7",
  code: "m8 6-6 6 6 6 m8-12 6 6-6 6 m-3-15-2 18",
  layers: "m12 2 10 6-10 6L2 8z M2 13l10 6 10-6 M2 18l10 6 10-6",
  box: "m12 2 9 5v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10",
  "arrow-left": "M21 12H3 m7-7-7 7 7 7",
}

export function Glyph({ name, size = 16 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}

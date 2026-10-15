const PATHS = {
  open: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  save: "M5 3h11l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 3v5h7V3M8 21v-7h8v7",
  saveAs: "M5 3h11l4 4v5M4 4v16a1 1 0 0 0 1 1h8M8 3v5h7V3M8 21v-7h3M18 15v6M15 18h6",
  export: "M12 3v12M8 7l4-4 4 4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4",
  openAs: "M4 6h16M4 12h10M4 18h8M16 15l3 3 3-3",
  panel: "M4 5h16v14H4zM15 5v14",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
  system: "M3 5h18v11H3zM8 20h8M12 16v4",
  command: "M4 17l5-5-5-5M12 19h8",
  close: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  file: "M6 3h8l5 5v13H6zM14 3v5h5",
  text: "M6 3h8l5 5v13H6zM14 3v5h5M9 13h7M9 17h7",
  richText: "M6 3h8l5 5v13H6zM14 3v5h5M9 12h7M9 15h7M9 18h4",
  sheet: "M4 4h16v16H4zM4 10h16M4 15h16M10 4v16M15 4v16",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
  pdf: "M6 3h8l5 5v13H6zM14 3v5h5M9 15h6M9 18h4",
  archive: "M4 6h16v4H4zM5 10v10h14V10M10 14h4",
  media: "M5 4h14v16H5zM10 9l5 3-5 3z",
  database:
    "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  records: "M4 5h16v15H4zM4 10h16M8 3v4M16 3v4",
  notebook: "M6 3h12v18H6zM9 8h6M9 12h6M3 7h3M3 12h3M3 17h3",
  ebook: "M4 4h7a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-7v16a2 2 0 0 1 2-2h5z",
  slides: "M3 4h18v12H3zM9 20l3-4 3 4",
  binary: "M5 4h5v7H5zM14 13h5v7h-5zM14 4v7M19 4v7M5 13v7M10 13v7",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

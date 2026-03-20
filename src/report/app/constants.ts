export const EVENT_TYPE_MAP = {
  REQ_HOME: "Homepage",
  REQ_GET: "JS/CSS",
  WS_OPEN: "Start Session",
  WS_RECV: "Calculate",
} as const

export const EVENT_COLORS: Record<string, string> = {
  Homepage: "#f28983",
  "JS/CSS": "#fdc086",
  "Start Session": "#9cffd9",
  Calculate: "#75aadb",
}

export const EVENT_ORDER = [
  "Homepage",
  "JS/CSS",
  "Start Session",
  "Calculate",
] as const

export const RUN_COLORS = [
  "#7fc97f",
  "#beaed4",
  "#fdc086",
  "#f28983",
  "#7ddbb6",
  "#75aadb",
  "#5d945d",
  "#9084a1",
  "#c9996b",
  "#bd5c57",
  "#5fa68a",
  "#5981a6",
  "#9efa9e",
  "#e5d1ff",
  "#8df5cc",
  "#88c6ff",
  "#3d613d",
  "#625a6e",
  "#967250",
  "#8a433f",
  "#467362",
  "#3d5973",
] as const

export const CHART_WIDTH = 1200

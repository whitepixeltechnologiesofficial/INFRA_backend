import type { JSX, ReactNode } from "react";
import {
  add,
  alertCircleOutline,
  alertOutline,
  arrowForward,
  attachOutline,
  cameraOutline,
  chatbubblesOutline,
  checkmark,
  checkmarkCircleOutline,
  checkmarkDone,
  chevronBack,
  chevronDown,
  chevronForward,
  chevronUp,
  close,
  closeCircleOutline,
  createOutline,
  desktopOutline,
  documentTextOutline,
  ellipsisHorizontal,
  imagesOutline,
  informationCircleOutline,
  keyOutline,
  lockClosedOutline,
  logOutOutline,
  micOutline,
  moonOutline,
  notificationsOffOutline,
  pause,
  peopleOutline,
  personAddOutline,
  personCircleOutline,
  phonePortraitOutline,
  play,
  qrCodeOutline,
  refreshOutline,
  returnUpBackOutline,
  searchOutline,
  send,
  settingsOutline,
  shieldCheckmarkOutline,
  sunnyOutline,
  timeOutline,
  trashOutline,
} from "ionicons/icons";

// Web icon set. The glyphs come from the same family the mobile app already
// ships (@expo/vector-icons -> Ionicons), so both clients draw the same marks
// instead of mixing families. We render the packaged paths directly as inline
// SVG so they inherit `color` and stay tree-shaken per icon (no web-component
// wrapper, no icon webfont, no data-URI <img> that would freeze the colour).

const RAW = {
  add,
  alert: alertCircleOutline,
  arrowForward,
  attach: attachOutline,
  camera: cameraOutline,
  chatbubbles: chatbubblesOutline,
  check: checkmark,
  checkCircle: checkmarkCircleOutline,
  checkmarkDone,
  chevronBack,
  chevronDown,
  chevronForward,
  chevronUp,
  close,
  closeCircle: closeCircleOutline,
  compose: createOutline,
  desktop: desktopOutline,
  doc: documentTextOutline,
  ellipsis: ellipsisHorizontal,
  images: imagesOutline,
  info: informationCircleOutline,
  key: keyOutline,
  lock: lockClosedOutline,
  logOut: logOutOutline,
  mic: micOutline,
  moon: moonOutline,
  notificationsOff: notificationsOffOutline,
  pause,
  people: peopleOutline,
  personAdd: personAddOutline,
  person: personCircleOutline,
  phone: phonePortraitOutline,
  play,
  qr: qrCodeOutline,
  refresh: refreshOutline,
  reply: returnUpBackOutline,
  search: searchOutline,
  send,
  settings: settingsOutline,
  shield: shieldCheckmarkOutline,
  sunny: sunnyOutline,
  time: timeOutline,
  trash: trashOutline,
  warning: alertOutline,
} as const;

export type IconName = keyof typeof RAW;

interface GlyphPath {
  kind: "path";
  d: string;
  outline: boolean;
  width: number;
  cap?: string;
  join?: string;
  miter?: number;
}

interface GlyphBasic {
  kind: "circle" | "rect" | "line" | "poly" | "ellipse";
  outline: boolean;
  width: number;
  attrs: Record<string, string>;
}

type Glyph = GlyphPath | GlyphBasic;

const ELEMENT_RE = /<(path|circle|rect|line|polyline|polygon|ellipse)\b([^>]*?)\/?>/g;
const ATTR_RE = /([\w-]+)='([^']*)'/g;
const DEFAULT_STROKE = 32;

function parseGlyph(dataUri: string): Glyph[] {
  const comma = dataUri.indexOf(",");
  if (comma < 0) return [];
  const svg = decodeURIComponent(dataUri.slice(comma + 1));
  const out: Glyph[] = [];
  for (const el of svg.matchAll(ELEMENT_RE)) {
    const tag = el[1] ?? "";
    const rawAttrs = el[2] ?? "";
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs.matchAll(ATTR_RE)) {
      const key = a[1];
      const value = a[2];
      if (key !== undefined && value !== undefined) attrs[key] = value;
    }
    const cls = attrs.class ?? "";
    const outline = cls.includes("ionicon-fill-none");
    const declared = Number.parseFloat(attrs["stroke-width"] ?? "");
    const width = Number.isFinite(declared) ? declared : DEFAULT_STROKE;
    if (tag === "path") {
      const g: GlyphPath = { kind: "path", d: attrs.d ?? "", outline, width };
      if (attrs["stroke-linecap"]) g.cap = attrs["stroke-linecap"];
      if (attrs["stroke-linejoin"]) g.join = attrs["stroke-linejoin"];
      if (attrs["stroke-miterlimit"]) g.miter = Number(attrs["stroke-miterlimit"]);
      out.push(g);
      continue;
    }
    const keep: Record<string, string> = {};
    for (const key of ["cx", "cy", "r", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "points", "rx", "ry"]) {
      if (attrs[key] !== undefined) keep[key] = attrs[key];
    }
    const kind = tag === "circle" || tag === "ellipse" || tag === "rect" || tag === "line" ? tag : "poly";
    out.push({ kind, outline, width, attrs: keep });
  }
  return out;
}

const cache = new Map<string, Glyph[]>();

function glyphsFor(name: IconName): Glyph[] {
  const raw = RAW[name];
  const hit = cache.get(raw);
  if (hit) return hit;
  const parsed = parseGlyph(raw);
  cache.set(raw, parsed);
  return parsed;
}

function paint(g: { outline: boolean; width: number; cap?: string; join?: string; miter?: number }): Record<string, ReactNode> {
  if (!g.outline) return { fill: "currentColor" };
  return {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: g.width,
    strokeLinecap: g.cap ?? "round",
    strokeLinejoin: g.join ?? "round",
    strokeMiterlimit: g.miter ?? 10,
  };
}

function renderGlyph(g: Glyph, key: number): JSX.Element {
  if (g.kind === "path") {
    return <path key={key} d={g.d} {...paint(g)} />;
  }
  if (g.kind === "circle") {
    return <circle key={key} cx={g.attrs.cx} cy={g.attrs.cy} r={g.attrs.r} {...paint(g)} />;
  }
  if (g.kind === "ellipse") {
    return <ellipse key={key} cx={g.attrs.cx} cy={g.attrs.cy} rx={g.attrs.rx} r={g.attrs.ry} {...paint(g)} />;
  }
  if (g.kind === "rect") {
    return <rect key={key} x={g.attrs.x} y={g.attrs.y} width={g.attrs.width} height={g.attrs.height} rx={g.attrs.rx} {...paint(g)} />;
  }
  if (g.kind === "line") {
    return <line key={key} x1={g.attrs.x1} y1={g.attrs.y1} x2={g.attrs.x2} y2={g.attrs.y2} {...paint(g)} />;
  }
  return <polyline key={key} points={g.attrs.points} {...paint(g)} />;
}

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  /** Supply only when the icon is the sole label of a control; otherwise it stays decorative. */
  title?: string;
}

export function Icon({ name, size = 20, className, title }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={className ? `icon ${className}` : "icon"}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {glyphsFor(name).map(renderGlyph)}
    </svg>
  );
}

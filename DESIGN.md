---
name: Playlet for Windows
description: An ad-free YouTube client for Windows 11, in black and gold.
colors:
  butterscotch-gold: "#d9a23a"
  gold-dim: "#c9a25a"
  gold-faint: "#b08a48"
  graphite-ink: "#1e1f24"
  graphite-hi: "#2c2d34"
  graphite-lo: "#111216"
  chip-hi: "#34353d"
  chip-hover: "#3a3b44"
  edge: "#3a3b42"
  edge-soft: "#2a2b31"
  hyper-cobalt: "#2448ff"
  cobalt-dim: "#1a36cc"
  on-cobalt: "#ffffff"
  glass-graphite: "rgba(30, 31, 36, 0.62)"
  glass-edge: "rgba(255, 236, 196, 0.16)"
  status-ok: "#6bd67b"
  status-error: "#ff8a7a"
typography:
  display:
    fontFamily: "Archivo, Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "Archivo, Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Inter Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "Inter Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.4
rounded:
  control: "10px"
  card: "16px"
  chip: "22px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
  "7": "48px"
components:
  button-primary:
    backgroundColor: "{colors.hyper-cobalt}"
    textColor: "{colors.on-cobalt}"
    rounded: "{rounded.pill}"
    padding: "9px 22px"
  button-primary-hover:
    backgroundColor: "{colors.cobalt-dim}"
  button-secondary:
    backgroundColor: "{colors.graphite-hi}"
    textColor: "{colors.butterscotch-gold}"
    rounded: "{rounded.pill}"
    padding: "8px 18px"
  button-secondary-hover:
    backgroundColor: "{colors.chip-hover}"
  chip:
    backgroundColor: "{colors.graphite-hi}"
    textColor: "{colors.gold-dim}"
    rounded: "{rounded.pill}"
    padding: "5px 12px"
  chip-selected:
    backgroundColor: "{colors.butterscotch-gold}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.pill}"
  card-group:
    backgroundColor: "{colors.graphite-hi}"
    rounded: "{rounded.card}"
    padding: "16px"
  input:
    backgroundColor: "{colors.chip-hi}"
    textColor: "{colors.butterscotch-gold}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  video-tile:
    backgroundColor: "{colors.graphite-hi}"
    rounded: "{rounded.card}"
    width: "260px"
  nav-item:
    backgroundColor: "{colors.graphite-ink}"
    textColor: "{colors.butterscotch-gold}"
    rounded: "{rounded.card}"
    height: "48px"
---

# Design System: Playlet for Windows

## Overview

**Creative North Star: "Black & Gold Screening Room"**

A dimmed room with the video as the only bright thing in it. Every screen stands on graphite, and butterscotch gold is the ink: titles, text, icons, hairlines and focus rings. Surfaces are soft neumorphic shapes in graphite's own hue, raised at rest and pressed in when chosen. Hyper Cobalt is the one cold note, used as light (glowing rings, seek bar, under-glow) and as the fill of a single main action per screen.

The app should feel like a Windows app with its own look, not a web page. Density is moderate: fixed-size video tiles, pill chips, rounded cards. Motion is part of the design (springy hovers, hand-drawn icons that act out their meaning, text that sharpens in) and it switches off live when Windows' animation effects are off.

The owner rejected a gold ground ("too much Butterscotch"), gold-filled glass panels ("generic") and a video-tinted glass. Butterscotch is ink, not ground.

**Key Characteristics:**
- Graphite ground on every screen, butterscotch for all ink.
- One selected look: pressed-in gold fill with graphite text.
- Cobalt only as light, rings, progress and one white-text main action.
- Frosted glass only over moving or scrolling content.
- Motion follows Windows' reduce-motion setting, live.

## Colors

Two warm notes on near-black, with one electric blue kept for light and the main action.

### Primary
- **Butterscotch Gold** (`butterscotch-gold`): the ink. Headings, body text, icons, focus outline, the gold hairline on Watch panels, and the fill of anything selected. 7.2:1 on graphite.
- **Gold Dim** and **Gold Faint** (`gold-dim`, `gold-faint`): secondary text (channel names, unselected chip labels) and tertiary text (meta lines, hints). Both stay at or above 4.5:1 on graphite.

### Secondary
- **Hyper Cobalt** (`hyper-cobalt`, hover `cobalt-dim`): the fill of the screen's main action with white text (6.1:1), the 2px ring on every video and playlist tile, resume bars, the played part of the seek bar, the active-page bar in the nav rail, and blue glows (tile hover, Subscribe halo, under the Watch panels).

### Neutral
- **Graphite Ink** (`graphite-ink`): the ground of every screen, the title bar, the rail and the player chrome.
- **Graphite Hi / Lo** (`graphite-hi`, `graphite-lo`): the light and dark halves of every neumorphic shadow; Graphite Hi is also the chip and card fill.
- **Chip Hi, Chip Hover** (`chip-hi`, `chip-hover`): nested surfaces (inputs, option cards, notices) and the hover fill of chips and buttons.
- **Edge, Edge Soft** (`edge`, `edge-soft`): dividers, the off toggle track, scrollbar thumbs.
- **Status** (`status-ok`, `status-error`): Settings status badges only.
- **Video plates**: duration, Live and queue badges sit on near-black `rgba(0,0,0,0.82)` with white text (Live uses gold text plus a dot), because they lie on thumbnails.

### Named Rules
**The Graphite Ground Rule.** Every screen, the Watch page included, stands on graphite. No screen gets a gold or light ground.

**The Cobalt Is Light Rule.** Cobalt is 2.7:1 on graphite, so it is never text, a thin icon or a focus ring. It is a fill with white text (one main action per screen: Subscribe, the first-run call to action, sign-in), a 2px ring, a progress fill, or a glow.

**The One Selected Look Rule.** Selected chips, tabs, menu options, option cards and "on" toggles are all the same: a gold fill, graphite text, pressed in with `--press-gold`. Cobalt never marks a selection.

## Typography

**Display Font:** Archivo (with Segoe UI Variable Display, Segoe UI, system-ui)
**Body Font:** Inter Variable (with Segoe UI Variable Text, Segoe UI, system-ui)

**Character:** Archivo's tight, slightly wide headings over a neutral Inter body. Both are bundled locally; the CSP loads fonts from the app only.

### Hierarchy
- **Display** (600, 28px, 1.2, -0.015em): the page `h1`. Screens set their own size: Search 22px, Channel and Settings 24px. The Watch video title is the one heavy heading (800, 26px).
- **Headline** (600, 18px, 1.25): `h2` section and shelf heads ("Channels", "Continue watching").
- **Title** (600, 14px, 1.35): video tile titles, always reserving two lines so every tile is the same height.
- **Body** (400, 14px, 1.5): default text. Secondary lines are 13px in Gold Dim.
- **Label** (600, 12px): chips, badges, meta lines (meta lines at 400 in Gold Faint). Durations, counts and timecodes use tabular figures (`.tnum`).

### Named Rules
**The Headings Move Rule.** Text motion is for headings, names, counts and labels only: page headings morph in (MorphText), channel and playlist names rise word by word (StaggerText), view, like and comment counts roll up from 0 (AnimatedNumber), and the empty search box cycles its hint. Body text never animates.

## Layout

A fixed 40px title bar across the top and a 68px icon-only nav rail on the left; pages fill the rest. Page padding is 24px (`space-5`); spacing steps are 4, 8, 12, 16, 24, 32, 48px. Shelves scroll sideways with 260px tiles; grids stretch tiles to the column. Scroll areas leave room around their contents so raised shadows are not clipped.

The Watch page never scrolls: a grid of the player column and a 340px Up next panel, both on graphite. The video is pinned and never moves; Up next, Description and Comments scroll inside their own panels.

## Elevation & Depth

Depth is neumorphic, made of graphite's own light and shade with the light from the top left. Buttons and chips are raised at rest and press in while clicked (moving down 1px). Pressed-in also means "this is where you are" (the active rail item, a subscribed button). Over video and scrolling content, depth comes from frosted glass and blue or video-colored light instead.

### Shadow Vocabulary
- **Raise** (`5px 5px 12px #111216, -4px -4px 10px #2c2d34`): hover plates behind tiles, large raised controls.
- **Raise small** (`3px 3px 7px #111216, -2px -2px 6px #2c2d34`): every button and chip at rest.
- **Press** (`inset 3px 3px 7px #111216, inset -3px -3px 7px #2c2d34`): pressed, active page, subscribed, thumbnail trays.
- **Press gold** (`inset 2px 2px 4px #a9792a, inset -2px -2px 4px #edbe5e`): anything selected on a gold fill. Graphite shadows smear a gold fill into a dark halo.
- **Cobalt glow** (`0 0 18px 3px rgba(36,72,255,0.55)` on tiles, `0 4px 18px` on Subscribe, `0 0 10px rgba(36,72,255,0.85)` on the seek bar).

### Named Rules
**The Glass Over Motion Rule.** Frosted glass is used only where something moves or scrolls underneath: the player dock, its menus and notices, and the two Watch panels. Browse pages, cards and Settings stay solid neumorphic graphite.

## Shapes

Soft and rounded throughout. Pills (999px) for chips, buttons and toggles; 16px for cards, thumbnails and nav items; 22px for the Watch panels and the player stage; 10px for inputs, menu rows and small controls; 4px only for the small plates on thumbnails. Avatars are circles. Borders are rare: the 1px gold hairline on Watch panels and the faint warm edge on glass.

Icons are hand-drawn inline SVG, no fill, `currentColor` stroke at 1.8 with round caps and joins. Nav icons are 24px and act out their meaning on hover or focus (roof hops and door opens, stack fans up, hands rewind, gear turns). Small control icons (chevrons, close) come from `Icon.svelte` at 16px.

## Components

### Buttons
- **Shape:** pill (999px).
- **Primary:** Hyper Cobalt fill, white text, 600 weight; hover Cobalt Dim. One per screen.
- **Secondary:** Graphite Hi fill, gold text; hover Chip Hover. Raised small at rest, pressed while clicked.
- **Toggle state (Subscribe):** once on, it drops to the secondary fill, pressed in.
- **Focus:** a 2px gold outline, 2px offset, on every focusable element.

### Chips
- **Style:** Graphite Hi fill, Gold Dim 12px/600 label, 5px 12px padding; hover brightens to Chip Hover and full gold.
- **State:** selected is the one selected look (gold fill, graphite text, press gold). Search filters, Channel tabs and Settings choice chips all use it.

### Cards / Containers
- **Settings groups:** Graphite Hi, 16px radius, 16px padding. Nested items (option cards, current-value rows, inputs, notices) step up to Chip Hi.
- **Option cards:** selected is the one selected look.
- **Toggles:** 40x22 pill. Off is an Edge track with a white knob; on is a gold track pressed in with a graphite knob.

### Inputs / Fields
- **Style:** Chip Hi fill, 1px Edge Soft border, 10px radius, 8px 12px padding, 13px text.
- **Focus:** the gold 2px focus outline like every other control.

### Navigation
- **Rail:** 68px, graphite, icon-only 48px items with 16px radius. Hover or keyboard focus slides a graphite label pill out over the page without moving it. The active page is pressed in with a 4x20px cobalt bar at the rail's edge.

### Video Tile (signature)
A 260px tile: the thumbnail sits in a pressed-in tray with a 2px cobalt ring. On hover or focus a raised graphite plate rises behind the whole tile, the ring glows blue and the image zooms 3%. Duration plate bottom right; Live is the same plate with gold text and a dot; a 3px cobalt resume bar along the bottom; queue actions fade in top right. The title always takes two lines' room.

### Player Dock (signature)
A frosted graphite dock floating over the video (18px radius). Seek track is translucent gold, played part cobalt with a glow, knob gold. CC and quality menus are a darker graphite tint (no second blur), sized to their longest label; the chosen row is the one selected look.

### Watch Panels (signature)
Smoked graphite glass (22px radius) with a 1px gold hairline at 0.65 alpha, a faint top sheen, a cobalt under-glow and a deep drop shadow. Behind the player a blurred glow takes the video's average color. The details bar rises in on each new video; Up next cards arrive one after another.

## Do's and Don'ts

### Do:
- **Do** put every new screen on the graphite ground and write all its text, icons and hairlines in the gold ink tokens.
- **Do** use the one selected look (gold fill, graphite text, `--press-gold`) for anything chosen.
- **Do** give a screen at most one cobalt main action with white text, and use cobalt otherwise only for rings, progress bars and glows.
- **Do** use the role tokens (`--ground`, `--ink`, `--chip`, `--accent`, `--raise`, `--press`) rather than the palette tokens or new hex values.
- **Do** draw new icons as inline SVG at stroke 1.8 with round caps, or use `Icon.svelte`.
- **Do** check `prefersReducedMotion` from `svelte/motion` for any JS-driven motion (tweens, smooth scroll, cycling text); the global CSS rule only stops CSS animations and transitions.
- **Do** use tabular figures for durations, counts and timecodes.

### Don't:
- **Don't** use cobalt for text, thin icons, focus rings or selection (2.7:1 on graphite).
- **Don't** use a gold or light ground, gold-filled panels or video-tinted glass; the owner rejected all three.
- **Don't** put frosted glass on surfaces with nothing moving or scrolling beneath them.
- **Don't** use text glyphs (▸ ▾ × ✕ ‹ ›) as icons, or an icon library.
- **Don't** use graphite shadows on a gold fill; use `--press-gold`.
- **Don't** use WebGL or 3D effects; they compete with the video decoder.

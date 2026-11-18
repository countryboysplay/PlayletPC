# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Playlet for Windows is a Tauri desktop app: a Svelte front end rendered in WebView2,
shipped as a per-user Windows 11 installer. Its design language is its own, not
Windows' native Fluent controls.

## Users

The owner first: one person watching YouTube daily on their own Windows PC, at a desk,
with a mouse and keyboard and often with other work open. What gets built follows that
use. The app is public on GitHub, so other Windows users who want YouTube without ads or
tracking are a second audience, served by the same choices.

## Product Purpose

An ad-free, tracking-free YouTube client for Windows 11: browse Home, Subscriptions,
Search, channels and playlists, then watch whole videos at up to 2160p. Success is
opening Playlet instead of youtube.com in a browser, and never noticing the plumbing
that makes playback work.

## Positioning

It feels like a Windows app, not a browser tab. Its own window, the Windows media flyout
and lock-screen artwork, the keyboard's media keys, picture-in-picture that keeps playing
while you browse, and silent auto-updates that never interrupt a video. A browser with an
ad blocker cannot claim this.

## Operating Context

- Launched from the Start menu or tray like any desktop app; runs alongside other work.
- Watching is the core loop: pick a video, watch it with the window at any size or in
  picture-in-picture, keep browsing, come back where you left off.
- Controlled by mouse, keyboard shortcuts (Ctrl+F / Ctrl+L to search) and hardware media
  keys.
- Updates download in the background and install only when the user chooses "Restart now",
  never while a video is open.

## Capabilities and Constraints

- Backends: YouTube directly (default, no third-party server) or an Invidious instance.
- Playback: adaptive DASH through shaka-player, quality menu, chapters on the seek bar, a
  CC menu that remembers the caption language, SponsorBlock (skip / ask / mark per
  category), picture-in-picture, an up-next queue that lasts until the app closes.
- Comments load under the video on request. Watch history, resume points, subscriptions and
  settings are stored only on this PC (`%APPDATA%\app.playlet.desktop\settings.json`).
- Signing in to a YouTube account is optional; the app works fully signed out.
- Downloads are deliberately out of scope.
- WebView2 constraints: the content security policy loads fonts from the app itself only;
  no WebGL or 3D effects, because they compete with the video decoder for the GPU.
- The installer is unsigned, so SmartScreen warns on first run.

## Brand Commitments

- The name is Playlet: this is a desktop port of Playlet for Roku by iBicha, and keeps its
  API contract, preference schema and SponsorBlock defaults. The original is credited.
- License: AGPL-3.0.
- Voice: plain, short, everyday English in the UI and docs; say what happened and what to
  do next, without jargon.

## Evidence on Hand

- `README.md`: feature list, privacy statement, build and release steps.
- `tests/fixtures/`: real YouTube InnerTube responses captured 2026-09-08.
- No testimonials, user counts, reviews or press exist. Do not invent any.

## Product Principles

1. The video comes first. Nothing on screen competes with it, moves it, or interrupts it.
2. Behave like a native Windows citizen: media keys, flyout, PiP, window controls, quiet
   updates.
3. Private by default: nothing leaves the PC except requests to YouTube (or the chosen
   Invidious instance) and hash-prefix SponsorBlock lookups.
4. It just plays: whole videos, with automatic fallbacks, and plain messages when
   something fails.

## Accessibility & Inclusion

- Respect Windows' "Animation effects" setting (prefers-reduced-motion) everywhere; motion
  is otherwise a normal part of the design.
- Full keyboard use with visible focus; text at WCAG AA contrast (4.5:1) or better.

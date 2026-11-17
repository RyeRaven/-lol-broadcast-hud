# PRODUCT.md

<!-- Written per impeccable init: durable product truth from repository + session evidence.
     Facts marked (inferred) are confirmed-by-usage but not user-stated verbatim. -->

## Product
Khada Jhin — a local League of Legends broadcast overlay suite (Windows, Electron-packaged Node server + browser pages consumed as OBS browser sources).

## Primary user
A solo Chinese-language streamer who casts his own LoL games. He composes scenes in OBS: the HUD overlay sits over gameplay footage; the BP screen fills the frame during draft; a transition wipe and a result banner support scene flow. Job while live: keep score, gold, timer, and draft state readable on stream with zero manual upkeep.

## Audience
Viewers of the stream, watching at ~1080p (often compressed), mostly LoL players familiar with the game's own HUD and with pro-broadcast graphics (LPL/LCK/Worlds). They glance — the overlay has under a second to land each fact. They never operate the overlay.

## Mechanism (what is meaningfully different)
Real-time truth, not mockups: the server ingests the Live Client Data API and spectator REST feed, decodes in-memory stat blocks (0xdd decoder), and pixel-reads HP/resource bars and OCRs the native gold panel via OBS source screenshots, then pushes typed protocol feeds to the overlay pages. The HUD's punch-hole geometry mirrors the native in-game HUD so it can sit exactly over it (native-alignment mode) or float free.

## Surfaces
- /broadcast/hud — in-game HUD: scorebar (kills, gold diff, timer) + bottom 10-player panel (KDA, CS, items, levels, HP/resource bars).
- /broadcast/bp + /overlay/bp-broadcast — draft screen: stage tiles, ban slots, timer, coach strip, timeline.
- /broadcast/result, /overlay/transition — result banner, wipe transition.
- Local control console for the caster.

## Platform
web (Electron shell; pages rendered offscreen or as OBS sources at 1920x1080).

## Stack
Node (no framework), vanilla JS/CSS pages, Electron for packaged app + offscreen rendering; OBS WebSocket integration for scene control and screenshots.

## Durable constraints
- **Bahnschrift** is the pinned base font stack (user-pinned 2026-11-16); CJK fallback Microsoft YaHei. Do not replace without asking.
- **HUD geometry is frozen**: punch-hole grid, row pitch, and the mid-column 20/20 symmetry come from on-machine calibration (native defaults + hud-calib.json). Visual redesign must not move geometry.
- Blue = blue side, red = red side; team colors stay semantically blue/red. Resource bars keep game-semantic colors (mana blue, energy, etc.).
- Overlay must stay legible over bright gameplay: grounds are dark, text ≥4.5:1 against its ground.
- Dev server port 3314; package releases only on the user's explicit announce (latest packaged: 0.2.3).
- Wordmark: KHADA JHIN (rebrand complete; RiftBroadcast legacy name kept only for OBS source renaming).

## Binding visual constraint (user, 2026-11-16)
The redesign must read as **esports** — the visual language of competitive gaming broadcasts — not a generic luxury/art-piece skin. A previous "gold theater" direction (gold-on-black, gold rings/halos) was rejected by the user as ugly and is scrapped. Design flow must actively follow the impeccable/taste-skill/emil-design-eng skills.

## Success
On a glance: viewers parse score, gold lead, and timer without effort; the BP screen reads like an official league broadcast; the caster is proud to put it on stream.

## Voice
Broadcast-professional, bilingual labels (EN caps for system labels + 简体中文 where the caster's audience expects it); no marketing copy anywhere — it is a broadcast instrument.

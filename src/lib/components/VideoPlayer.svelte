<script lang="ts">
  import { untrack } from 'svelte'
  import {
    PlayletPlayer,
    SponsorBlockController,
    attachSponsorBlock,
    fetchSponsorSegments,
    type QualityOption,
    type TextTrackOption
  } from '../player'
  import type { VideoDetails, SponsorBlockCategory } from '../api/types'
  import { categoryColor, categoryTitle } from '../api/sponsorblock'
  import { transportFetch } from '../api/http'
  import { settings } from '../stores/settings.svelte'
  import { session } from '../stores/session.svelte'
  import { shell } from '../shell'
  import { formatDuration, pickThumbnail } from '../format'
  import MorphText from './MorphText.svelte'

  interface Props {
    video: VideoDetails
    /** Seconds to resume from, 0 to start at the beginning. */
    startAt?: number
    onProgress?: (seconds: number) => void
    onEnded?: () => void
    /** The Windows media flyout / hardware Next and Previous keys. */
    onNext?: () => void
    onPrevious?: () => void
  }

  let { video, startAt = 0, onProgress, onEnded, onNext, onPrevious }: Props = $props()

  let videoEl: HTMLVideoElement | undefined = $state()
  let container: HTMLDivElement | undefined = $state()
  let player: PlayletPlayer | null = null
  let sponsorBlock: SponsorBlockController | null = null
  let detachSponsorBlock: (() => void) | null = null
  let releaseSleepBlock: (() => void) | null = null
  let manifestObjectUrl: string | null = null

  let playing = $state(false)
  let buffering = $state(false)
  let currentTime = $state(0)
  let duration = $state(0)
  let volume = $state(1)
  let muted = $state(false)
  let qualities = $state<QualityOption[]>([])
  let activeQuality = $state<string>('auto')
  let loadError = $state<string | null>(null)
  let errorDetail = $state<string | null>(null)
  let controlsVisible = $state(true)
  let segments = $state<Array<{ category: SponsorBlockCategory; start: number; end: number }>>([])
  let skipNotice = $state<{ label: string; action: () => void; actionLabel: string } | null>(null)
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  let showQualityMenu = $state(false)
  let captionTracks = $state<TextTrackOption[]>([])
  let showCaptionMenu = $state(false)

  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let progressTimer: ReturnType<typeof setInterval> | null = null

  const progressPercent = $derived(duration > 0 ? (currentTime / duration) * 100 : 0)
  const chapters = $derived(video.chapters ?? [])
  const chapter = $derived(chapters.findLast(c => c.start <= currentTime))

  /** Map the stored per-category preference onto the controller's action vocabulary. */
  function sponsorCategoryConfig(): Record<string, 'skip' | 'notify' | 'ignore'> {
    const configured = settings.sponsorBlockCategories
    const result: Record<string, 'skip' | 'notify' | 'ignore'> = {}
    for (const [category, value] of Object.entries(configured)) {
      const option = value?.option
      if (option === 'auto_skip') result[category] = 'skip'
      else if (option === 'manual_skip') result[category] = 'notify'
      else result[category] = 'ignore'
    }
    return result
  }

  /**
   * Adapt the API response to the playback layer's shape.
   *
   * Invidious returns caption languages as `language_code`; the player reads
   * `languageCode`. Normalising here keeps the mismatch in one place instead of
   * failing later, mid-playback, when a caption track is requested.
   */
  function playableVideo(v: VideoDetails = video) {
    return {
      ...v,
      captions: (v.captions ?? []).map(caption => ({
        label: caption.label,
        languageCode: caption.language_code,
        url: caption.url
      }))
    }
  }

  async function setup() {
    if (!videoEl) return
    loadError = null

    player = new PlayletPlayer(videoEl, {
      // Direct-backend URLs come straight from YouTube and have no instance to proxy
      // through; rewriting them would produce a URL pointing at nothing.
      proxyMode: session.isDirect
        ? 'never'
        : settings.proxyVideos === 'always'
          ? 'always'
          : settings.proxyVideos === 'never'
            ? 'never'
            : 'auto',
      quality: settings.preferredQuality === 'auto' ? 'auto' : Number.parseInt(settings.preferredQuality, 10) || 'auto'
    })

    player.on('timeupdate', payload => {
      currentTime = payload.currentTime
      if (payload.duration > 0) duration = payload.duration
      // Drives the timeline in the Windows media flyout. Throws if position > duration.
      if (duration > 0) {
        try {
          navigator.mediaSession.setPositionState({ duration, position: Math.min(currentTime, duration) })
        } catch {
          /* a transient position past the end; the next tick corrects it */
        }
      }
    })
    player.on('play', () => {
      playing = true
      buffering = false
    })
    player.on('pause', () => (playing = false))
    player.on('buffering', payload => (buffering = payload.buffering))
    player.on('qualitiesupdated', payload => (qualities = payload.qualities))
    player.on('texttrackschanged', payload => (captionTracks = payload.tracks))
    player.on('ended', () => {
      playing = false
      onEnded?.()
    })
    player.on('error', payload => {
      // A direct progressive stream (the 360p fallback) is not proxied, so nothing renews
      // its URL; it expires after a few hours, e.g. across a long pause. Refetch once.
      if (session.isDirect && payload.error.sourceKind === 'progressive' && !autoRetried) {
        autoRetried = true
        // The element pauses on the error, but it only fetches while playing or just
        // asked to play, so resume rather than leave a frozen frame.
        void retry().then(() => player?.play())
        return
      }
      loadError = describePlaybackError(payload.error)
      const { code, sourceKind, uri, httpStatus } = payload.error
      errorDetail = [code, sourceKind, httpStatus ? 'HTTP ' + httpStatus : null, uri]
        .filter(Boolean)
        .join(' · ')
    })

    attachMediaSession()

    if (settings.sponsorBlockEnabled) {
      sponsorBlock = new SponsorBlockController({ categories: sponsorCategoryConfig() })
      detachSponsorBlock = attachSponsorBlock(player, sponsorBlock).detach

      sponsorBlock.on('skip', event => {
        if (!settings.sponsorBlockNotifications) return
        showNotice('Skipped ' + categoryTitle(event.segment.primaryCategory as SponsorBlockCategory, true).toLowerCase(), event.undo)
      })

      // Categories set to "manual skip" surface a prompt instead of jumping.
      sponsorBlock.on('notice', event => {
        showNotice(categoryTitle(event.segment.primaryCategory as SponsorBlockCategory, true), event.skip, 'Skip')
      })
    }

    // A locally generated manifest is handed over as a data: URI rather than a blob:
    // URL, because shaka registers network plugins for http/https and data: only - a
    // blob: manifest fails before a single byte is fetched. Manifests are a few KB.
    if (video.dashManifestXml) {
      manifestObjectUrl = 'data:application/dash+xml;base64,' + toBase64(video.dashManifestXml)
    }

    try {
      await player.load(playableVideo(), {
        instance: session.instance,
        startTime: startAt,
        manifestUri: manifestObjectUrl,
        captionLanguage: settings.captionLanguage || null
      })
      qualities = player.getQualities()
      duration = video.lengthSeconds

      if (settings.sponsorBlockEnabled && sponsorBlock) {
        const fetched = await fetchSponsorSegments(video.videoId, { fetchImpl: transportFetch })
        sponsorBlock.setSegments(fetched, video.lengthSeconds)
        segments = fetched
          .filter(s => s.actionType === 'skip' || s.actionType === 'mute')
          .map(s => ({ category: s.category as SponsorBlockCategory, start: s.segment[0], end: s.segment[1] }))
      }

      if (settings.autoplay) await player.play()
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Could not start this video.'
      const code = (err as { code?: string; status?: number }).status
      errorDetail = code ? 'HTTP ' + code : null
    }
  }

  let autoRetried = false

  /** On the direct backend, refetch first: the stream URLs themselves may have expired. */
  async function retry() {
    if (!player) return
    loadError = null
    errorDetail = null
    try {
      const fresh = session.isDirect ? await session.api.video(video.videoId, { noCache: true }) : null
      await player.recover({ forceProxy: !session.isDirect, video: fresh ? playableVideo(fresh) : undefined })
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Could not start this video.'
    }
  }

  /**
   * Windows media integration. WebView2 forwards the Media Session API to the system
   * media controls, so this gives the flyout its title and artwork, and routes the
   * hardware media keys here only while Playlet is the active media app - instead of
   * grabbing them system-wide from Spotify and every browser tab.
   */
  // One table for setting and clearing, so an added action can never outlive the player.
  // A null handler tells Windows to grey that button out.
  const mediaHandlers = (): Partial<Record<MediaSessionAction, MediaSessionActionHandler | null>> => ({
    play: () => void player?.play(),
    pause: () => player?.pause(),
    seekto: d => d.seekTime != null && player?.seek(d.seekTime),
    seekbackward: d => nudge(-(d.seekOffset ?? 10)),
    seekforward: d => nudge(d.seekOffset ?? 10),
    nexttrack: onNext ? () => onNext?.() : null,
    previoustrack: onPrevious ? () => onPrevious?.() : null
  })

  function attachMediaSession() {
    const artwork = pickThumbnail(video.videoThumbnails, 480)
    navigator.mediaSession.metadata = new MediaMetadata({
      title: video.title,
      artist: video.author,
      artwork: artwork ? [{ src: artwork }] : []
    })
    for (const [action, handler] of Object.entries(mediaHandlers())) {
      navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler)
    }
  }

  function detachMediaSession() {
    navigator.mediaSession.metadata = null
    for (const action of Object.keys(mediaHandlers())) {
      navigator.mediaSession.setActionHandler(action as MediaSessionAction, null)
    }
  }

  /** UTF-8 safe base64. Chunked because spreading a large byte array overflows the stack. */
  function toBase64(text: string): string {
    const bytes = new TextEncoder().encode(text)
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
  }

  /**
   * Say what actually went wrong.
   *
   * A 403 on the direct backend almost always means YouTube's per-format streaming cap
   * (about 20MB) rather than anything the user can retry away, and the generic message
   * ("retry through the instance proxy") is meaningless when there is no instance.
   */
  function describePlaybackError(error: { code?: string; message: string }): string {
    if (session.isDirect && error.code === 'STREAM_FORBIDDEN') {
      return 'YouTube stopped serving this stream. It limits how much of one quality it will hand out at a time, which bites soonest at high resolutions - try a lower quality.'
    }
    return error.message
  }

  function showNotice(label: string, action: () => void, actionLabel = 'Undo') {
    if (noticeTimer) clearTimeout(noticeTimer)
    skipNotice = {
      label,
      actionLabel,
      action: () => {
        action()
        skipNotice = null
      }
    }
    noticeTimer = setTimeout(() => (skipNotice = null), 6000)
  }

  function togglePlay() {
    if (!player) return
    if (playing) player.pause()
    else void player.play()
  }

  function scrub(event: MouseEvent) {
    const bar = event.currentTarget as HTMLElement
    const rect = bar.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    player?.seek(ratio * duration)
  }

  function nudge(seconds: number) {
    player?.seek(Math.min(duration, Math.max(0, currentTime + seconds)))
  }

  function changeVolume(value: number) {
    volume = value
    player?.setVolume(value)
    if (value > 0 && muted) {
      muted = false
      player?.setMuted(false)
    }
  }

  function toggleMute() {
    muted = !muted
    player?.setMuted(muted)
  }

  async function pickQuality(id: string) {
    activeQuality = id
    showQualityMenu = false
    await player?.setQuality(id === 'auto' ? 'auto' : id)
  }

  async function pickCaption(language: string | null) {
    showCaptionMenu = false
    void settings.set('playback.caption_language', language ?? '')
    await player?.setTextTrack(language)
  }

  function toggleFullscreen() {
    if (!container) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void container.requestFullscreen()
  }

  function togglePictureInPicture() {
    if (document.pictureInPictureElement) void document.exitPictureInPicture()
    // Rejects before the stream has loaded; the button just does nothing then.
    else void videoEl?.requestPictureInPicture().catch(() => {})
  }

  function showControls() {
    controlsVisible = true
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (playing) controlsVisible = false
    }, 2600)
  }

  function onKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
    // Hidden while the video plays in picture-in-picture: other pages own the keyboard.
    if (!container?.checkVisibility()) return

    switch (event.key) {
      case ' ':
      case 'k':
        event.preventDefault()
        togglePlay()
        break
      case 'ArrowLeft':
        nudge(-5)
        break
      case 'ArrowRight':
        nudge(5)
        break
      case 'j':
        nudge(-10)
        break
      case 'l':
        nudge(10)
        break
      case 'm':
        toggleMute()
        break
      case 'f':
        toggleFullscreen()
        break
      default:
        return
    }
    showControls()
  }

  $effect(() => {
    // untrack here is load-bearing, not decoration.
    //
    // setup() synchronously reads session.isDirect, settings.proxyVideos,
    // settings.preferredQuality and settings.sponsorBlockEnabled. Without untrack
    // each of those becomes a dependency of this effect, so writing any of them
    // re-runs it - and this effect's cleanup calls player.destroy(). The symptom
    // was a video dying silently ~18-20s in with a healthy decoder, a full buffer
    // and no error logged anywhere: the player was being torn down and rebuilt
    // underneath itself. The 5s progress timer below records resume positions,
    // which is a write that kept re-triggering it.
    //
    // Same trap as Home.svelte and Search.svelte. This effect must run once on
    // mount and clean up once on unmount.
    untrack(() => {
      void setup()
    })

    // Keep the display awake only while this component is mounted.
    void shell.preventSleep().then(release => {
      releaseSleepBlock = release
    })

    // Record progress on a timer rather than per tick, to avoid writing on every frame.
    progressTimer = setInterval(() => {
      if (playing && currentTime > 0) onProgress?.(currentTime)
    }, 5000)

    window.addEventListener('keydown', onKeydown)

    return () => {
      window.removeEventListener('keydown', onKeydown)
      if (progressTimer) clearInterval(progressTimer)
      if (hideTimer) clearTimeout(hideTimer)
      if (currentTime > 0) onProgress?.(currentTime)
      releaseSleepBlock?.()
      if (manifestObjectUrl && manifestObjectUrl.startsWith('blob:')) {
        URL.revokeObjectURL(manifestObjectUrl)
      }
      manifestObjectUrl = null
      detachSponsorBlock?.()
      detachMediaSession()
      if (noticeTimer) clearTimeout(noticeTimer)
      void player?.destroy()
      player = null
    }
  })
</script>

<!--
  The player is the logo's chip: dark, rounded, containing. Its seek bar is the one
  element that carries colour, because that is where SponsorBlock's data lives.
-->
<div
  class="stage zone-graphite"
  bind:this={container}
  onmousemove={showControls}
  onmouseleave={() => playing && (controlsVisible = false)}
  role="region"
  aria-label="Video player"
>
  <!-- svelte-ignore a11y_media_has_caption -- caption tracks are attached at runtime -->
  <video bind:this={videoEl} onclick={togglePlay} playsinline></video>

  {#if buffering && !loadError}
    <div class="spinner" aria-label="Buffering"></div>
  {/if}

  {#if loadError}
    <div class="failure">
      <h3>This video wouldn't play</h3>
      <p>{loadError}</p>
      {#if errorDetail}
        <p class="detail">{errorDetail}</p>
      {/if}
      <div class="failure-actions">
        <button class="primary" onclick={retry}>
          {session.isDirect ? 'Try again' : 'Retry through the instance'}
        </button>
        <button class="ghost" onclick={() => shell.openExternal('https://www.youtube.com/watch?v=' + video.videoId)}>
          Open on YouTube
        </button>
      </div>
    </div>
  {/if}

  {#if skipNotice}
    <div class="skip-notice frost">
      <span>{skipNotice.label}</span>
      <button onclick={skipNotice.action}>{skipNotice.actionLabel}</button>
    </div>
  {/if}

  <div class="controls frost" class:hidden={!controlsVisible && playing}>
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
    <div class="scrub" onclick={scrub}>
      <div class="track">
        {#each segments as segment (segment.start + '-' + segment.category)}
          <span
            class="segment"
            title={categoryTitle(segment.category)}
            style="left: {(segment.start / duration) * 100}%; width: {((segment.end - segment.start) / duration) * 100}%; background: {categoryColor(segment.category)}"
          ></span>
        {/each}
        <span class="played" style="width: {progressPercent}%"></span>
        {#if duration > 0}
          {#each chapters.slice(1) as c}
            <span class="chapter-tick" style="left: {(c.start / duration) * 100}%"></span>
          {/each}
        {/if}
        <span class="knob" style="left: {progressPercent}%"></span>
      </div>
    </div>

    <div class="row">
      <button onclick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} class="icon">
        {#if playing}
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" /></svg>
        {:else}
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor" /></svg>
        {/if}
      </button>

      <div class="volume">
        <button onclick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} class="icon">
          <svg viewBox="0 0 24 24" width="19" height="19">
            <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
            {#if !muted && volume > 0}
              <path d="M16.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            {:else}
              <path d="M17 9.5l4 5M21 9.5l-4 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            {/if}
          </svg>
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.02"
          value={muted ? 0 : volume}
          oninput={e => changeVolume(Number((e.currentTarget as HTMLInputElement).value))}
          aria-label="Volume"
        />
      </div>

      <span class="time tnum">{formatDuration(currentTime)} / {formatDuration(duration)}</span>
      {#if chapter?.title}
        <span class="chapter" title={chapter.title}><MorphText text={chapter.title} /></span>
      {/if}

      <div class="spacer"></div>

      {#if captionTracks.length > 0}
        <div class="quality">
          <button
            class="text-btn"
            class:on={captionTracks.some(t => t.active)}
            onclick={() => ((showCaptionMenu = !showCaptionMenu), (showQualityMenu = false))}
            aria-expanded={showCaptionMenu}
            aria-label="Captions">CC</button
          >
          {#if showCaptionMenu}
            <ul class="menu">
              <li><button onclick={() => pickCaption(null)} class:on={!captionTracks.some(t => t.active)}>Off</button></li>
              {#each captionTracks as track (track.id)}
                <li>
                  <button onclick={() => pickCaption(track.language)} class:on={track.active}>{track.label}</button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}

      {#if qualities.length > 0}
        <div class="quality">
          <button class="text-btn" onclick={() => ((showQualityMenu = !showQualityMenu), (showCaptionMenu = false))} aria-expanded={showQualityMenu}>
            {activeQuality === 'auto' ? 'Auto' : (qualities.find(q => q.id === activeQuality)?.label ?? 'Auto')}
          </button>
          {#if showQualityMenu}
            <ul class="menu">
              {#each qualities as quality (quality.id)}
                <li>
                  <button onclick={() => pickQuality(quality.id)} class:on={activeQuality === quality.id}>
                    {quality.label}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}

      {#if document.pictureInPictureEnabled}
        <button onclick={togglePictureInPicture} aria-label="Picture in picture" title="Picture in picture" class="icon">
          <svg viewBox="0 0 24 24" width="19" height="19">
            <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8" />
            <rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" />
          </svg>
        </button>
      {/if}

      <button onclick={toggleFullscreen} aria-label="Fullscreen" class="icon">
        <svg viewBox="0 0 24 24" width="19" height="19">
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </div>
</div>

<style>
  .stage {
    position: relative;
    aspect-ratio: 16 / 9;
    width: 100%;
    background: #000;
    border-radius: var(--r-chip);
    overflow: hidden;
    user-select: none;
  }

  .stage:fullscreen {
    border-radius: 0;
  }

  video {
    width: 100%;
    height: 100%;
    display: block;
    background: #000;
  }

  .spinner {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 42px;
    height: 42px;
    margin: -21px 0 0 -21px;
    border: 3px solid rgba(255, 255, 255, 0.22);
    border-top-color: var(--gold);
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .failure {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-6);
    text-align: center;
    background: rgba(0, 0, 0, 0.86);
  }

  .failure p {
    margin: 0;
    color: var(--ink-dim);
    max-width: 52ch;
  }

  .failure .detail {
    font-size: 11px;
    color: var(--ink-faint);
    max-width: 76ch;
    word-break: break-all;
  }

  .failure-actions {
    display: flex;
    gap: var(--space-3);
    margin-top: var(--space-2);
  }

  /* Over the video there is no gold to raise from, so no neumorphic shadow here. */
  .primary,
  .ghost {
    padding: 8px 16px;
    border-radius: var(--r-pill);
    font-weight: 600;
    box-shadow: none;
  }

  .primary {
    background: var(--accent);
    color: #fff;
  }

  .ghost {
    background: rgba(255, 255, 255, 0.14);
  }

  .skip-notice {
    position: absolute;
    left: var(--space-4);
    bottom: 84px;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 8px 14px;
    border-radius: var(--r-pill);
    font-size: 13px;
  }

  .skip-notice button {
    color: var(--gold);
    font-weight: 600;
  }

  /* A frosted-glass dock floating over the video (Vengeance UI's Music Player). It is
     the one place glass belongs: the picture behind it changes every frame, so
     neumorphic shadows would have no surface to sit on. The tint stays strong enough
     for gold text to read over a white frame. */
  .controls {
    position: absolute;
    left: var(--space-3);
    right: var(--space-3);
    bottom: var(--space-3);
    padding: 4px var(--space-3) 6px;
    border-radius: 18px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.08);
    transition: opacity 180ms var(--ease), transform 260ms var(--spring);
  }

  .controls.hidden {
    opacity: 0;
    transform: translateY(8px);
    pointer-events: none;
  }

  .stage:fullscreen .controls {
    left: var(--space-5);
    right: var(--space-5);
    bottom: var(--space-5);
  }

  .scrub {
    padding: 6px 0;
    cursor: pointer;
  }

  .track {
    position: relative;
    height: 5px;
    border-radius: var(--r-pill);
    background: rgba(217, 162, 58, 0.28);
  }

  .scrub:hover .track {
    height: 7px;
  }

  /* SponsorBlock segments sit under the played bar so both stay readable. */
  .segment {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 1px;
  }

  .played {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: var(--accent);
    border-radius: var(--r-pill);
    box-shadow: 0 0 10px rgba(36, 72, 255, 0.85);
  }

  .knob {
    position: absolute;
    top: 50%;
    width: 12px;
    height: 12px;
    margin-left: -6px;
    border-radius: 50%;
    background: var(--gold);
    transform: translateY(-50%) scale(0.6);
    transition: transform 120ms var(--ease);
  }

  .scrub:hover .knob {
    transform: translateY(-50%) scale(1);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-1);
  }

  .icon {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border-radius: var(--r-pill);
    color: var(--ink);
    transition: transform 160ms var(--spring);
  }

  .icon:active {
    transform: scale(0.9);
  }

  .icon:hover {
    background: rgba(255, 255, 255, 0.14);
  }

  .volume {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .volume input {
    width: 0;
    opacity: 0;
    transition: width 160ms var(--ease), opacity 160ms var(--ease);
    accent-color: var(--gold);
  }

  .volume:hover input,
  .volume input:focus-visible {
    width: 76px;
    opacity: 1;
  }

  .time {
    font-size: 12px;
    color: var(--ink);
  }

  /* A gap in the bar at each chapter start. */
  .chapter-tick {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: rgba(0, 0, 0, 0.7);
  }

  .chapter {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 12px;
    color: var(--ink-dim);
  }

  .spacer {
    flex: 1;
  }

  .quality {
    position: relative;
  }

  .text-btn {
    padding: 4px 10px;
    border-radius: var(--r-pill);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-dim);
  }

  .text-btn.on {
    color: var(--ink);
    background: rgba(217, 162, 58, 0.2);
  }

  .text-btn:hover {
    background: rgba(255, 255, 255, 0.14);
  }

  .menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    margin: 0;
    padding: 4px;
    list-style: none;
    min-width: 116px;
    max-height: 260px;
    overflow-y: auto;
    /* Inside the dock, which already blurs, so a stronger tint stands in for the blur. */
    background: rgba(30, 31, 36, 0.9);
    border: 1px solid var(--glass-edge);
    border-radius: 16px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  }

  .menu button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 10px;
    border-radius: 10px;
    font-size: 12px;
    color: var(--ink-dim);
  }

  .menu button:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--ink);
  }

  .menu button.on {
    color: var(--ink);
    background: rgba(217, 162, 58, 0.2);
  }
</style>

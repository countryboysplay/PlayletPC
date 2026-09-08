/**
 * index.ts - public surface of the playback layer.
 *
 * Typical wiring (framework-agnostic; call this from Svelte/React/vanilla):
 *
 *   import {
 *     PlayletPlayer, fetchVideo, configureHttp,
 *     SponsorBlockController, attachSponsorBlock, fetchSponsorSegments,
 *     isPlaybackError,
 *   } from './player';
 *   import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
 *
 *   configureHttp({ fetchImpl: tauriFetch as never });   // CORS-free, Rust-side
 *
 *   const player = new PlayletPlayer(videoEl, { proxyMode: 'auto', quality: 'auto' });
 *   const sb = new SponsorBlockController({ categories: { sponsor: 'skip' } });
 *   attachSponsorBlock(player, sb);
 *
 *   for (const instance of instanceList) {
 *     try {
 *       const video = await fetchVideo(instance, videoId);
 *       await player.load(video, { instance, captionLanguage: 'en' });
 *       sb.setSegments(await fetchSponsorSegments(videoId), video.lengthSeconds);
 *       break;
 *     } catch (e) {
 *       if (isPlaybackError(e) && e.instanceFailure) continue;  // next instance
 *       throw e;                                                // codec/video problem
 *     }
 *   }
 */

export { PlayletPlayer } from './player';
export type { PlayerEventMap, TimeUpdatePayload } from './player';

export {
  PlaybackError,
  isPlaybackError,
  toPlaybackError,
  fromShakaError,
  fromMediaError,
  codeForInstanceStatus,
} from './errors';
export type { PlaybackErrorCode, PlaybackErrorInit } from './errors';

export { TypedEmitter } from './emitter';
export type { Listener, Unsubscribe } from './emitter';

export {
  configureHttp,
  getFetchImpl,
  fetchVideo,
  fetchCaptionList,
  fetchCaptionAsBlobUrl,
  buildDashManifestUrl,
  proxifyMediaUrl,
  absoluteCaptionUrl,
  normalizeInstance,
} from './invidious';
export type { FetchLike, RequestOptions } from './invidious';

export { buildSourceCandidates, pickBestMuxed, maxAdaptiveHeight, parseHeight, isLive } from './sources';
export type { BuildSourcesOptions } from './sources';

export { loadShaka, RequestType } from './shaka';
export { installFetchSchemePlugin } from './tauri-net';
export type { SchemePluginOptions } from './tauri-net';
export type { ShakaNamespace, ShakaPlayerInstance, ShakaTrack } from './shaka';

export {
  SponsorBlockController,
  attachSponsorBlock,
  mergeSegments,
  fetchSponsorSegments,
  sha256HashPrefix,
  DEFAULT_SPONSORBLOCK_CONFIG,
} from './sponsorblock';
export type {
  SponsorSegment,
  SponsorCategory,
  SponsorActionType,
  CategoryBehavior,
  SponsorBlockConfig,
  SponsorBlockEventMap,
  SponsorBlockHost,
  NormalizedSegment,
  SkipEvent,
  NoticeEvent,
} from './sponsorblock';

export type {
  InvidiousVideo,
  InvidiousFormatStream,
  InvidiousAdaptiveFormat,
  InvidiousCaption,
  LoadOptions,
  ResolvedLoadOptions,
  PlayerState,
  QualityOption,
  QualitySelection,
  SourceCandidate,
  SourceKind,
  TextTrackOption,
  ProxyMode,
  CodecPreference,
} from './types';

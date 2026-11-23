import * as stylex from '@stylexjs/stylex';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  FileWarning,
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, focus, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import type { SessionFileErrorActions } from '@/lib/session-file-actions';
import { SessionFileNoticeCard } from '../sessions/session-file-error-state';

export const VIDEO_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const SEEK_STEP_SECONDS = 5;

export function formatVideoTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const paddedSecs = String(secs).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSecs}`;
  }
  return `${minutes}:${paddedSecs}`;
}

export interface VideoPlayerProps {
  readonly src: string;
  readonly active?: boolean;
  readonly title?: string;
  readonly fileActions?: SessionFileErrorActions;
  readonly onDownload?: () => void;
  readonly isDownloading?: boolean;
  readonly className?: string;
}

const styles = stylex.create({
  glyph: { width: space[4], height: space[4] },
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minHeight: 0,
    minWidth: 0,
    backgroundColor: colors.background,
    outline: 'none',
  },
  stage: {
    position: 'relative',
    flex: 1,
    minHeight: '160px',
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: '#09090b',
  },
  video: {
    width: '100%',
    height: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    cursor: 'pointer',
    display: 'block',
  },
  bufferingOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    backgroundColor: 'rgba(9, 9, 11, 0.35)',
    color: '#fafafa',
  },
  controls: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    rowGap: space[1.5],
    paddingBlock: space[2],
    paddingInline: space[3],
    backgroundColor: colors.secondaryBackground,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
  },
  scrubberRow: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    height: '18px',
    width: '100%',
  },
  track: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: '4px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: `color-mix(in srgb, ${colors.label} 16%, transparent)`,
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  bufferedFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: `color-mix(in srgb, ${colors.label} 24%, transparent)`,
  },
  playedFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.accent,
  },
  rangeInput: {
    position: 'relative',
    width: '100%',
    height: '18px',
    margin: 0,
    padding: 0,
    backgroundColor: 'transparent',
    accentColor: colors.accent,
    cursor: { default: 'pointer', ':disabled': 'not-allowed' },
    opacity: { default: 1, ':disabled': 0.45 },
    outline: 'none',
    boxShadow: {
      default: 'none',
      ':focus-visible': `0 0 0 ${focus.ringWidth} ${colors.accent}`,
    },
    borderRadius: radius.mini,
  },
  actionRow: {
    display: 'flex',
    alignItems: 'center',
    columnGap: space[1.5],
    minWidth: 0,
  },
  timeLabel: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  },
  spacer: {
    flex: 1,
    minWidth: space[1],
  },
  volumeGroup: {
    display: 'flex',
    alignItems: 'center',
    columnGap: space[1],
  },
  volumeSlider: {
    width: '64px',
    height: '16px',
    margin: 0,
    accentColor: colors.accent,
    cursor: 'pointer',
  },
  rateLabel: {
    fontVariantNumeric: 'tabular-nums',
  },
  errorState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    rowGap: space[3],
    flex: 1,
    padding: space[6],
    textAlign: 'center',
    color: colors.secondaryLabel,
  },
  errorTitle: {
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    color: colors.label,
  },
  errorDescription: {
    maxWidth: '24rem',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
});

type VideoErrorKind = 'unsupported' | 'network' | 'generic';

function classifyMediaError(code: number | undefined): VideoErrorKind {
  if (code === 3 || code === 4) return 'unsupported';
  if (code === 2) return 'network';
  return 'generic';
}

export function VideoPlayer({
  src,
  active = true,
  title,
  fileActions,
  onDownload,
  isDownloading = false,
  className,
}: VideoPlayerProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);
  const [canSeek, setCanSeek] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [errorKind, setErrorKind] = useState<VideoErrorKind | null>(null);

  const fullscreenSupported =
    typeof document !== 'undefined' && Boolean(document.fullscreenEnabled);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    // Restore after React StrictMode replays setup/cleanup on the same element.
    video.setAttribute('src', src);
    const pauseWhenHidden = () => {
      if (document.hidden) video.pause();
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      document.removeEventListener('visibilitychange', pauseWhenHidden);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [errorKind, src]);

  useEffect(() => {
    if (!active) {
      videoRef.current?.pause();
    }
  }, [active]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === rootRef.current);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const syncSeekability = useCallback((video: HTMLVideoElement) => {
    const nextDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    setMediaDuration(nextDuration);
    if (nextDuration <= 0) {
      setCanSeek(false);
      return;
    }
    if (video.seekable.length > 0) {
      const seekableEnd = video.seekable.end(video.seekable.length - 1);
      setCanSeek(Number.isFinite(seekableEnd) && seekableEnd > 0);
    } else {
      setCanSeek(true);
    }
  }, []);

  const syncBuffered = useCallback((video: HTMLVideoElement) => {
    if (video.buffered.length > 0) {
      setBufferedEnd(video.buffered.end(video.buffered.length - 1));
    }
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      void Promise.resolve(video.play()).catch(() => {
        setIsPlaying(false);
      });
    } else {
      video.pause();
    }
  }, []);

  const seekTo = useCallback(
    (nextTime: number) => {
      const video = videoRef.current;
      if (!video || !canSeek) return;
      const limit =
        Number.isFinite(video.duration) && video.duration > 0 ? video.duration : mediaDuration;
      const clamped = Math.max(0, limit > 0 ? Math.min(nextTime, limit) : nextTime);
      video.currentTime = clamped;
      setCurrentTime(clamped);
    },
    [canSeek, mediaDuration]
  );

  const handleScrubChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextTime = Number(event.target.value);
      if (!Number.isFinite(nextTime)) return;
      setScrubTime(nextTime);
      seekTo(nextTime);
    },
    [seekTo]
  );

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !video.muted;
    video.muted = nextMuted;
    setMuted(nextMuted);
  }, []);

  const handleVolumeChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    const nextVolume = Number(event.target.value);
    if (!video || !Number.isFinite(nextVolume)) return;
    const clamped = Math.max(0, Math.min(1, nextVolume));
    video.volume = clamped;
    video.muted = clamped === 0;
    setVolume(clamped);
    setMuted(clamped === 0);
  }, []);

  const selectPlaybackRate = useCallback((nextRate: number) => {
    if (!Number.isFinite(nextRate) || nextRate <= 0) return;
    const video = videoRef.current;
    if (video) {
      video.defaultPlaybackRate = nextRate;
      video.playbackRate = nextRate;
    }
    setPlaybackRate(nextRate);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current;
    if (!root || !fullscreenSupported) return;
    if (document.fullscreenElement === root) {
      void document.exitFullscreen?.().catch(() => undefined);
    } else {
      void root.requestFullscreen?.().catch(() => undefined);
    }
  }, [fullscreenSupported]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type !== 'range') return;
      if (event.key === ' ' || event.key === 'k' || event.key === 'K') {
        if (target instanceof HTMLButtonElement) return;
        event.preventDefault();
        togglePlay();
      } else if (event.key === 'ArrowLeft') {
        if (target instanceof HTMLInputElement) return;
        event.preventDefault();
        seekTo(currentTime - SEEK_STEP_SECONDS);
      } else if (event.key === 'ArrowRight') {
        if (target instanceof HTMLInputElement) return;
        event.preventDefault();
        seekTo(currentTime + SEEK_STEP_SECONDS);
      } else if (event.key === 'm' || event.key === 'M') {
        event.preventDefault();
        toggleMute();
      } else if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        toggleFullscreen();
      }
    },
    [currentTime, seekTo, toggleFullscreen, toggleMute, togglePlay]
  );

  if (errorKind) {
    const description =
      errorKind === 'unsupported'
        ? t(
            'sessions.videoPreview.unsupportedMessage',
            'This video format or codec is not supported on this device. Download the file to open it in a system player.'
          )
        : t(
            'sessions.videoPreview.failedMessage',
            'This video could not be played. Its format may not be supported on this device, or the file could not be read.'
          );

    if (fileActions) {
      return (
        <SessionFileNoticeCard
          presentation={{
            title: t('sessions.videoPreview.failedTitle', 'Video unavailable'),
            description,
          }}
          fileActions={fileActions}
        />
      );
    }

    return (
      <div {...stylex.props(styles.errorState)}>
        <FileWarning size={24} aria-hidden="true" />
        <div {...stylex.props(styles.errorTitle)}>
          {t('sessions.videoPreview.failedTitle', 'Video unavailable')}
        </div>
        <div {...stylex.props(styles.errorDescription)}>{description}</div>
        {onDownload ? (
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={onDownload}
            disabled={isDownloading}
          >
            {isDownloading ? <Spinner size="small" /> : <Download {...stylex.props(styles.glyph)} />}
            {t('sessions.fileDownload', 'Download')}
          </Button>
        ) : null}
      </div>
    );
  }

  const displayTime = isScrubbing ? scrubTime : currentTime;
  const playedPercent = mediaDuration > 0 ? Math.min(100, (displayTime / mediaDuration) * 100) : 0;
  const bufferedPercent =
    mediaDuration > 0 ? Math.min(100, (bufferedEnd / mediaDuration) * 100) : 0;

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      data-testid="video-player"
      className={[stylex.props(styles.root).className, className].filter(Boolean).join(' ')}
    >
      <div {...stylex.props(styles.stage)}>
        <video
          ref={videoRef}
          {...stylex.props(styles.video)}
          src={src}
          playsInline
          preload="metadata"
          aria-label={t('sessions.videoPreview.label', 'Video preview')}
          title={title}
          onClick={togglePlay}
          onLoadedMetadata={(event) => {
            event.currentTarget.defaultPlaybackRate = playbackRate;
            event.currentTarget.playbackRate = playbackRate;
            syncSeekability(event.currentTarget);
            syncBuffered(event.currentTarget);
          }}
          onRateChange={(event) => {
            const nextRate = event.currentTarget.playbackRate;
            if (Number.isFinite(nextRate) && nextRate > 0) {
              setPlaybackRate(nextRate);
            }
          }}
          onDurationChange={(event) => syncSeekability(event.currentTarget)}
          onTimeUpdate={(event) => {
            if (!isScrubbing) {
              setCurrentTime(event.currentTarget.currentTime);
            }
          }}
          onProgress={(event) => syncBuffered(event.currentTarget)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => {
            setIsPlaying(false);
            setIsBuffering(false);
          }}
          onEnded={() => {
            setIsPlaying(false);
            setIsBuffering(false);
          }}
          onWaiting={() => setIsBuffering(true)}
          onCanPlay={() => setIsBuffering(false)}
          onPlaying={() => setIsBuffering(false)}
          onSeeked={(event) => {
            setIsBuffering(false);
            setCurrentTime(event.currentTarget.currentTime);
          }}
          onVolumeChange={(event) => {
            setMuted(event.currentTarget.muted);
            setVolume(event.currentTarget.volume);
          }}
          onError={(event) => {
            setIsPlaying(false);
            setIsBuffering(false);
            setErrorKind(classifyMediaError(event.currentTarget.error?.code));
          }}
        />
        {isBuffering ? (
          <div {...stylex.props(styles.bufferingOverlay)} role="status">
            <Spinner diameter="20px" />
          </div>
        ) : null}
      </div>

      <div {...stylex.props(styles.controls)}>
        <div {...stylex.props(styles.scrubberRow)}>
          <div {...stylex.props(styles.track)} aria-hidden="true">
            <div {...stylex.props(styles.bufferedFill)} style={{ width: `${bufferedPercent}%` }} />
            <div {...stylex.props(styles.playedFill)} style={{ width: `${playedPercent}%` }} />
          </div>
          <input
            type="range"
            min={0}
            max={mediaDuration > 0 ? mediaDuration : 0}
            step="any"
            value={mediaDuration > 0 ? Math.min(displayTime, mediaDuration) : 0}
            disabled={!canSeek || mediaDuration <= 0}
            aria-label={t('sessions.videoPreview.seek', 'Seek')}
            aria-valuetext={`${formatVideoTime(displayTime)} / ${formatVideoTime(mediaDuration)}`}
            onPointerDown={() => {
              setIsScrubbing(true);
              setScrubTime(currentTime);
            }}
            onPointerUp={() => setIsScrubbing(false)}
            onPointerCancel={() => setIsScrubbing(false)}
            onBlur={() => setIsScrubbing(false)}
            onChange={handleScrubChange}
            {...stylex.props(styles.rangeInput)}
          />
        </div>

        <div {...stylex.props(styles.actionRow)}>
          <Button
            type="button"
            variant="ghost"
            size="small"
            icon
            onClick={togglePlay}
            aria-label={
              isPlaying
                ? t('sessions.videoPreview.pause', 'Pause')
                : t('sessions.videoPreview.play', 'Play')
            }
          >
            {isPlaying ? <Pause {...stylex.props(styles.glyph)} /> : <Play {...stylex.props(styles.glyph)} />}
          </Button>

          <span {...stylex.props(styles.timeLabel)} data-testid="video-player-time">
            {formatVideoTime(displayTime)} / {formatVideoTime(mediaDuration)}
          </span>

          <div {...stylex.props(styles.spacer)} />

          <div {...stylex.props(styles.volumeGroup)}>
            <Button
              type="button"
              variant="ghost"
              size="small"
              icon
              onClick={toggleMute}
              aria-label={
                muted || volume === 0
                  ? t('sessions.videoPreview.unmute', 'Unmute')
                  : t('sessions.videoPreview.mute', 'Mute')
              }
            >
              {muted || volume === 0 ? (
                <VolumeX {...stylex.props(styles.glyph)} />
              ) : (
                <Volume2 {...stylex.props(styles.glyph)} />
              )}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              aria-label={t('sessions.videoPreview.volume', 'Volume')}
              onChange={handleVolumeChange}
              {...stylex.props(styles.volumeSlider)}
            />
          </div>

          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  aria-label={t(
                    'sessions.videoPreview.playbackSpeedCurrent',
                    'Playback speed: {{rate}}×',
                    { rate: playbackRate }
                  )}
                />
              }
            >
              <span {...stylex.props(styles.rateLabel)}>{playbackRate}×</span>
            </Menu.Trigger>
            <Menu.Content
              side="top"
              align="end"
              width="compact"
              container={isFullscreen ? rootRef : undefined}
            >
              <Menu.RadioGroup
                aria-label={t('sessions.videoPreview.playbackSpeed', 'Playback speed')}
                value={String(playbackRate)}
                onValueChange={(value) => selectPlaybackRate(Number(value))}
              >
                {VIDEO_PLAYBACK_RATES.map((rate) => (
                  <Menu.RadioItem key={rate} value={String(rate)} indicator="check" closeOnClick>
                    <span {...stylex.props(styles.rateLabel)}>{rate}×</span>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Content>
          </Menu.Root>

          {fullscreenSupported ? (
            <Button
              type="button"
              variant="ghost"
              size="small"
              icon
              onClick={toggleFullscreen}
              aria-label={
                isFullscreen
                  ? t('sessions.videoPreview.exitFullscreen', 'Exit fullscreen')
                  : t('sessions.videoPreview.fullscreen', 'Fullscreen')
              }
            >
              {isFullscreen ? <Minimize {...stylex.props(styles.glyph)} /> : <Maximize {...stylex.props(styles.glyph)} />}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

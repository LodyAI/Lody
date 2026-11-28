import { defineClientPlugin } from "@lody/plugin-sdk/client";

type SoundConfig = {
  readonly pack: string;
  readonly volume: number;
  readonly playOnSend: boolean;
};

export default defineClientPlugin((lody) => {
  const activeClips = new Set<HTMLAudioElement>();

  const disposeAll = () => {
    for (const clip of activeClips) {
      clip.pause();
    }
    activeClips.clear();
  };
  lody.signal.addEventListener("abort", disposeAll, { once: true });

  const playCue = async (
    cue: "send" | "complete" | "question",
    volume: number,
  ) => {
    if (lody.signal.aborted) return;
    const cfg = lody.config.get<SoundConfig>();
    const clip = new Audio(lody.assets.url(`./assets/${cfg.pack}-${cue}.mp3`));
    clip.volume = volume;
    activeClips.add(clip);
    clip.addEventListener("ended", () => activeClips.delete(clip), {
      once: true,
    });
    await clip.play();
  };

  const offSend = lody.events.on("ui.message.submitted", async () => {
    const cfg = lody.config.get<SoundConfig>();
    if (!cfg.playOnSend) return;
    await playCue("send", cfg.volume);
  });

  const offTurn = lody.events.on("session.turn.completed", async (event) => {
    if (event.stopReason === "cancelled") return;
    const cfg = lody.config.get<SoundConfig>();
    await playCue("complete", cfg.volume);
  });

  const offWait = lody.events.on("session.waiting_input", async () => {
    const cfg = lody.config.get<SoundConfig>();
    await playCue("question", cfg.volume);
  });

  return () => {
    disposeAll();
    offSend();
    offTurn();
    offWait();
  };
});

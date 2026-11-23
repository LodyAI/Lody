import { defineClientPlugin } from "@lody/plugin-sdk/client";

type SoundConfig = {
  readonly pack: string;
  readonly volume: number;
  readonly playOnSend: boolean;
};

export default defineClientPlugin((lody) => {
  const offSend = lody.events.on("ui.message.submitted", async () => {
    const cfg = lody.config.get<SoundConfig>();
    if (!cfg.playOnSend) return;
    await lody.audio.play(`./assets/${cfg.pack}-send.mp3`, {
      volume: cfg.volume,
    });
  });

  const offTurn = lody.events.on("session.turn.completed", async (event) => {
    if (event.stopReason === "cancelled") return;
    const cfg = lody.config.get<SoundConfig>();
    await lody.audio.play(`./assets/${cfg.pack}-complete.mp3`, {
      volume: cfg.volume,
    });
  });

  const offWait = lody.events.on("session.waiting_input", async () => {
    const cfg = lody.config.get<SoundConfig>();
    await lody.audio.play(`./assets/${cfg.pack}-question.mp3`, {
      volume: cfg.volume,
    });
  });

  return () => {
    offSend();
    offTurn();
    offWait();
  };
});

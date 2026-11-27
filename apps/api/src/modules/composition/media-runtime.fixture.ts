export const mediaProbeEnv = {
  ALIGNMENT_PYTHON_PATH: "/local/python",
  FFMPEG_PATH: "/local/ffmpeg",
  FFPROBE_PATH: "/local/ffprobe",
};
export const readyProbeOutput = (binary: string, args: string[] = []): Buffer => {
  if (binary === mediaProbeEnv.FFPROBE_PATH && args.includes("-show_format"))
    return Buffer.from(
      JSON.stringify({
        format: { format_name: "mov,mp4" },
        streams: [
          { codec_type: "video", codec_name: "h264", width: 1080, height: 1920 },
          { codec_type: "audio", codec_name: "aac" },
        ],
      }),
    );
  if (binary === mediaProbeEnv.FFMPEG_PATH)
    return Buffer.from(" ... subtitles  V->V   Render text subtitles onto input video\n");
  if (binary === mediaProbeEnv.FFPROBE_PATH) return Buffer.from("ffprobe version fixture");
  if (binary === mediaProbeEnv.ALIGNMENT_PYTHON_PATH) return Buffer.from('{"eng":"en"}');
  if (binary === "espeak") return Buffer.concat([Buffer.from("RIFF1234WAVE"), Buffer.alloc(100)]);
  return Buffer.alloc(0);
};

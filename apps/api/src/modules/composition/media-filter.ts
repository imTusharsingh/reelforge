export type AssemblyClip = { path: string; seconds: number; audio: boolean; fade: boolean };
/** Pad only transition tails so crossfades do not shorten the narration timeline. */
export function assemblyArguments(
  clips: readonly AssemblyClip[],
  narration: string,
  music: string,
  captions: string,
  output: string,
  seconds: number,
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    ...clips.flatMap((clip) => ["-i", clip.path]),
    "-i",
    narration,
    "-i",
    music,
    ...assemblyOutputArguments(clips, captions, output, seconds),
  ];
}

export function assemblyOutputArguments(
  clips: readonly AssemblyClip[],
  captions: string,
  output: string,
  seconds: number,
): string[] {
  const filters = assemblyFilters(clips, captions, seconds);
  return [
    "-filter_complex_threads",
    "1",
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[video]",
    "-map",
    "[audio]",
    "-t",
    String(seconds),
    "-r",
    "24",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    output,
  ];
}

function assemblyFilters(
  clips: readonly AssemblyClip[],
  captions: string,
  seconds: number,
): string[] {
  const filters: string[] = [];
  clips.forEach((clip, index) => {
    const pad = clip.fade && index < clips.length - 1 ? ",tpad=stop_mode=clone:stop=6" : "";
    filters.push(
      `[${index}:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setsar=1,fps=24,settb=AVTB,format=yuv420p,trim=duration=${clip.seconds},setpts=PTS-STARTPTS,fps=24,settb=AVTB${pad}[v${index}]`,
    );
    filters.push(
      clip.audio
        ? `[${index}:a]atrim=duration=${clip.seconds},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${clip.seconds},volume=-18dB[a${index}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${clip.seconds}[a${index}]`,
    );
  });
  let video = "v0",
    elapsed = clips[0]!.seconds;
  for (let index = 1; index < clips.length; index++) {
    const next = `mixv${index}`;
    filters.push(
      clips[index - 1]!.fade
        ? `[${video}][v${index}]xfade=transition=fade:duration=0.25:offset=${elapsed},fps=24,settb=AVTB[${next}]`
        : `[${video}][v${index}]concat=n=2:v=1:a=0,fps=24,settb=AVTB[${next}]`,
    );
    video = next;
    elapsed += clips[index]!.seconds;
  }
  filters.push(
    clips.map((_, index) => `[a${index}]`).join("") + `concat=n=${clips.length}:v=0:a=1[ambience]`,
  );
  filters.push(
    `[${clips.length}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${seconds},asplit=2[voice][duckkey]`,
  );
  filters.push(
    `[${clips.length + 1}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${seconds},volume=0.15[music]`,
  );
  filters.push(
    "[music][duckkey]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=250[ducked]",
  );
  filters.push(
    "[voice][ambience][ducked]amix=inputs=3:normalize=0,loudnorm=I=-14:TP=-1:LRA=11[audio]",
  );
  const escaped = captions.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
  filters.push(`[${video}]subtitles=filename='${escaped}'[video]`);
  return filters;
}

import type { JSX } from "react";
import type { BriefInput } from "../../../../packages/contracts/src/channel-brief";
import { narratorPaceMessage } from "../../../../packages/contracts/src/narrator-voice";
import { Field } from "../../components/ui/primitives";

type Props = { value: BriefInput; onChange: (value: BriefInput) => void };
export function ProductionFields(props: Props): JSX.Element {
  return (
    <>
      <VoiceFields {...props} />
      <FormatFields {...props} />
      <ProfileFields {...props} />
    </>
  );
}
function VoiceFields({ value, onChange }: Props): JSX.Element {
  const voice = value.narratorVoice;
  const setVoice = (voiceId: string, pace: number): void =>
    onChange({
      ...value,
      narratorVoice: voiceId
        ? {
            providerId: voice?.providerId ?? "gemini",
            voiceId,
            pace,
            language: value.languages.narration,
          }
        : null,
    });
  return (
    <fieldset>
      <legend>Narration</legend>
      <Field
        id="narrator-voice"
        label="Narrator voice"
        hint="Enter a Gemini voice name, such as Kore or Puck."
        value={voice?.voiceId ?? ""}
        onChange={(e) => setVoice(e.target.value, voice?.pace ?? 1)}
      />
      {voice && (
        <Field
          id="narrator-pace"
          label="Speaking speed"
          type="number"
          step="any"
          min={0.5}
          max={2}
          required
          value={voice.pace}
          error={voice.pace < 0.5 || voice.pace > 2 ? narratorPaceMessage : ""}
          onChange={(e) => setVoice(voice.voiceId, Number(e.target.value))}
        />
      )}
    </fieldset>
  );
}
function FormatFields({ value, onChange }: Props): JSX.Element {
  return (
    <fieldset>
      <legend>Format mix</legend>
      <p>Enter the share for each format. Shares must add up to 1.</p>
      {value.formatMix.map((item) => (
        <Field
          key={item.formatKey}
          id={`format-${item.formatKey}`}
          label={item.formatKey}
          type="number"
          step="any"
          min={0}
          max={1}
          value={item.weight}
          onChange={(e) =>
            onChange({
              ...value,
              formatMix: value.formatMix.map((i) =>
                i === item ? { ...item, weight: Number(e.target.value) } : i,
              ),
            })
          }
        />
      ))}
    </fieldset>
  );
}
function ProfileFields({ value, onChange }: Props): JSX.Element {
  return (
    <fieldset>
      <legend>Render profile</legend>
      <Field
        id="profile-id"
        label="Profile name"
        required
        value={value.renderProfile.id}
        onChange={(e) =>
          onChange({ ...value, renderProfile: { ...value.renderProfile, id: e.target.value } })
        }
      />
      {(["width", "height", "fps"] as const).map((key) => (
        <Field
          key={key}
          id={`profile-${key}`}
          label={
            { width: "Width (pixels)", height: "Height (pixels)", fps: "Frames per second" }[key]
          }
          type="number"
          min={1}
          required
          value={value.renderProfile[key]}
          onChange={(e) =>
            onChange({
              ...value,
              renderProfile: { ...value.renderProfile, [key]: Number(e.target.value) },
            })
          }
        />
      ))}
    </fieldset>
  );
}

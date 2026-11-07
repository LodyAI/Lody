import { useRef, useState, type ComponentProps } from 'react';
import { CombinedMentionTextarea } from '@/components/mentions/combined-mention-textarea';
import { getComposerMentionChip } from '@/components/mentions/mention-chips';
import { useMentionPromptExpansion } from '@/components/mentions/mention-expansion';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import type { SkillMentionAgent } from '@/components/mentions/mention-skill-source';
import type { Mention } from '@/ui/mention/index';
import { ScheduleForm } from './schedule-view';

/** Schedules store executable text, so freeze mention identities at save time. */
export function ScheduleMentionForm({
  mentionSource,
  skillAgent,
  onSave,
  ...props
}: Omit<ComponentProps<typeof ScheduleForm>, 'renderPrompt'> & {
  mentionSource?: MentionProjectSource;
  skillAgent?: SkillMentionAgent;
}) {
  const [prompt, setPrompt] = useState(props.initial.prompt);
  const ranges = useRef<Mention[]>([]);
  const { expand } = useMentionPromptExpansion({
    source: mentionSource,
    skillAgent,
    promptValue: prompt,
  });
  return (
    <ScheduleForm
      {...props}
      renderPrompt={({ onValueChange, ref, ...field }) => (
        <CombinedMentionTextarea
          {...field}
          ref={ref}
          label={field['aria-label']}
          appearance="bare"
          resize="none"
          mentionSource={mentionSource}
          skillAgent={skillAgent}
          menuSide="bottom"
          menuMobileDocked={false}
          getMentionChip={getComposerMentionChip}
          onMentionRangesChange={(next) => {
            ranges.current = next;
          }}
          onValueChange={(value) => {
            setPrompt(value);
            onValueChange(value);
          }}
        />
      )}
      onSave={(value) =>
        onSave({ ...value, prompt: expand({ text: value.prompt, mentions: ranges.current }).text })
      }
    />
  );
}

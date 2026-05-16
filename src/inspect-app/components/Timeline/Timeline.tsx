import { ScrollArea, Group, Text } from '@mantine/core';
import { useViewContext } from '../../ViewContext';
import { Section } from '../../primitives/Section';
import { StageChip } from './StageChip';

export function Timeline() {
  const view = useViewContext();
  const spawn = view.coordinator.spawn;
  const spawnDeclined = spawn?.declined ?? false;
  return (
    <Section title="Pipeline timeline">
      <ScrollArea type="auto" offsetScrollbars>
        <Group gap="sm" wrap="nowrap" align="center" py="sm">
          {view.stages.map((stage) => (
            <StageChip key={stage.key} stage={stage} />
          ))}
        </Group>
      </ScrollArea>
      {spawnDeclined && spawn?.reason ? (
        <Text size="xs" c="dimmed">
          spawn declined — {spawn.reason}
        </Text>
      ) : null}
    </Section>
  );
}

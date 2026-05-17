import { Alert, Code, Stack, Text } from '@mantine/core';
import { useViewContext } from '../ViewContext';

export function LastFailureBanner() {
  const view = useViewContext();
  const failure = view.last_failure;
  if (!failure) return null;
  const where = failure.territory_id
    ? `WG: ${failure.territory_id}${failure.sub_stage ? ' / ' + failure.sub_stage : ''}`
    : (failure.stage ?? '');
  return (
    <Alert color="red" title={`interrupted: ${failure.reason}`}>
      <Stack gap={4}>
        <Text size="sm">
          {where}{failure.at ? ' · ' + failure.at : ''}
        </Text>
        <Text size="sm">
          resume with: <Code>msv run {view.id}</Code>
        </Text>
      </Stack>
    </Alert>
  );
}

import { Component, type ReactNode } from 'react';
import { Alert, Center, Stack, Text } from '@mantine/core';

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error('inspector error boundary caught:', error);
  }

  render() {
    if (this.state.error) {
      return (
        <Center mih="100vh" p="xl">
          <Stack gap="sm" style={{ maxWidth: 560 }}>
            <Alert color="red" variant="light" title="Inspector failed to load">
              <Text size="sm">{this.state.error.message}</Text>
              <Text size="xs" c="dimmed" mt="xs">
                Re-run <code>msv inspect &lt;id&gt;</code> to regenerate <code>inspect-view.json</code>,
                or check the CLI output for a view-build error.
              </Text>
            </Alert>
          </Stack>
        </Center>
      );
    }
    return this.props.children;
  }
}

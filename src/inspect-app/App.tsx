import { Suspense } from 'react';
import { AppShell, Loader, Center, Stack, Anchor, Text } from '@mantine/core';
import { ViewProvider } from './ViewContext';
import { useView } from './hooks/useView';
import { useAnchorScroll } from './utils/anchorScroll';
import { ErrorBoundary } from './ErrorBoundary';
import { Header } from './components/Header/Header';
import { Timeline } from './components/Timeline/Timeline';
import { Discovery } from './components/Discovery/Discovery';
import { Coordinator } from './components/Coordinator/Coordinator';
import { DebateSection } from './components/Debate/DebateSection';
import { Forum } from './components/Forum/Forum';
import { Synthesis } from './components/Synthesis/Synthesis';
import { tokens } from './theme/tokens';

const NAV_LINKS = [
  { id: 'header', label: 'Overview' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'discovery', label: 'Discovery' },
  { id: 'coordinator', label: 'Coordinator' },
  { id: 'debates', label: 'Debates' },
  { id: 'forum', label: 'Forum' },
  { id: 'synthesis', label: 'Synthesis' },
];

function Navbar() {
  return (
    <Stack gap="xs" p="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        Sections
      </Text>
      {NAV_LINKS.map((link) => (
        <Anchor key={link.id} href={`#${link.id}`} size="sm">
          {link.label}
        </Anchor>
      ))}
    </Stack>
  );
}

function Body() {
  const view = useView();
  useAnchorScroll();
  return (
    <ViewProvider view={view}>
      <AppShell navbar={{ width: tokens.navbarWidth, breakpoint: 'sm' }} padding="lg">
        <AppShell.Navbar>
          <Navbar />
        </AppShell.Navbar>
        <AppShell.Main>
          <Stack gap={tokens.sectionGap}>
            <section id="header"><Header /></section>
            <section id="timeline"><Timeline /></section>
            <section id="discovery"><Discovery /></section>
            <section id="coordinator"><Coordinator /></section>
            <section id="debates"><DebateSection /></section>
            <section id="forum"><Forum /></section>
            <section id="synthesis"><Synthesis /></section>
          </Stack>
        </AppShell.Main>
      </AppShell>
    </ViewProvider>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <Center mih="100vh">
            <Loader />
          </Center>
        }
      >
        <Body />
      </Suspense>
    </ErrorBoundary>
  );
}

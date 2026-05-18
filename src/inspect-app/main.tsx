import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import '@mantine/core/styles.css';
import './theme/animations.css';
import { Global, css } from '@emotion/react';
import { App } from './App';
import { tokens } from './theme/tokens';

const theme = createTheme({
  primaryColor: 'blue',
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
});

const globalStyles = css`
  html,
  body,
  #root {
    height: 100%;
    margin: 0;
  }

  body {
    background: #fff;
    color: #1f2937;
  }

  [data-pulse='true'] {
    animation: msv-pulse ${tokens.highlightPulseMs}ms ease-out;
  }

  @keyframes msv-pulse {
    0% {
      background-color: rgba(59, 130, 246, 0.18);
    }
    100% {
      background-color: transparent;
    }
  }
`;

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <Global styles={globalStyles} />
      <App />
    </MantineProvider>
  </StrictMode>,
);

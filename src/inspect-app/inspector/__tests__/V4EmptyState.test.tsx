import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { V4EmptyState } from '../V4EmptyState';

describe('V4EmptyState', () => {
  it('renders the v5-only message', () => {
    render(<MantineProvider><V4EmptyState id="abc-123" /></MantineProvider>);
    expect(screen.getByText(/v5 investigations only/i)).toBeInTheDocument();
    expect(screen.getByText(/abc-123/)).toBeInTheDocument();
  });

  it('does not mount any React Flow canvas', () => {
    const { container } = render(<MantineProvider><V4EmptyState id="abc" /></MantineProvider>);
    expect(container.querySelector('.react-flow')).toBeNull();
  });
});
